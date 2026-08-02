import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

const topicSessionStoreMocks = vi.hoisted(() => ({
  getDefaultTopicSessionStatePath: vi.fn(),
}));

vi.mock("../src/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/paths.js")>()),
  getDefaultTopicSessionStatePath: topicSessionStoreMocks.getDefaultTopicSessionStatePath,
}));

import { isEntrypoint } from "../src/entrypoint.js";
import { createTopicSessionStore } from "../src/index.js";
import { TopicSessionStore } from "../src/topic-session-store.js";

describe("entrypoint detection", () => {
  it("creates a disk-backed topic session store at the default state path", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telepi-topic-session-startup-"));
    const statePath = path.join(directory, "topic-sessions.json");
    topicSessionStoreMocks.getDefaultTopicSessionStatePath.mockReturnValue(statePath);

    try {
      const store = createTopicSessionStore();
      store.set("123::77", { sessionFile: "/sessions/a.jsonl", workspace: "/workspace/a" });

      expect(TopicSessionStore.open(statePath).get("123::77")).toEqual({
        sessionFile: "/sessions/a.jsonl",
        workspace: "/workspace/a",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
      vi.clearAllMocks();
    }
  });

  it("treats symlinked bin paths as the real module entrypoint", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telepi-entrypoint-"));
    const realCliPath = path.join(directory, "node_modules", "@futurelab-studio", "telepi", "dist", "cli.js");
    const symlinkPath = path.join(directory, "bin", "telepi");

    mkdirSync(path.dirname(realCliPath), { recursive: true });
    mkdirSync(path.dirname(symlinkPath), { recursive: true });
    writeFileSync(realCliPath, "#!/usr/bin/env node\n", { flag: "wx" });
    symlinkSync(realCliPath, symlinkPath);

    expect(isEntrypoint(pathToFileURL(realCliPath).href, symlinkPath)).toBe(true);
  });

  it("rejects missing or unrelated argv paths", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telepi-entrypoint-"));
    const modulePath = path.join(directory, "cli.js");
    const otherPath = path.join(directory, "other.js");

    writeFileSync(modulePath, "", { flag: "wx" });
    writeFileSync(otherPath, "", { flag: "wx" });

    expect(isEntrypoint(pathToFileURL(modulePath).href, undefined)).toBe(false);
    expect(isEntrypoint(pathToFileURL(modulePath).href, otherPath)).toBe(false);
  });
});
