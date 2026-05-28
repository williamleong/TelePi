import { describe, expect, it, vi } from "vitest";

import { createPromptHandler } from "../../src/bot/prompt-handler.js";

function createExtensionDialogs() {
  return {
    openSelect: vi.fn().mockResolvedValue(undefined),
    openConfirm: vi.fn().mockResolvedValue(false),
    openInput: vi.fn().mockResolvedValue(undefined),
  };
}

describe("prompt handler", () => {
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
});
