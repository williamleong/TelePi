import { describe, expect, it, vi } from "vitest";

import { createPromptHandler } from "../../src/bot/prompt-handler.js";
import type { PiSessionCallbacks } from "../../src/pi-session.js";

function createExtensionDialogs() {
  return {
    openSelect: vi.fn().mockResolvedValue(undefined),
    openConfirm: vi.fn().mockResolvedValue(false),
    openInput: vi.fn().mockResolvedValue(undefined),
  };
}

function createActivityHarness(options: {
  activityEnabled?: boolean;
  toolVerbosity?: "none" | "summary" | "errors-only" | "all";
  editDebounceMs?: number;
  onPrompt: (callbacks: PiSessionCallbacks) => void | Promise<void>;
  sendMessage?: (text: string, messageId: number) => Promise<{ message_id: number }>;
  editMessage?: (text: string, messageId: number) => Promise<void>;
}) {
  const sent: Array<{ text: string; fallbackText?: string; messageId: number }> = [];
  const edits: Array<{ text: string; fallbackText?: string; messageId: number }> = [];
  const completedOperations: Array<{ kind: "send" | "edit"; text: string; messageId: number }> = [];
  let callbacks: PiSessionCallbacks | undefined;
  let nextMessageId = 0;
  const fakePiSession = {
    bindExtensions: vi.fn().mockResolvedValue(undefined),
    subscribe(nextCallbacks: PiSessionCallbacks) {
      callbacks = nextCallbacks;
      return vi.fn();
    },
    prompt: vi.fn(async () => {
      if (!callbacks) {
        throw new Error("Prompt callbacks were not subscribed");
      }
      await options.onPrompt(callbacks);
    }),
  };
  const handler = createPromptHandler({
    bot: { api: {
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      async sendMessage(_chatId: number, text: string, sendOptions?: { fallbackText?: string }) {
        const messageId = ++nextMessageId;
        sent.push({ text, fallbackText: sendOptions?.fallbackText, messageId });
        const message = await (options.sendMessage?.(text, messageId) ?? Promise.resolve({ message_id: messageId }));
        completedOperations.push({ kind: "send", text, messageId });
        return message;
      },
      async editMessageText(_chatId: number, messageId: number, text: string, editOptions?: { fallbackText?: string }) {
        edits.push({ text, fallbackText: editOptions?.fallbackText, messageId });
        await (options.editMessage?.(text, messageId) ?? Promise.resolve());
        completedOperations.push({ kind: "edit", text, messageId });
      },
      editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    } } as any,
    toolVerbosity: options.toolVerbosity ?? "summary",
    isActivityEnabled: () => options.activityEnabled ?? true,
    editDebounceMs: options.editDebounceMs ?? 0,
    typingIntervalMs: 60000,
    isBusy: () => false,
    taskRunner: { tryStartPrompt(_target, _promptText, task) { void task(); return "started"; } },
    ensureActiveSession: vi.fn().mockResolvedValue(fakePiSession),
    syncChatScopedCommands: vi.fn(),
    refreshChatScopedCommands: vi.fn(),
    extensionDialogs: createExtensionDialogs(),
    sendBusyReply: vi.fn(),
  });

  return {
    sent,
    edits,
    completedOperations,
    run: () => (handler as any)({} as any, { chatId: 123 }, "prompt", undefined, undefined, { waitForCompletion: true }),
  };
}

