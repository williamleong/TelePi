import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { claimNextPromptInboxFile, pollPromptInboxOnce, startPromptInboxPolling } from "../../src/bot/prompt-inbox.js";

describe("prompt inbox", () => {
  let tempDir: string;
  let inboxDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-prompt-inbox-"));
    inboxDir = path.join(tempDir, "inbox");
    mkdirSync(inboxDir, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns undefined for missing directories", async () => {
    await expect(claimNextPromptInboxFile(path.join(tempDir, "missing"))).resolves.toBeUndefined();
  });

  it("claims prompts by moving them to a processing file", async () => {
    const promptPath = path.join(inboxDir, "daily.txt");
    writeFileSync(promptPath, "daily briefing");

    const claimed = await claimNextPromptInboxFile(inboxDir);

    expect(claimed).toMatchObject({
      originalPath: promptPath,
      path: `${promptPath}.processing`,
      prompt: "daily briefing",
    });
    expect(existsSync(promptPath)).toBe(false);
    expect(statSync(`${promptPath}.processing`).isFile()).toBe(true);

    await claimed?.ack();
    expect(existsSync(`${promptPath}.processing`)).toBe(false);
  });

  it("claims the oldest non-empty txt prompt and ignores other entries", async () => {
    writeFileSync(path.join(inboxDir, "ignore.md"), "ignored");
    mkdirSync(path.join(inboxDir, "nested.txt"));
    const newerPath = path.join(inboxDir, "newer.txt");
    const olderPath = path.join(inboxDir, "older.txt");
    writeFileSync(newerPath, "newer prompt");
    writeFileSync(olderPath, "  older prompt  \n");

    const older = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-01-02T00:00:00Z");
    vi.setSystemTime(newer);
    await import("node:fs/promises").then(({ utimes }) => Promise.all([
      utimes(olderPath, older, older),
      utimes(newerPath, newer, newer),
    ]));

    const claimed = await claimNextPromptInboxFile(inboxDir);

    expect(claimed).toMatchObject({
      prompt: "older prompt",
      originalPath: olderPath,
      path: `${olderPath}.processing`,
    });
    expect(existsSync(olderPath)).toBe(false);
    expect(statSync(`${olderPath}.processing`).isFile()).toBe(true);

    await claimed?.ack();
    await expect(claimNextPromptInboxFile(inboxDir)).resolves.toMatchObject({
      prompt: "newer prompt",
      originalPath: newerPath,
      path: `${newerPath}.processing`,
    });
  });

  it("deletes empty txt files until no prompt remains", async () => {
    const emptyPath = path.join(inboxDir, "empty.txt");
    writeFileSync(emptyPath, "  \n\t ");

    await expect(claimNextPromptInboxFile(inboxDir)).resolves.toBeUndefined();
    await expect(import("node:fs/promises").then(({ stat }) => stat(emptyPath))).rejects.toThrow();
  });

  it("polls one prompt into the target chat and deletes it after acceptance", async () => {
    const promptPath = path.join(inboxDir, "daily.txt");
    writeFileSync(promptPath, "  send the daily briefing  ");
    const handlePrompt = vi.fn().mockResolvedValue(true);

    await expect(pollPromptInboxOnce({
      inboxDir,
      target: { chatId: 123 },
      isBusy: () => false,
      handlePrompt,
    })).resolves.toBe("queued");

    expect(handlePrompt).toHaveBeenCalledWith({ chatId: 123 }, "send the daily briefing");
    await expect(import("node:fs/promises").then(({ stat }) => stat(promptPath))).rejects.toThrow();
  });

  it("moves a prompt to failed when dispatch refuses it", async () => {
    const promptPath = path.join(inboxDir, "race.txt");
    writeFileSync(promptPath, "try after current prompt");
    const handlePrompt = vi.fn().mockResolvedValue(false);

    await expect(pollPromptInboxOnce({
      inboxDir,
      target: { chatId: 123 },
      isBusy: () => false,
      handlePrompt,
    })).resolves.toBe("failed");

    expect(handlePrompt).toHaveBeenCalledWith({ chatId: 123 }, "try after current prompt");
    expect(existsSync(promptPath)).toBe(false);
    expect(statSync(`${promptPath}.failed`).isFile()).toBe(true);
  });

  it("leaves queued prompts untouched while the target chat is busy", async () => {
    const promptPath = path.join(inboxDir, "busy.txt");
    writeFileSync(promptPath, "try later");
    const handlePrompt = vi.fn().mockResolvedValue(true);

    await expect(pollPromptInboxOnce({
      inboxDir,
      target: { chatId: 123 },
      isBusy: () => true,
      handlePrompt,
    })).resolves.toBe("busy");

    expect(handlePrompt).not.toHaveBeenCalled();
    expect(statSync(promptPath).isFile()).toBe(true);
  });

  it("does not overlap interval polls while a prompt dispatch is still in flight", async () => {
    writeFileSync(path.join(inboxDir, "slow.txt"), "slow prompt");
    let resolveDispatch: ((accepted: boolean) => void) | undefined;
    const handlePrompt = vi.fn().mockImplementation(() =>
      new Promise<boolean>((resolve) => {
        resolveDispatch = resolve;
      }),
    );

    const stop = startPromptInboxPolling({
      inboxDir,
      intervalMs: 1,
      target: { chatId: 123 },
      isBusy: () => false,
      handlePrompt,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(handlePrompt).toHaveBeenCalledTimes(1);
      resolveDispatch?.(true);
      await new Promise((resolve) => setTimeout(resolve, 5));
    } finally {
      stop();
    }
  });
});
