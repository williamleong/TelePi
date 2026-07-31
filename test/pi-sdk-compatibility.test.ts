import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DefaultResourceLoader,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import { assertPiSdkCompatibility } from "../src/pi-sdk-compatibility.js";

describe("assertPiSdkCompatibility", () => {
  it("accepts a Pi SDK that exposes the pi-ai compatibility entrypoint", () => {
    expect(() => assertPiSdkCompatibility((specifier) => {
      if (specifier === "@earendil-works/pi-ai/compat") {
        return "/mock/node_modules/@earendil-works/pi-ai/dist/compat.js";
      }
      throw new Error(`Cannot resolve ${specifier}`);
    })).not.toThrow();
  });

  it("throws a clear setup error when the resolved Pi SDK is too old", () => {
    expect(() => assertPiSdkCompatibility(() => {
      throw new Error("Package subpath './compat' is not defined by exports");
    })).toThrow(
      "TelePi requires @earendil-works Pi SDK packages >=0.83.0 <0.84.0",
    );
  });

  it("loads an external extension that imports all Pi SDK packages", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "telepi-pi-sdk-"));
    const agentDir = path.join(tempDir, ".pi");
    const extensionPath = path.join(tempDir, "telepi-sdk-check.ts");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(extensionPath, `
import { defineTool } from "@earendil-works/pi-coding-agent";
import { TUI } from "@earendil-works/pi-tui";
import { getModels } from "@earendil-works/pi-ai";
import { Agent } from "@earendil-works/pi-agent-core";

void [defineTool, TUI, getModels, Agent];

export default function (pi) {
  pi.registerCommand("telepi-sdk-check", {
    description: "Verify Pi SDK extension imports",
    handler: async () => {},
  });
}
`);

    try {
      const loader = new DefaultResourceLoader({
        cwd: tempDir,
        agentDir,
        additionalExtensionPaths: [extensionPath],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });

      await loader.reload();

      const extensions = loader.getExtensions();
      expect(extensions.errors).toEqual([]);
      expect(extensions.extensions).toHaveLength(1);
      expect(extensions.extensions[0]?.commands.has("telepi-sdk-check")).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("includes the GPT-5.6 Codex model catalog", async () => {
    const runtime = await ModelRuntime.create();
    const ids = new Set(
      runtime.getModels("openai-codex").map((model) => model.id),
    );

    expect(ids.has("gpt-5.6-luna")).toBe(true);
    expect(ids.has("gpt-5.6-sol")).toBe(true);
    expect(ids.has("gpt-5.6-terra")).toBe(true);
  });
});