describe("prompt handler", () => {
  it("waits for completion when requested", async () => {
    let releasePrompt!: () => void;
    let promptStarted!: () => void;
    const promptStartedPromise = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const promptReleasePromise = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    let callbacks: any;

    const fakePiSession = {
      bindExtensions: vi.fn().mockResolvedValue(undefined),
      subscribe(nextCallbacks: any) {
        callbacks = nextCallbacks;
        return vi.fn();
      },
      prompt: vi.fn(async () => {
        promptStarted();
        await promptReleasePromise;
        callbacks.onAgentEnd();
      }),
    };

    const handler = createPromptHandler({
      bot: {
        api: {
          sendChatAction: vi.fn().mockResolvedValue(undefined),
          sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
          editMessageText: vi.fn().mockResolvedValue(undefined),
          editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
        },
      } as any,
      toolVerbosity: "summary",
      isActivityEnabled: () => true,
      editDebounceMs: 0,
      typingIntervalMs: 60000,
      isBusy: () => false,
      taskRunner: {
        tryStartPrompt(_target, _promptText, task) {
          void task();
          return "started";
        },
      },
      ensureActiveSession: vi.fn().mockResolvedValue(fakePiSession),
      syncChatScopedCommands: vi.fn(),
      refreshChatScopedCommands: vi.fn(),
      extensionDialogs: createExtensionDialogs(),
      sendBusyReply: vi.fn(),
    });

    let settled = false;
    const resultPromise = (handler as any)(
      {} as any,
      { chatId: 123 },
      "wait for me",
      undefined,
      undefined,
      { waitForCompletion: true },
    ).then((result: boolean) => {
      settled = true;
      return result;
    });

    await promptStartedPromise;
    await Promise.resolve();
    expect(settled).toBe(false);

    releasePrompt();
    await expect(resultPromise).resolves.toBe(true);
  });

  it("reports waited prompt failures", async () => {
    const fakePiSession = {
      bindExtensions: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockReturnValue(vi.fn()),
      prompt: vi.fn().mockRejectedValue(new Error("boom")),
    };

    const handler = createPromptHandler({
      bot: {
        api: {
          sendChatAction: vi.fn().mockResolvedValue(undefined),
          sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
          editMessageText: vi.fn().mockResolvedValue(undefined),
          editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
        },
      } as any,
      toolVerbosity: "summary",
      isActivityEnabled: () => true,
      editDebounceMs: 0,
      typingIntervalMs: 60000,
      isBusy: () => false,
      taskRunner: {
        tryStartPrompt(_target, _promptText, task) {
          void task();
          return "started";
        },
      },
      ensureActiveSession: vi.fn().mockResolvedValue(fakePiSession),
      syncChatScopedCommands: vi.fn(),
      refreshChatScopedCommands: vi.fn(),
      extensionDialogs: createExtensionDialogs(),
      sendBusyReply: vi.fn(),
    });

    await expect((handler as any)(
      {} as any,
      { chatId: 123 },
      "fail",
      undefined,
      undefined,
      { waitForCompletion: true },
    )).resolves.toBe(false);
  });

  it("sends typing before session activation finishes", async () => {
    let releaseEnsureActiveSession!: () => void;
    const ensureStarted = new Promise<void>((resolve) => {
      releaseEnsureActiveSession = resolve;
    });
    const typingCalls: Array<{ chatId: number; action: string; options: Record<string, unknown> }> = [];
    let taskPromise!: Promise<void>;

    const handler = createPromptHandler({
      bot: {
        api: {
          sendChatAction(chatId: number, action: string, options: Record<string, unknown>) {
            typingCalls.push({ chatId, action, options });
            return Promise.resolve();
          },
        },
      } as any,
      toolVerbosity: "summary",
      isActivityEnabled: () => true,
      editDebounceMs: 1500,
      typingIntervalMs: 60000,
      isBusy: () => false,
      taskRunner: {
        tryStartPrompt(_target, _promptText, task) {
          taskPromise = task();
          return "started";
        },
      },
      ensureActiveSession: async () => {
        await ensureStarted;
        return undefined;
      },
      syncChatScopedCommands: vi.fn(),
      refreshChatScopedCommands: vi.fn(),
      extensionDialogs: createExtensionDialogs(),
      sendBusyReply: vi.fn(),
    });

    await handler({} as any, { chatId: 123 }, "hello");
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(typingCalls).toEqual([{ chatId: 123, action: "typing", options: {} }]);

    releaseEnsureActiveSession();
    await taskPromise;
  });

  it("sends a working message before a prompt completes without text", async () => {
    let releasePrompt!: () => void;
    let promptStarted!: () => void;
    const promptStartedPromise = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const promptReleasePromise = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const sentMessages: Array<{ chatId: number; text: string; options: any }> = [];
    let callbacks: any;
    let taskPromise!: Promise<void>;

    const fakePiSession = {
      bindExtensions: vi.fn().mockResolvedValue(undefined),
      subscribe(nextCallbacks: any) {
        callbacks = nextCallbacks;
        return vi.fn();
      },
      prompt: vi.fn(async () => {
        promptStarted();
        await promptReleasePromise;
        callbacks.onAgentEnd();
      }),
    };

    const handler = createPromptHandler({
      bot: {
        api: {
          sendChatAction: vi.fn().mockResolvedValue(undefined),
          sendMessage(chatId: number, text: string, options: any) {
            sentMessages.push({ chatId, text, options });
            return Promise.resolve({ message_id: sentMessages.length });
          },
          editMessageText: vi.fn().mockResolvedValue(undefined),
          editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
        },
      } as any,
      toolVerbosity: "summary",
      isActivityEnabled: () => true,
      editDebounceMs: 1500,
      typingIntervalMs: 60000,
      isBusy: () => false,
      taskRunner: {
        tryStartPrompt(_target, _promptText, task) {
          taskPromise = task();
          return "started";
        },
      },
      ensureActiveSession: vi.fn().mockResolvedValue(fakePiSession),
      syncChatScopedCommands: vi.fn(),
      refreshChatScopedCommands: vi.fn(),
      extensionDialogs: createExtensionDialogs(),
      sendBusyReply: vi.fn(),
    });

    await handler({} as any, { chatId: 123 }, "silent tool work");
    await promptStartedPromise;

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.text).toMatch(/Working/i);
    expect(sentMessages[0]?.options.reply_markup).toBeDefined();

    releasePrompt();
    await taskPromise;
  });

  it("edits the working message when text deltas arrive", async () => {
    const sentMessages: Array<{ chatId: number; text: string; options: any }> = [];
    const editedTexts: Array<{ chatId: number; messageId: number; text: string; options: any }> = [];
    const replyMarkupEdits: Array<{ chatId: number; messageId: number; options: any }> = [];
    let callbacks: any;
    let taskPromise!: Promise<void>;

    const fakePiSession = {
      bindExtensions: vi.fn().mockResolvedValue(undefined),
      subscribe(nextCallbacks: any) {
        callbacks = nextCallbacks;
        return vi.fn();
      },
      prompt: vi.fn(async () => {
        callbacks.onTextDelta("Hello from Pi");
        await new Promise((resolve) => setTimeout(resolve, 5));
        callbacks.onAgentEnd();
      }),
    };

    const handler = createPromptHandler({
      bot: {
        api: {
          sendChatAction: vi.fn().mockResolvedValue(undefined),
          sendMessage(chatId: number, text: string, options: any) {
            sentMessages.push({ chatId, text, options });
            return Promise.resolve({ message_id: sentMessages.length });
          },
          editMessageText(chatId: number, messageId: number, text: string, options: any) {
            editedTexts.push({ chatId, messageId, text, options });
            return Promise.resolve();
          },
          editMessageReplyMarkup(chatId: number, messageId: number, options: any) {
            replyMarkupEdits.push({ chatId, messageId, options });
            return Promise.resolve();
          },
        },
      } as any,
      toolVerbosity: "summary",
      isActivityEnabled: () => true,
      editDebounceMs: 0,
      typingIntervalMs: 60000,
      isBusy: () => false,
      taskRunner: {
        tryStartPrompt(_target, _promptText, task) {
          taskPromise = task();
          return "started";
        },
      },
      ensureActiveSession: vi.fn().mockResolvedValue(fakePiSession),
      syncChatScopedCommands: vi.fn(),
      refreshChatScopedCommands: vi.fn(),
      extensionDialogs: createExtensionDialogs(),
      sendBusyReply: vi.fn(),
    });

    await handler({} as any, { chatId: 123 }, "hello");
    await taskPromise;

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.text).toMatch(/Working/i);
    expect(editedTexts.some((edit) => edit.text.includes("Hello from Pi"))).toBe(true);
    expect(replyMarkupEdits.length).toBeGreaterThanOrEqual(1);
  });

  it("streams activity separately from the final response", async () => {
    const harness = createActivityHarness({
      onPrompt: (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "1:0", delta: "Inspect files" });
        callbacks.onToolStart("read", "tool-1", { path: "src/a.ts" });
        callbacks.onToolEnd("tool-1", false);
        callbacks.onTextDelta("Final answer");
        callbacks.onAgentEnd();
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    const activity = [...harness.sent, ...harness.edits]
      .filter((message) => message.text.includes("Thinking") || message.text.includes("Read"));
    expect(activity.map((message) => message.text).join("\n")).toContain("Thinking");
    expect(activity.map((message) => message.text).join("\n")).toContain("Inspect files");
    expect(activity.map((message) => message.text).join("\n")).toContain("src/a.ts");
    expect(activity.map((message) => message.text).join("\n")).toContain("✓");
    const finalResponse = harness.edits.find((message) => message.text.includes("Final answer"));
    expect(finalResponse).toBeDefined();
    expect(activity.some((message) => message.messageId === finalResponse?.messageId)).toBe(false);
    expect(finalResponse?.text).not.toContain("read ×1");
  });

  it("preserves legacy summary output when activity is disabled", async () => {
    const harness = createActivityHarness({
      activityEnabled: false,
      onPrompt: (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "1:0", delta: "hidden thinking" });
        callbacks.onToolStart("read", "tool-1", { path: "src/a.ts" });
        callbacks.onTextDelta("Final answer");
        callbacks.onAgentEnd();
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    const delivered = [...harness.sent, ...harness.edits].map((message) => message.text).join("\n");
    expect(delivered).not.toContain("hidden thinking");
    expect(delivered).toContain("read");
  });

  it("does not send activity for text-only responses", async () => {
    const harness = createActivityHarness({
      onPrompt: (callbacks) => {
        callbacks.onTextDelta("Final answer");
        callbacks.onAgentEnd();
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.text).toMatch(/Working/i);
  });

  it("waits for an in-flight activity flush before delivering the final response", async () => {
    vi.useFakeTimers();
    let releaseFirstActivitySend!: () => void;
    let releasePrompt!: () => void;
    let firstActivitySendStarted!: () => void;
    const firstActivitySend = new Promise<void>((resolve) => {
      releaseFirstActivitySend = resolve;
    });
    const firstActivitySendStartedPromise = new Promise<void>((resolve) => {
      firstActivitySendStarted = resolve;
    });
    const promptRelease = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const harness = createActivityHarness({
      editDebounceMs: 10,
      sendMessage: async (text, messageId) => {
        if (text.includes("first activity")) {
          firstActivitySendStarted();
          await firstActivitySend;
        }
        return { message_id: messageId };
      },
      onPrompt: async (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "1:0", delta: "first activity" });
        callbacks.onTextDelta("Final answer");
        await firstActivitySendStartedPromise;
        callbacks.onThinkingDelta({ blockKey: "1:0", delta: " later activity" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        callbacks.onAgentEnd();
        await promptRelease;
      },
    });

    const prompt = harness.run();
    try {
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(harness.edits.some((message) => message.text.includes("Final answer"))).toBe(false);

      releaseFirstActivitySend();
      await Promise.resolve();
      releasePrompt();
      await expect(prompt).resolves.toBe(true);

      const finalResponseIndex = harness.completedOperations.findIndex(
        (operation) => operation.kind === "edit" && operation.text.includes("Final answer"),
      );
      const finalActivityIndex = harness.completedOperations.findIndex(
        (operation) => operation.text.includes("later activity"),
      );
      expect(finalActivityIndex).toBeGreaterThanOrEqual(0);
      expect(finalActivityIndex).toBeLessThan(finalResponseIndex);
    } finally {
      releaseFirstActivitySend();
      releasePrompt();
      await prompt.catch(() => {});
      vi.useRealTimers();
    }
  });

  it("stops activity delivery after a rejected operation", async () => {
    let activityAttempts = 0;
    const harness = createActivityHarness({
      sendMessage: (text, messageId) => {
        if (text.includes("Thinking")) {
          activityAttempts += 1;
          return Promise.reject(new Error("activity failed"));
        }
        return Promise.resolve({ message_id: messageId });
      },
      onPrompt: async (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "1:0", delta: "first activity" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        callbacks.onThinkingDelta({ blockKey: "1:0", delta: "later activity" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        callbacks.onTextDelta("Final answer");
        callbacks.onAgentEnd();
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    expect(harness.edits.some((message) => message.text.includes("Final answer"))).toBe(true);
    expect(activityAttempts).toBe(1);
  });

  it("rolls over activity chunks and completes the earlier tool message", async () => {
    const thinking = "a".repeat(4_100);
    const harness = createActivityHarness({
      onPrompt: async (callbacks) => {
        callbacks.onToolStart("read", "tool-1", { path: "src/a.ts" });
        callbacks.onThinkingDelta({ blockKey: "1:0", delta: thinking });
        await new Promise((resolve) => setTimeout(resolve, 0));
        callbacks.onToolEnd("tool-1", false);
        callbacks.onAgentEnd();
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    const activitySends = harness.sent.filter((message) => message.text.includes("Thinking") || message.text.includes("Read"));
    const runningTool = activitySends.find((message) => message.text.includes("•") && message.text.includes("Read"));
    expect(activitySends).toHaveLength(3);
    expect(runningTool).toBeDefined();
    expect([...harness.sent, ...harness.edits].every((message) => message.text.length <= 4_000)).toBe(true);
    expect(harness.edits.some(
      (message) => message.messageId === runningTool?.messageId && message.text.includes("✓") && message.text.includes("Read"),
    )).toBe(true);
    const recoveredThinking = activitySends.map((message) => message.text).join("")
      .replace(/<b>🧠 Thinking(?: \(continued\))?<\/b>\n/g, "");
    expect(recoveredThinking).toContain(thinking);
  });
});
