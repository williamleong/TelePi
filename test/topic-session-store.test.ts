import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    rmSync: vi.fn(actual.rmSync),
  };
});

import { TopicSessionStore } from "../src/topic-session-store.js";

describe("TopicSessionStore", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-topic-sessions-"));
  });

  afterEach(() => {
    vi.mocked(fs.renameSync).mockRestore();
    vi.mocked(fs.rmSync).mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("persists and reloads versioned topic records", () => {
    const statePath = path.join(tempDir, "topic-sessions.json");
    const store = TopicSessionStore.open(statePath);
    store.set("123::77", { sessionFile: "/sessions/a.jsonl", workspace: "/workspace/a" });

    expect(TopicSessionStore.open(statePath).get("123::77")).toEqual({
      sessionFile: "/sessions/a.jsonl",
      workspace: "/workspace/a",
    });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      version: 1,
      topics: {
        "123::77": { sessionFile: "/sessions/a.jsonl", workspace: "/workspace/a" },
      },
    });
  });

  it("persists delete", () => {
    const statePath = path.join(tempDir, "topic-sessions.json");
    const store = TopicSessionStore.open(statePath);
    store.set("123::77", { sessionFile: "/sessions/a.jsonl", workspace: "/workspace/a" });
    store.delete("123::77");

    expect(TopicSessionStore.open(statePath).get("123::77")).toBeUndefined();
  });

  it("degrades malformed JSON to empty state and warns", () => {
    const statePath = path.join(tempDir, "topic-sessions.json");
    writeFileSync(statePath, "not json");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(TopicSessionStore.open(statePath).get("123::77")).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(statePath));
  });

  it("ignores invalid record fields", () => {
    const statePath = path.join(tempDir, "topic-sessions.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        topics: {
          valid: { sessionFile: "/sessions/a.jsonl", workspace: "/workspace/a" },
          empty: { sessionFile: "", workspace: "/workspace/a" },
          wrong: { sessionFile: "/sessions/b.jsonl", workspace: 42 },
        },
      }),
    );

    const store = TopicSessionStore.open(statePath);
    expect(store.get("valid")).toEqual({ sessionFile: "/sessions/a.jsonl", workspace: "/workspace/a" });
    expect(store.get("empty")).toBeUndefined();
    expect(store.get("wrong")).toBeUndefined();
  });

  it("does not throw when persistence and temporary-file cleanup both fail", () => {
    const statePath = path.join(tempDir, "topic-sessions.json");
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw new Error("persistence failed");
    });
    vi.mocked(fs.rmSync).mockImplementation(() => {
      throw new Error("cleanup failed");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() =>
      TopicSessionStore.open(statePath).set("123::77", {
        sessionFile: "/sessions/a.jsonl",
        workspace: "/workspace/a",
      }),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(statePath));
  });

  it("memory performs no filesystem write", () => {
    const store = TopicSessionStore.memory();
    store.set("123::77", { sessionFile: "/sessions/a.jsonl", workspace: "/workspace/a" });

    expect(store.get("123::77")).toEqual({ sessionFile: "/sessions/a.jsonl", workspace: "/workspace/a" });
    expect(() => readFileSync(path.join(tempDir, "topic-sessions.json"))).toThrow();
  });
});
