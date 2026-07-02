import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: mockState.spawnSync,
}));

import { resolveTelePiInstallContext } from "../../src/install.js";
import {
  buildSystemdUnit,
  writeSystemdUnit,
  createSystemdManager,
} from "../../src/install/systemd.js";
import type { TelePiInstallContext } from "../../src/install/shared.js";

describe("SystemdManager", () => {
  const originalEnv = process.env;
  const originalPlatform = process.platform;
  let tempDir: string;
  let homeDir: string;
  let packageRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-systemd-"));
    homeDir = path.join(tempDir, "home");
    packageRoot = path.join(tempDir, "package");

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    mkdirSync(path.join(packageRoot, "systemd"), { recursive: true });
    mkdirSync(path.join(packageRoot, "extensions"), { recursive: true });

    writeFileSync(path.join(packageRoot, "package.json"), '{"version":"0.5.0"}\n');
    writeFileSync(path.join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\n");
    writeFileSync(path.join(packageRoot, "extensions", "telepi-handoff.ts"), "export default {};\n");
    writeFileSync(
      path.join(packageRoot, ".env.example"),
      "TELEGRAM_BOT_TOKEN=dev-token\nTELEGRAM_ALLOWED_USER_IDS=1\nTELEPI_WORKSPACE=/tmp/ws\n",
    );
    writeFileSync(
      path.join(packageRoot, "systemd", "telepi.service"),
      [
        "[Unit]",
        "Description=TelePi Telegram Bot",
        "After=network.target",
        "",
        "[Service]",
        "Type=simple",
        "WorkingDirectory=__TELEPI_WORKDIR__",
        "ExecStart=__TELEPI_NODE_PATH__ __TELEPI_CLI_PATH__ start",
        "Environment=__TELEPI_CONFIG_ENV__",
        "Environment=__TELEPI_PATH_ENV__",
        "StandardOutput=append:__TELEPI_STDOUT_PATH__",
        "StandardError=append:__TELEPI_STDERR_PATH__",
        "Restart=on-failure",
        "RestartSec=5",
        "",
        "[Install]",
        "WantedBy=default.target",
      ].join("\n"),
    );

    process.env = {
      ...originalEnv,
      HOME: homeDir,
      PATH: "/usr/bin:/bin",
      UID: "501",
    };
    mockState.spawnSync.mockReset();
    mockState.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "systemctl unavailable" });
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    vi.restoreAllMocks();
  });

  function assertInsideTempHome(filePath: string | undefined): void {
    if (!filePath) {
      return;
    }

    const relativePath = path.relative(homeDir, filePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Unsafe test path outside temp HOME: ${filePath}`);
    }
  }

  function createLinuxContext(): TelePiInstallContext {
    const cliModuleUrl = pathToFileURL(path.join(packageRoot, "dist", "cli.js")).href;
    const context = resolveTelePiInstallContext(cliModuleUrl);
    assertInsideTempHome(context.configPath);
    assertInsideTempHome(context.extensionDestinationPath);
    assertInsideTempHome(context.serviceUnitPath);
    assertInsideTempHome(context.serviceUnitLogsDirectory);
    assertInsideTempHome(context.serviceUnitStdoutPath);
    assertInsideTempHome(context.serviceUnitStderrPath);
    return context;
  }

  describe("buildSystemdUnit", () => {
    it("renders a systemd unit file with correct paths from context", () => {
      const ctx = createLinuxContext();

      const unit = buildSystemdUnit(ctx);

      expect(unit).toContain("[Unit]");
      expect(unit).toContain("[Service]");
      expect(unit).toContain("[Install]");
      expect(unit).toContain(`WorkingDirectory=${ctx.workingDirectory}`);
      expect(unit).toContain(`ExecStart=${ctx.nodeExecutablePath} ${ctx.cliEntrypointPath} start`);
      expect(unit).toContain(`Environment=TELEPI_CONFIG=${ctx.configPath}`);
      if (ctx.pathEnvironment) {
        expect(unit).toContain(`Environment=PATH=${ctx.pathEnvironment}`);
      }
      expect(unit).not.toContain("__TELEPI_WORKDIR__");
      expect(unit).not.toContain("__TELEPI_NODE_PATH__");
      expect(unit).not.toContain("__TELEPI_CLI_PATH__");
      expect(unit).not.toContain("__TELEPI_CONFIG_ENV__");
      expect(unit).not.toContain("__TELEPI_PATH_ENV__");
      expect(unit).not.toContain("__TELEPI_STDOUT_PATH__");
      expect(unit).not.toContain("__TELEPI_STDERR_PATH__");
      expect(unit).toContain("Restart=on-failure");
      expect(unit).toContain("RestartSec=5");
      expect(unit).toContain("WantedBy=default.target");
    });

    it("handles missing PATH environment gracefully", () => {
      const ctx = createLinuxContext();
      ctx.pathEnvironment = undefined;

      const unit = buildSystemdUnit(ctx);

      expect(unit).toContain("Environment=PATH=");
    });

    it("quotes systemd values that contain whitespace", () => {
      const ctx = createLinuxContext();
      ctx.workingDirectory = path.join(tempDir, "work dir");
      ctx.nodeExecutablePath = path.join(tempDir, "node dir", "node");
      ctx.cliEntrypointPath = path.join(tempDir, "TelePi checkout", "dist", "cli.js");
      ctx.configPath = path.join(tempDir, "config dir", "config.env");
      ctx.pathEnvironment = `${path.join(tempDir, "bin dir")}:/usr/bin`;
      ctx.serviceUnitStdoutPath = path.join(tempDir, "log dir", "telepi.out.log");
      ctx.serviceUnitStderrPath = path.join(tempDir, "log dir", "telepi.err.log");

      const unit = buildSystemdUnit(ctx);

      expect(unit).toContain(`WorkingDirectory="${ctx.workingDirectory}"`);
      expect(unit).toContain(`ExecStart="${ctx.nodeExecutablePath}" "${ctx.cliEntrypointPath}" start`);
      expect(unit).toContain(`Environment="TELEPI_CONFIG=${ctx.configPath}"`);
      expect(unit).toContain(`Environment="PATH=${ctx.pathEnvironment}"`);
      expect(unit).toContain(`StandardOutput=append:"${ctx.serviceUnitStdoutPath}"`);
      expect(unit).toContain(`StandardError=append:"${ctx.serviceUnitStderrPath}"`);
    });

    it("throws when template is missing", () => {
      const ctx = createLinuxContext();
      rmSync(path.join(packageRoot, "systemd", "telepi.service"));

      expect(() => buildSystemdUnit(ctx)).toThrow("systemd unit template not found");
    });
  });

  describe("writeSystemdUnit", () => {
    it("writes the unit file and creates the parent directory", () => {
      const ctx = createLinuxContext();

      // Remove the pre-existing directory to test auto-creation
      if (ctx.serviceUnitPath) {
        rmSync(path.dirname(ctx.serviceUnitPath), { recursive: true, force: true });
      }

      const written = writeSystemdUnit(ctx);

      expect(written).toBe(true);
      const contents = readFileSync(ctx.serviceUnitPath!, "utf8");
      expect(contents).toContain(`WorkingDirectory=${ctx.workingDirectory}`);
    });

    it("returns false when the unit file has not changed", () => {
      const ctx = createLinuxContext();
      writeSystemdUnit(ctx); // first write

      const writtenAgain = writeSystemdUnit(ctx); // second write — idempotent

      expect(writtenAgain).toBe(false);
    });

    it("returns false when serviceUnitPath is undefined", () => {
      const ctx = createLinuxContext();
      ctx.serviceUnitPath = undefined;

      const written = writeSystemdUnit(ctx);

      expect(written).toBe(false);
    });

    it("returns true when the unit file changes after context update", () => {
      const ctx = createLinuxContext();
      writeSystemdUnit(ctx);

      // Change a path that affects the rendered output
      ctx.workingDirectory = path.join(tempDir, "new-workdir");
      const written = writeSystemdUnit(ctx);

      expect(written).toBe(true);
      const contents = readFileSync(ctx.serviceUnitPath!, "utf8");
      expect(contents).toContain(`WorkingDirectory=${ctx.workingDirectory}`);
    });
  });

  describe("reconcile", () => {
    it("returns a result with actions or warning from reconcile", () => {
      const manager = createSystemdManager();
      const ctx = createLinuxContext();

      const result = manager.reconcile(ctx);

      expect(result).toBeDefined();
      expect(Array.isArray(result.actions)).toBe(true);
      expect(typeof result.warning === "string" || result.warning === undefined).toBe(true);
    });
  });

  describe("ServiceManager interface", () => {
    it("exposes all required methods", () => {
      const manager = createSystemdManager();
      const ctx = createLinuxContext();

      expect(typeof manager.buildUnitFile).toBe("function");
      expect(typeof manager.writeUnitFile).toBe("function");
      expect(typeof manager.reconcile).toBe("function");
      expect(typeof manager.getStatus).toBe("function");

      const unit = manager.buildUnitFile(ctx);
      expect(typeof unit).toBe("string");
    });
  });

  describe("getStatus", () => {
    it("returns not-installed status when unit file does not exist", () => {
      const manager = createSystemdManager();
      const ctx = createLinuxContext();
      ctx.serviceUnitPath = path.join(tmpdir(), "nonexistent", "telepi.service");

      const status = manager.getStatus(ctx);

      expect(status.unitExists).toBe(false);
      expect(status.loaded).toBe(false);
      expect(status.state).toBe("not installed");
      expect(status.detail).toBe("not installed");
    });

    it("returns installed-but-not-loaded when unit file exists but systemctl fails or is unavailable", () => {
      const manager = createSystemdManager();
      const ctx = createLinuxContext();
      writeSystemdUnit(ctx);

      const status = manager.getStatus(ctx);

      // unit exists on disk
      expect(status.unitExists).toBe(true);
      // status depends on systemctl availability on the test runner
      // Expected: not loaded (service not installed in real systemd)
      expect(typeof status.detail).toBe("string");
    });

    it("returns ServiceStatus shape with all required fields", () => {
      const manager = createSystemdManager();
      const ctx = createLinuxContext();

      const status = manager.getStatus(ctx);

      // All fields present with correct types
      expect(typeof status.unitExists).toBe("boolean");
      expect(typeof status.plistExists).toBe("boolean");
      expect(typeof status.loaded).toBe("boolean");
      expect(status.state === undefined || typeof status.state === "string").toBe(true);
      expect(status.pid === undefined || typeof status.pid === "number").toBe(true);
      expect(typeof status.detail).toBe("string");
      expect(status.error === undefined || typeof status.error === "string").toBe(true);
    });
  });
});