import { describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { createPromptHandler } from "../../src/bot/prompt-handler.js";
import type { PiSessionCallbacks } from "../../src/pi-session.js";

type TelegramOperation =
  | { kind: "send"; messageId: number; text: string; hasAbort: boolean; delivery: "plain" | "rich" }
  | { kind: "edit"; messageId: number; text: string; hasAbort: boolean; delivery: "plain" | "rich" }
  | { kind: "markup"; messageId: number; hasAbort: boolean }
  | { kind: "delete"; messageId: number }
  | { kind: "typing" };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function settlesWithinMicrotasks<T>(promise: Promise<T>, turns = 100): Promise<{
  settled: boolean;
  value?: T;
  error?: unknown;
}> {
  let settled = false;
  let value: T | undefined;
  let error: unknown;
  void promise.then(
    (result) => {
      value = result;
      settled = true;
    },
    (reason: unknown) => {
      error = reason;
      settled = true;
    },
  );

  for (let turn = 0; turn < turns && !settled; turn += 1) {
    await Promise.resolve();
  }

  return { settled, value, error };
}

function hasAbortKeyboard(replyMarkup: unknown): boolean {
  return String(JSON.stringify(replyMarkup)).includes("pi_abort");
}

function createPromptHarness(options: {
  activityEnabled?: boolean;
  toolVerbosity?: "none" | "summary" | "errors-only" | "all";
  editDebounceMs?: number;
  typingIntervalMs?: number;
  onPrompt?: (callbacks: PiSessionCallbacks) => void | Promise<void>;
  promptError?: Error;
  bindExtensionsError?: Error;
  onBindExtensions?: (ui: ExtensionUIContext) => Promise<void> | void;
  onOpenDialog?: (method: "select" | "confirm" | "input") => Promise<void> | void;
  subscribeError?: Error;
  ensureActiveSession?: () => Promise<unknown>;
  onSend?: (text: string, messageId: number) => Promise<void> | void;
  onEdit?: (text: string, messageId: number) => Promise<void> | void;
  onMarkup?: (messageId: number, hasAbort: boolean) => Promise<void> | void;
  onDelete?: (messageId: number) => Promise<void> | void;
  isBusy?: (target: { chatId: number }) => boolean;
  taskRunnerResult?: "started" | "busy";
  taskRunnerResults?: Array<"started" | "busy">;
  trySteer?: (target: { chatId: number }, text: string) => Promise<boolean>;
}) {
  const operations: TelegramOperation[] = [];
  const markupAttempts: Array<{ messageId: number; hasAbort: boolean }> = [];
  const trackCallbackMessages: number[] = [];
  const operationWaiters = new Set<() => void>();
  let callbacks: PiSessionCallbacks | undefined;
  let uiContext: ExtensionUIContext | undefined;
  let nextMessageId = 0;
  let taskPromise: Promise<void> | undefined;
  let taskStartCount = 0;
  const renameForumTopicToSessionName = vi.fn().mockResolvedValue(undefined);
  const isBusy = vi.fn(options.isBusy ?? (() => false));
  const trySteer = vi.fn(options.trySteer ?? (async () => false));
  const sendBusyReply = vi.fn().mockResolvedValue(undefined);

  const record = (operation: TelegramOperation): void => {
    operations.push(operation);
    for (const notify of operationWaiters) {
      notify();
    }
  };

  const waitForOperation = async (
    predicate: (operation: TelegramOperation) => boolean,
    timeoutMs = 1_000,
  ): Promise<TelegramOperation> => {
    const existing = operations.find(predicate);
    if (existing) {
      return existing;
    }

    return new Promise<TelegramOperation>((resolve, reject) => {
      const timeout = setTimeout(() => {
        operationWaiters.delete(check);
        reject(new Error("Timed out waiting for Telegram operation"));
      }, timeoutMs);
      const check = () => {
        const operation = operations.find(predicate);
        if (!operation) {
          return;
        }
        clearTimeout(timeout);
        operationWaiters.delete(check);
        resolve(operation);
      };
      operationWaiters.add(check);
      check();
    });
  };

  const extensionDialogs = {
    openSelect: vi.fn(async () => {
      await options.onOpenDialog?.("select");
      return undefined;
    }),
    openConfirm: vi.fn(async () => {
      await options.onOpenDialog?.("confirm");
      return false;
    }),
    openInput: vi.fn(async () => {
      await options.onOpenDialog?.("input");
      return undefined;
    }),
  };

  const fakePiSession = {
    bindExtensions: vi.fn(async (bindings) => {
      if (options.bindExtensionsError) {
        throw options.bindExtensionsError;
      }
      uiContext = bindings.uiContext;
      await options.onBindExtensions?.(uiContext);
    }),
    subscribe(nextCallbacks: PiSessionCallbacks) {
      if (options.subscribeError) {
        throw options.subscribeError;
      }
      callbacks = nextCallbacks;
      return vi.fn();
    },
    prompt: vi.fn(async () => {
      if (!callbacks) {
        throw new Error("Prompt callbacks were not subscribed");
      }
      if (options.promptError) {
        throw options.promptError;
      }
      await options.onPrompt?.(callbacks);
    }),
    getInfo: vi.fn().mockReturnValue({
      sessionId: "session-id",
      workspace: "/workspace",
      sessionName: "before rename",
    }),
  };

  const botApi = {
      async sendChatAction() {
        record({ kind: "typing" });
      },
      async sendMessage(_chatId: number, text: string, sendOptions?: { reply_markup?: unknown }) {
        const messageId = ++nextMessageId;
        await options.onSend?.(text, messageId);
        record({ kind: "send", messageId, text, hasAbort: hasAbortKeyboard(sendOptions?.reply_markup), delivery: "plain" });
        return { message_id: messageId };
      },
      async sendRichMessage(_chatId: number, payload: { markdown: string }, sendOptions?: { reply_markup?: unknown }) {
        const messageId = ++nextMessageId;
        await options.onSend?.(payload.markdown, messageId);
        record({ kind: "send", messageId, text: payload.markdown, hasAbort: hasAbortKeyboard(sendOptions?.reply_markup), delivery: "rich" });
        return { message_id: messageId };
      },
      async editMessageText(
        _chatId: number,
        messageId: number,
        text: string | { markdown: string },
        editOptions?: { reply_markup?: unknown },
      ) {
        const rich = typeof text !== "string";
        const renderedText = rich ? text.markdown : text;
        await options.onEdit?.(renderedText, messageId);
        record({ kind: "edit", messageId, text: renderedText, hasAbort: hasAbortKeyboard(editOptions?.reply_markup), delivery: rich ? "rich" : "plain" });
      },
      async editMessageReplyMarkup(
        _chatId: number,
        messageId: number,
        markupOptions?: { reply_markup?: unknown },
      ) {
        const hasAbort = hasAbortKeyboard(markupOptions?.reply_markup);
        markupAttempts.push({ messageId, hasAbort });
        await options.onMarkup?.(messageId, hasAbort);
        record({ kind: "markup", messageId, hasAbort });
      },
      async deleteMessage(_chatId: number, messageId: number) {
        record({ kind: "delete", messageId });
        await options.onDelete?.(messageId);
        return true;
      },
  };

  const taskRunner = {
    tryStartPrompt: vi.fn((_target, _promptText, task) => {
      const result = options.taskRunnerResults?.[taskStartCount++] ?? options.taskRunnerResult ?? "started";
      if (result === "busy") {
        return result;
      }
      taskPromise = task().catch(() => {});
      return result;
    }),
  };

  const handler = createPromptHandler({
    bot: { api: botApi } as any,
    toolVerbosity: options.toolVerbosity ?? "summary",
    isActivityEnabled: () => options.activityEnabled ?? true,
    editDebounceMs: options.editDebounceMs ?? 0,
    typingIntervalMs: options.typingIntervalMs ?? 60_000,
    isBusy,
    taskRunner,
    trySteer,
    ensureActiveSession: vi.fn(options.ensureActiveSession ?? (async () => fakePiSession)),
    syncChatScopedCommands: vi.fn(),
    refreshChatScopedCommands: vi.fn(),
    extensionDialogs,
    trackCallbackMessage: (_target, messageId) => {
      trackCallbackMessages.push(messageId);
    },
    renameForumTopicToSessionName,
    sendBusyReply,
  });

  return {
    callbacks: () => callbacks,
    ui: () => uiContext,
    markupAttempts,
    operations,
    renameForumTopicToSessionName,
    trackCallbackMessages,
    isBusy,
    trySteer,
    taskRunner,
    sendBusyReply,
    prompt: fakePiSession.prompt,
    task: () => taskPromise,
    waitForOperation,
    run: (waitForCompletion = true) => handler(
      { api: botApi } as any,
      { chatId: 123 },
      "prompt",
      undefined,
      undefined,
      { waitForCompletion },
    ),
    runInput: ({
      text = "prompt",
      preloadedSlashCommands,
      images,
      waitForCompletion = true,
      allowSteering,
    }: {
      text?: string;
      preloadedSlashCommands?: any[];
      images?: any[];
      waitForCompletion?: boolean;
      allowSteering?: boolean;
    }) => handler(
      { api: botApi } as any,
      { chatId: 123 },
      text,
      preloadedSlashCommands,
      images,
      { waitForCompletion, allowSteering },
    ),
  };
}

describe("prompt handler", () => {
  it("steers ordinary text at the initial busy gate without creating a prompt flow", async () => {
    const harness = createPromptHarness({
      isBusy: () => true,
      trySteer: vi.fn().mockResolvedValue(true),
    });

    await expect(harness.runInput({ text: "check the logs" })).resolves.toBe(true);

    expect(harness.trySteer).toHaveBeenCalledWith({ chatId: 123 }, "check the logs");
    expect(harness.sendBusyReply).not.toHaveBeenCalled();
    expect(harness.taskRunner.tryStartPrompt).not.toHaveBeenCalled();
    expect(harness.operations).toEqual([]);
  });

  it("steers when task reservation discovers an active prompt", async () => {
    const harness = createPromptHarness({
      taskRunnerResult: "busy",
      trySteer: vi.fn().mockResolvedValue(true),
    });

    await expect(harness.runInput({ text: "check the logs" })).resolves.toBe(true);

    expect(harness.taskRunner.tryStartPrompt).toHaveBeenCalledTimes(1);
    expect(harness.trySteer).toHaveBeenCalledWith({ chatId: 123 }, "check the logs");
    expect(harness.sendBusyReply).not.toHaveBeenCalled();
    expect(harness.operations).toEqual([]);
  });

  it("delivers later Pi deltas through the original chronological flow after steering", async () => {
    const promptRelease = deferred();
    const promptStarted = deferred<PiSessionCallbacks>();
    const harness = createPromptHarness({
      taskRunnerResults: ["started", "busy"],
      trySteer: vi.fn().mockResolvedValue(true),
      onPrompt: async (callbacks) => {
        promptStarted.resolve(callbacks);
        await promptRelease.promise;
      },
    });

    await expect(harness.run(false)).resolves.toBe(true);
    const callbacks = await promptStarted.promise;
    callbacks.onTextDelta("original output");
    await harness.waitForOperation((operation) => operation.kind === "edit" && operation.messageId === 1 && operation.text.includes("original output"));

    await expect(harness.runInput({ text: "focus on the tests", waitForCompletion: false })).resolves.toBe(true);
    callbacks.onTextDelta(" after steering");
    promptRelease.resolve();
    await harness.task();

    expect(harness.taskRunner.tryStartPrompt).toHaveBeenCalledTimes(2);
    expect(harness.operations.some(
      (operation) => (operation.kind === "send" || operation.kind === "edit")
        && operation.text.includes("original output after steering"),
    )).toBe(true);
  });

  it("keeps the busy reply when text steering is unavailable", async () => {
    const harness = createPromptHarness({
      isBusy: () => true,
      trySteer: vi.fn().mockResolvedValue(false),
    });

    await expect(harness.runInput({ text: "check the logs" })).resolves.toBe(false);

    expect(harness.trySteer).toHaveBeenCalledWith({ chatId: 123 }, "check the logs");
    expect(harness.sendBusyReply).toHaveBeenCalledTimes(1);
    expect(harness.taskRunner.tryStartPrompt).not.toHaveBeenCalled();
  });

  it("keeps the busy reply when explicitly non-steerable input discovers a busy task reservation", async () => {
    const harness = createPromptHarness({
      taskRunnerResult: "busy",
      trySteer: vi.fn().mockResolvedValue(true),
    });

    await expect(harness.runInput({
      text: "transcribed prompt",
      allowSteering: false,
    })).resolves.toBe(false);

    expect(harness.trySteer).not.toHaveBeenCalled();
    expect(harness.sendBusyReply).toHaveBeenCalledTimes(1);
    expect(harness.taskRunner.tryStartPrompt).toHaveBeenCalledTimes(1);
  });

  it("reports steering failures without starting a second prompt flow", async () => {
    const harness = createPromptHarness({
      isBusy: () => true,
      trySteer: vi.fn().mockRejectedValue(new Error("queue unavailable")),
    });

    await expect(harness.runInput({ text: "check the logs" })).resolves.toBe(true);

    expect(harness.taskRunner.tryStartPrompt).not.toHaveBeenCalled();
    expect(harness.sendBusyReply).not.toHaveBeenCalled();
    expect(harness.operations).toEqual([
      expect.objectContaining({ kind: "send", text: expect.stringContaining("Steering failed"), }),
    ]);
  });

  it.each([
    ["Pi slash commands", { preloadedSlashCommands: [] }],
    ["image prompts", { images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] }],
  ])("keeps the busy reply for %s instead of steering", async (_kind, input) => {
    const harness = createPromptHarness({
      isBusy: () => true,
      trySteer: vi.fn().mockResolvedValue(true),
    });

    await expect(harness.runInput(input)).resolves.toBe(false);

    expect(harness.trySteer).not.toHaveBeenCalled();
    expect(harness.sendBusyReply).toHaveBeenCalledTimes(1);
    expect(harness.taskRunner.tryStartPrompt).not.toHaveBeenCalled();
  });

  it("waits for completion when requested", async () => {
    const promptRelease = deferred();
    const promptStarted = deferred();
    const harness = createPromptHarness({
      onPrompt: async (callbacks) => {
        promptStarted.resolve();
        await promptRelease.promise;
        callbacks.onAgentEnd();
      },
    });

    let settled = false;
    const result = harness.run().then((value) => {
      settled = true;
      return value;
    });

    await promptStarted.promise;
    expect(settled).toBe(false);

    promptRelease.resolve();
    await expect(result).resolves.toBe(true);
  });

  it("keeps delivery, typing, and Abort ownership active after agent end until prompt settles", async () => {
    vi.useFakeTimers();
    const promptRelease = deferred();
    const promptStarted = deferred<PiSessionCallbacks>();
    const harness = createPromptHarness({
      typingIntervalMs: 4_500,
      onPrompt: async (callbacks) => {
        promptStarted.resolve(callbacks);
        await promptRelease.promise;
      },
    });

    try {
      const result = harness.run();
      const callbacks = await promptStarted.promise;

      callbacks.onAgentEnd();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.operations).toContainEqual(expect.objectContaining({
        kind: "send",
        messageId: 1,
        text: expect.stringMatching(/Working/i),
        hasAbort: true,
      }));

      callbacks.onThinkingDelta({ blockKey: "late-thinking", delta: "late thought" });
      await vi.advanceTimersByTimeAsync(0);
      await harness.waitForOperation(
        (operation) => operation.kind === "edit" && operation.messageId === 1 && operation.text.includes("late thought"),
      );

      callbacks.onTextDelta("late answer");
      await vi.advanceTimersByTimeAsync(0);
      await harness.waitForOperation(
        (operation) => operation.kind === "send" && operation.messageId === 2 && operation.text.includes("late answer"),
      );

      const typingBeforeInterval = harness.operations.filter((operation) => operation.kind === "typing").length;
      await vi.advanceTimersByTimeAsync(4_500);
      expect(harness.operations.filter((operation) => operation.kind === "typing")).toHaveLength(typingBeforeInterval + 1);

      promptRelease.resolve();
      await expect(result).resolves.toBe(true);
      expect(harness.operations).toContainEqual(expect.objectContaining({
        kind: "edit",
        messageId: 1,
        text: expect.stringContaining("late thought"),
      }));
    } finally {
      promptRelease.resolve();
      vi.useRealTimers();
    }
  });

  it("sends typing before session activation finishes", async () => {
    const activation = deferred<unknown>();
    const harness = createPromptHarness({
      ensureActiveSession: () => activation.promise,
    });

    await harness.run(false);
    await harness.waitForOperation((operation) => operation.kind === "typing");
    expect(harness.operations.filter((operation) => operation.kind === "typing")).toHaveLength(1);

    activation.resolve(undefined);
    await harness.task();
  });

  it("keeps Abort hidden until extension binding succeeds, then publishes it before prompting", async () => {
    const bindingStarted = deferred();
    const bindingRelease = deferred();
    const promptRelease = deferred();
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onBindExtensions: async () => {
        bindingStarted.resolve();
        await bindingRelease.promise;
      },
      onPrompt: async () => {
        expect(harness.operations).toContainEqual(expect.objectContaining({
          kind: "send",
          messageId: 1,
          text: expect.stringMatching(/Working/i),
          hasAbort: true,
        }));
        promptRelease.resolve();
      },
    });

    await expect(harness.run(false)).resolves.toBe(true);
    await bindingStarted.promise;
    expect(harness.operations).not.toContainEqual(expect.objectContaining({
      kind: "send",
      text: expect.stringMatching(/Working/i),
      hasAbort: true,
    }));
    expect(harness.prompt).not.toHaveBeenCalled();
    expect(harness.operations).toContainEqual(expect.objectContaining({ kind: "typing" }));

    bindingRelease.resolve();
    await harness.task();
    expect(harness.prompt).toHaveBeenCalledTimes(1);
  });

  it("shows Abort while a prompt has no visible output", async () => {
    const promptRelease = deferred();
    const promptStarted = deferred();
    const harness = createPromptHarness({
      onPrompt: async () => {
        promptStarted.resolve();
        await promptRelease.promise;
      },
    });

    const result = harness.run();
    await promptStarted.promise;

    expect(harness.operations).toContainEqual(expect.objectContaining({
      kind: "send",
      messageId: 1,
      text: expect.stringMatching(/Working/i),
      hasAbort: true,
    }));

    promptRelease.resolve();
    await expect(result).resolves.toBe(true);
  });

  it("edits the working message into the first Agent activity", async () => {
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onPrompt: async (callbacks) => {
        callbacks.onToolStart("Agent", "agent-1", { description: "Inspect code" });
        await harness.waitForOperation(
          (operation) => operation.kind === "edit"
            && operation.messageId === 1
            && operation.text.includes("Agent"),
        );
      },
    });

    await expect(harness.run()).resolves.toBe(true);
    expect(harness.operations).toContainEqual(expect.objectContaining({
      kind: "edit",
      messageId: 1,
      hasAbort: true,
    }));
    expect(harness.operations.filter((operation) => operation.kind === "send")).toHaveLength(1);
  });

  it("edits the working message into the first assistant output when activity is disabled", async () => {
    const harness = createPromptHarness({
      activityEnabled: false,
      onPrompt: (callbacks) => callbacks.onTextDelta("answer"),
    });

    await expect(harness.run()).resolves.toBe(true);
    expect(harness.operations).toContainEqual(expect.objectContaining({
      kind: "edit",
      messageId: 1,
      text: expect.stringContaining("answer"),
      hasAbort: true,
    }));
  });

  it("adopts the working message for the first chunk and migrates Abort on rollover", async () => {
    const harness = createPromptHarness({
      onPrompt: (callbacks) => callbacks.onThinkingDelta({ blockKey: "1", delta: "x".repeat(4_100) }),
    });

    await expect(harness.run()).resolves.toBe(true);
    expect(harness.operations).toContainEqual(expect.objectContaining({ kind: "edit", messageId: 1, hasAbort: true }));
    expect(harness.operations).toContainEqual(expect.objectContaining({ kind: "send", messageId: 2 }));
    expect(harness.operations).toContainEqual(expect.objectContaining({ kind: "markup", messageId: 2, hasAbort: true }));
    expect(harness.operations).toContainEqual(expect.objectContaining({ kind: "markup", messageId: 1, hasAbort: false }));
  });

  it("deletes an unused working message after silent success", async () => {
    const harness = createPromptHarness({ onPrompt: () => {} });

    await expect(harness.run()).resolves.toBe(true);
    expect(harness.operations).toContainEqual({ kind: "delete", messageId: 1 });
    expect(harness.operations.filter((operation) => operation.kind === "edit")).toEqual([]);
  });

  it.each([
    ["failure", new Error("prompt failed")],
    ["abort", new Error("Abort requested by user")],
  ])("edits an unused working message for early %s", async (_name, promptError) => {
    const harness = createPromptHarness({ promptError });

    await expect(harness.run()).resolves.toBe(false);
    expect(harness.operations).toContainEqual(expect.objectContaining({
      kind: "edit",
      messageId: 1,
      text: expect.stringMatching(/failed|aborted/i),
    }));
    expect(harness.operations.filter((operation) => operation.kind === "send")).toHaveLength(1);
  });

  it("falls back to first-output Abort ownership when the working message fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let sendCount = 0;
    const harness = createPromptHarness({
      onSend: () => {
        sendCount += 1;
        if (sendCount === 1) {
          throw new Error("working send failed");
        }
      },
      onPrompt: (callbacks) => callbacks.onTextDelta("answer"),
    });

    try {
      await expect(harness.run()).resolves.toBe(true);
      expect(harness.operations).toContainEqual(expect.objectContaining({
        kind: "send",
        messageId: 2,
        text: expect.stringContaining("answer"),
        hasAbort: true,
      }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each(["all", "errors-only"] as const)(
    "puts Abort on the initial activity-off %s tool output when Working delivery fails",
    async (toolVerbosity) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      let sendCount = 0;
      let harness!: ReturnType<typeof createPromptHarness>;
      harness = createPromptHarness({
        activityEnabled: false,
        toolVerbosity,
        onSend: () => {
          sendCount += 1;
          if (sendCount === 1) {
            throw new Error("working send failed");
          }
        },
        onPrompt: (callbacks) => {
          callbacks.onToolStart("bash", "tool-1", {});
          callbacks.onToolUpdate("tool-1", "stderr");
          callbacks.onToolEnd("tool-1", true);
        },
      });

      try {
        await expect(harness.run()).resolves.toBe(true);
        const toolMessage = harness.operations.find(
          (operation) => operation.kind === "send"
            && (toolVerbosity === "all" ? operation.text.includes("Running:") : operation.text.includes("❌")),
        );
        expect(toolMessage).toMatchObject({ messageId: 2, hasAbort: true });
        expect(harness.trackCallbackMessages).toEqual([2]);
        expect(harness.markupAttempts).not.toContainEqual({ messageId: 2, hasAbort: true });
      } finally {
        consoleError.mockRestore();
      }
    },
  );

  it("preserves chronological activity-first output after adopting the working message", async () => {
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onPrompt: async (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "thinking-1", delta: "first thought" });
        await harness.waitForOperation(
          (operation) => operation.kind === "edit" && operation.messageId === 1 && operation.text.includes("first thought"),
        );

        callbacks.onTextDelta("first answer");
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 2 && operation.text.includes("first answer"),
        );

        callbacks.onTextDelta(" extended");
        await harness.waitForOperation(
          (operation) => operation.kind === "edit" && operation.messageId === 2 && operation.text.includes("extended"),
        );

        callbacks.onThinkingDelta({ blockKey: "thinking-2", delta: "second thought" });
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 3 && operation.text.includes("second thought"),
        );

        callbacks.onTextDelta("final answer");
        callbacks.onAgentEnd();
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    const outputSends = harness.operations.filter(
      (operation): operation is Extract<TelegramOperation, { kind: "send" }> => operation.kind === "send",
    );
    expect(outputSends.map((operation) => operation.messageId)).toEqual([1, 2, 3, 4]);
    expect(outputSends.map((operation) => operation.text)).toEqual([
      expect.stringMatching(/Working/i),
      expect.stringContaining("first answer"),
      expect.stringContaining("second thought"),
      expect.stringContaining("final answer"),
    ]);
    expect(harness.operations).toContainEqual(expect.objectContaining({
      kind: "edit",
      messageId: 1,
      text: expect.stringContaining("first thought"),
      hasAbort: true,
    }));
    expect(outputSends[0]).toMatchObject({ hasAbort: true });

    const adjacentAssistantEdits = harness.operations.filter(
      (operation): operation is Extract<TelegramOperation, { kind: "edit" }> =>
        operation.kind === "edit" && operation.text.includes("extended"),
    );
    expect(adjacentAssistantEdits).toEqual([
      expect.objectContaining({ messageId: 2 }),
    ]);
  });

  it("edits the Agent activity message with live progress", async () => {
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onPrompt: async (callbacks) => {
        callbacks.onToolStart("Agent", "agent-1", { description: "Find relevant code" });
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 1,
        );
        callbacks.onToolUpdate("agent-1", {
          details: { activity: "running command…" },
        });
        await harness.waitForOperation(
          (operation) => operation.kind === "edit"
            && operation.messageId === 1
            && operation.text.includes("running command"),
        );
        callbacks.onToolEnd("agent-1", false);
      },
    });

    await expect(harness.run()).resolves.toBe(true);
    expect(harness.operations).toContainEqual(expect.objectContaining({
      kind: "edit",
      messageId: 1,
      text: expect.stringContaining("Done"),
    }));
    expect(harness.operations.filter(
      (operation) => operation.kind === "send",
    )).toHaveLength(1);
  });

  it("settles Agent progress without discarding a delivered activity chunk", async () => {
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onPrompt: async (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "1:0", delta: "x".repeat(3_900) });
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 1,
        );
        callbacks.onToolStart("Agent", "agent-1", { description: "Find relevant code" });
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 2,
        );
        callbacks.onToolUpdate("agent-1", {
          details: { activity: "running command ".repeat(30) },
        });
        await harness.waitForOperation(
          (operation) => operation.kind === "edit"
            && operation.messageId === 2
            && operation.text.includes("running command"),
        );
        callbacks.onToolEnd("agent-1", false);
      },
    });

    await expect(harness.run()).resolves.toBe(true);
    expect(harness.operations).toContainEqual(expect.objectContaining({
      kind: "edit",
      messageId: 2,
      text: expect.stringContaining("Done"),
    }));
  });

  it("keeps structured tool updates readable when activity is disabled", async () => {
    const harness = createPromptHarness({
      activityEnabled: false,
      toolVerbosity: "all",
      onPrompt: (callbacks) => {
        callbacks.onToolStart("Agent", "agent-1", {});
        callbacks.onToolUpdate("agent-1", {
          details: { activity: "running command…" },
        });
        callbacks.onToolEnd("agent-1", true);
      },
    });

    await expect(harness.run()).resolves.toBe(true);
    expect(harness.operations).toContainEqual(expect.objectContaining({
      kind: "edit",
      messageId: 1,
      text: expect.stringContaining("running command"),
    }));
  });

  it("keeps structured error updates readable in errors-only mode", async () => {
    const harness = createPromptHarness({
      activityEnabled: false,
      toolVerbosity: "errors-only",
      onPrompt: (callbacks) => {
        callbacks.onToolStart("Agent", "agent-1", {});
        callbacks.onToolUpdate("agent-1", {
          details: { activity: "running command…" },
        });
        callbacks.onToolEnd("agent-1", true);
      },
    });

    await expect(harness.run()).resolves.toBe(true);
    expect(harness.operations).toContainEqual(expect.objectContaining({
      kind: "edit",
      messageId: 1,
      text: expect.stringContaining("running command"),
    }));
  });

  it.each([
    [true, "all"],
    [false, "all"],
    [false, "summary"],
    [false, "errors-only"],
  ] as const)(
    "removes Working without rendering ask_user activity with activity=%s and verbosity=%s",
    async (activityEnabled, toolVerbosity) => {
      const harness = createPromptHarness({
        activityEnabled,
        toolVerbosity,
        onPrompt: (callbacks) => {
          callbacks.onToolStart("ask_user", "question-1", { question: "Choose one" });
          callbacks.onToolUpdate("question-1", "waiting for input");
          callbacks.onToolEnd("question-1", true);
        },
      });

      await expect(harness.run()).resolves.toBe(true);
      expect(harness.operations).toContainEqual(expect.objectContaining({
        kind: "send",
        messageId: 1,
        text: expect.stringMatching(/Working/i),
        hasAbort: true,
      }));
      expect(harness.operations).toContainEqual({ kind: "delete", messageId: 1 });
      expect(harness.operations.filter(
        (operation) => (operation.kind === "send" || operation.kind === "edit")
          && /ask[ _]user/i.test(operation.text),
      )).toEqual([]);
    },
  );

  it.each(["select", "confirm", "input"] as const)(
    "deletes Working before opening ask_user %s dialog",
    async (method) => {
      let harness!: ReturnType<typeof createPromptHarness>;
      harness = createPromptHarness({
        onOpenDialog: (openedMethod) => {
          expect(openedMethod).toBe(method);
          expect(harness.operations).toContainEqual({ kind: "delete", messageId: 1 });
        },
        onPrompt: async (callbacks) => {
          callbacks.onToolStart("ask_user", "question-1", { question: "Choose one" });
          if (method === "select") {
            await harness.ui()!.select("Choose one", ["Yes", "No"]);
          } else if (method === "confirm") {
            await harness.ui()!.confirm("Choose one", "Continue?");
          } else {
            await harness.ui()!.input("Choose one", "Type a response");
          }
          callbacks.onToolEnd("question-1", false);
        },
      });

      await expect(harness.run()).resolves.toBe(true);
    },
  );

  it("waits for the in-flight Working deletion before opening ask_user", async () => {
    const deleteRelease = deferred();
    let deleteCompleted = false;
    let dialogOpenedBeforeDelete = false;
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onDelete: async () => {
        await deleteRelease.promise;
        deleteCompleted = true;
      },
      onOpenDialog: () => {
        dialogOpenedBeforeDelete = !deleteCompleted;
      },
      onPrompt: async (callbacks) => {
        callbacks.onToolStart("ask_user", "question-1", { question: "Choose one" });
        const select = harness.ui()!.select("Choose one", ["Yes", "No"]);
        await harness.waitForOperation((operation) => operation.kind === "delete" && operation.messageId === 1);
        deleteRelease.resolve();
        await select;
        callbacks.onToolEnd("question-1", false);
      },
    });

    await expect(harness.run()).resolves.toBe(true);
    expect(dialogOpenedBeforeDelete).toBe(false);
  });

  it("keeps a Working message as the failure target when dialog deletion rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onDelete: () => Promise.reject(new Error("delete rejected")),
      onPrompt: async (callbacks) => {
        callbacks.onToolStart("ask_user", "question-1", { question: "Choose one" });
        await harness.ui()!.select("Choose one", ["Yes", "No"]);
        callbacks.onToolEnd("question-1", false);
        throw new Error("prompt failed");
      },
    });

    try {
      await expect(harness.run()).resolves.toBe(false);
      expect(harness.operations).toContainEqual(expect.objectContaining({
        kind: "edit",
        messageId: 1,
        text: "⚠️ prompt failed",
      }));
      expect(harness.operations.filter(
        (operation) => operation.kind === "send" && operation.text === "⚠️ prompt failed",
      )).toEqual([]);
      expect(harness.operations).toContainEqual({ kind: "markup", messageId: 1, hasAbort: false });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("restores abort ownership when ask_user deletion fails and Working is adopted", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      activityEnabled: false,
      toolVerbosity: "all",
      onDelete: () => Promise.reject(new Error("delete rejected")),
      onPrompt: async (callbacks) => {
        callbacks.onToolStart("ask_user", "question-1", { question: "Choose one" });
        await harness.ui()!.select("Choose one", ["Yes", "No"]);
        callbacks.onToolEnd("question-1", false);

        callbacks.onToolStart("bash", "tool-1", {});
        await harness.waitForOperation(
          (operation) => operation.kind === "edit"
            && operation.messageId === 1
            && operation.text.includes("Running:"),
        );

        callbacks.onToolStart("grep", "tool-2", {});
        await harness.waitForOperation(
          (operation) => operation.kind === "send"
            && operation.messageId === 2
            && operation.text.includes("Running:"),
        );
      },
    });

    try {
      await expect(harness.run()).resolves.toBe(true);
      expect(harness.operations).toContainEqual(expect.objectContaining({
        kind: "edit",
        messageId: 1,
        text: expect.stringContaining("Running:"),
        hasAbort: true,
      }));
      expect(harness.operations).toContainEqual(expect.objectContaining({
        kind: "send",
        messageId: 2,
        text: expect.stringContaining("Running:"),
        hasAbort: false,
      }));
      expect(harness.markupAttempts).toContainEqual({ messageId: 2, hasAbort: true });
      expect(harness.markupAttempts).toContainEqual({ messageId: 1, hasAbort: false });
      expect(harness.trackCallbackMessages).toEqual([1, 2]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("neutralizes Abort on adopted Working content before opening ask_user", async () => {
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onPrompt: async (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "thinking-1", delta: "already visible" });
        await harness.waitForOperation(
          (operation) => operation.kind === "edit" && operation.messageId === 1 && operation.text.includes("already visible"),
        );
        callbacks.onToolStart("ask_user", "question-1", { question: "Choose one" });
        await harness.ui()!.select("Choose one", ["Yes", "No"]);
        callbacks.onToolEnd("question-1", false);
        callbacks.onTextDelta("later answer");
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 2 && operation.hasAbort,
        );
      },
    });

    await expect(harness.run()).resolves.toBe(true);
    expect(harness.operations).not.toContainEqual({ kind: "delete", messageId: 1 });
    expect(harness.operations).toContainEqual({ kind: "markup", messageId: 1, hasAbort: false });
  });

  it("queues ask_user handoff behind in-flight Working adoption", async () => {
    const adoptionRelease = deferred();
    const adoptionStarted = deferred();
    let adoptionCompleted = false;
    let dialogOpenedBeforeAdoption = false;
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onEdit: async (text, messageId) => {
        if (messageId === 1 && text.includes("queued activity")) {
          adoptionStarted.resolve();
          await adoptionRelease.promise;
          adoptionCompleted = true;
        }
      },
      onOpenDialog: () => {
        dialogOpenedBeforeAdoption = !adoptionCompleted;
      },
      onPrompt: async (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "thinking-1", delta: "queued activity" });
        await adoptionStarted.promise;
        callbacks.onToolStart("ask_user", "question-1", { question: "Choose one" });
        const select = harness.ui()!.select("Choose one", ["Yes", "No"]);
        adoptionRelease.resolve();
        await select;
        callbacks.onToolEnd("question-1", false);
      },
    });

    await expect(harness.run()).resolves.toBe(true);
    expect(dialogOpenedBeforeAdoption).toBe(false);
    expect(harness.operations).toContainEqual({ kind: "markup", messageId: 1, hasAbort: false });
  });

  it("keeps Abort absent while ask_user is pending and restores it for later output", async () => {
    let abortAttachedDuringDialog = false;
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onPrompt: async (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "thinking-1", delta: "visible activity" });
        await harness.waitForOperation(
          (operation) => operation.kind === "edit" && operation.messageId === 1 && operation.text.includes("visible activity"),
        );
        callbacks.onToolStart("ask_user", "question-1", { question: "Choose one" });
        await harness.ui()!.select("Choose one", ["Yes", "No"]);
        callbacks.onTextDelta("during dialog");
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 2 && operation.text.includes("during dialog"),
        );
        abortAttachedDuringDialog = harness.markupAttempts.some(
          (attempt) => attempt.messageId === 2 && attempt.hasAbort,
        );
        callbacks.onToolEnd("question-1", false);
        callbacks.onTextDelta(" later output");
        await harness.waitForOperation(
          (operation) => operation.kind === "markup" && operation.messageId === 2 && operation.hasAbort,
        );
      },
    });

    await expect(harness.run()).resolves.toBe(true);
    expect(harness.operations).toContainEqual({ kind: "markup", messageId: 1, hasAbort: false });
    expect(abortAttachedDuringDialog).toBe(false);
    expect(harness.markupAttempts).toContainEqual({ messageId: 2, hasAbort: true });
  });

  it("does not attach Abort to legacy output while ask_user is pending", async () => {
    let legacyOutputHasAbort = true;
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      activityEnabled: false,
      toolVerbosity: "all",
      onPrompt: async (callbacks) => {
        callbacks.onToolStart("ask_user", "question-1", { question: "Choose one" });
        await harness.ui()!.select("Choose one", ["Yes", "No"]);
        callbacks.onToolStart("bash", "tool-1", {});
        const legacyOutput = await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.text.includes("Running:"),
        );
        legacyOutputHasAbort = legacyOutput.hasAbort;
        callbacks.onToolEnd("question-1", false);
        callbacks.onToolEnd("tool-1", false);
      },
    });

    await expect(harness.run()).resolves.toBe(true);
    expect(legacyOutputHasAbort).toBe(false);
  });

  it("sends later assistant output as a newer Abort owner after ask_user resolves", async () => {
    const harness = createPromptHarness({
      activityEnabled: true,
      toolVerbosity: "all",
      onPrompt: (callbacks) => {
        callbacks.onToolStart("ask_user", "question-1", { question: "Choose one" });
        callbacks.onToolUpdate("question-1", "waiting for input");
        callbacks.onToolEnd("question-1", false);
        callbacks.onTextDelta("Answer accepted");
      },
    });

    await expect(harness.run()).resolves.toBe(true);
    const sends = harness.operations.filter(
      (operation): operation is Extract<TelegramOperation, { kind: "send" }> => operation.kind === "send",
    );
    expect(sends).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: 1, text: expect.stringMatching(/Working/i), hasAbort: true }),
      expect.objectContaining({ messageId: 2, text: expect.stringContaining("Answer accepted"), hasAbort: true }),
    ]));
    expect(harness.operations.findIndex((operation) => operation.kind === "delete" && operation.messageId === 1))
      .toBeLessThan(harness.operations.findIndex((operation) => operation.kind === "send" && operation.messageId === 2));
    expect(sends[1].text).not.toMatch(/ask[ _]user/i);
  });

  it("deletes Working and leaves one standard failure visible after ask_user", async () => {
    const harness = createPromptHarness({
      onPrompt: (callbacks) => {
        callbacks.onToolStart("ask_user", "question-1", { question: "Choose one" });
        callbacks.onToolUpdate("question-1", "waiting for input");
        callbacks.onToolEnd("question-1", false);
        throw new Error("prompt failed");
      },
    });

    await expect(harness.run()).resolves.toBe(false);
    expect(harness.operations).toContainEqual({ kind: "delete", messageId: 1 });
    const failure = harness.operations.find(
      (operation) => operation.kind === "send" && operation.text === "⚠️ prompt failed",
    );
    expect(failure).toMatchObject({ kind: "send", messageId: 2, hasAbort: false });
    expect(harness.operations.filter(
      (operation) => operation.kind === "edit" && operation.messageId === 1,
    )).toEqual([]);
    expect(harness.operations.filter(
      (operation) => (operation.kind === "send" || operation.kind === "edit")
        && /ask[ _]user/i.test(operation.text),
    )).toEqual([]);
  });

  it("gives the first assistant output Abort ownership", async () => {
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      activityEnabled: false,
      onPrompt: async (callbacks) => {
        callbacks.onTextDelta("assistant first");
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 1 && operation.hasAbort,
        );
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    expect(harness.trackCallbackMessages).toEqual([1]);
    expect(harness.operations.filter(
      (operation) => operation.kind === "markup" && !operation.hasAbort,
    ).at(-1)).toMatchObject({ messageId: 1 });
  });

  it("deletes the working message for silent success", async () => {
    const harness = createPromptHarness({
      onPrompt: (callbacks) => {
        callbacks.onAgentEnd();
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    expect(harness.operations.filter((operation) => operation.kind === "send" || operation.kind === "edit")).toEqual([
      expect.objectContaining({ kind: "send", messageId: 1, text: expect.stringMatching(/Working/i) }),
    ]);
    expect(harness.operations).toContainEqual({ kind: "delete", messageId: 1 });
  });

  it("gives the first activity output Abort ownership without a follow-up markup edit", async () => {
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onPrompt: async (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "1", delta: "activity" });
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 1 && operation.hasAbort,
        );
        callbacks.onAgentEnd();
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    expect(harness.operations).not.toContainEqual(
      expect.objectContaining({ kind: "markup", messageId: 1, hasAbort: true }),
    );
    expect(harness.trackCallbackMessages).toEqual([1]);
    expect(harness.operations.filter(
      (operation): operation is Extract<TelegramOperation, { kind: "markup" }> =>
        operation.kind === "markup" && !operation.hasAbort,
    ).at(-1)).toMatchObject({ messageId: 1 });
  });

  it("migrates the Abort owner on a kind switch and chunk rollover", async () => {
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onPrompt: async (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "1", delta: "activity" });
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 1 && operation.hasAbort,
        );
        callbacks.onTextDelta("assistant");
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 2,
        );
        callbacks.onThinkingDelta({ blockKey: "2", delta: "x".repeat(4_100) });
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 4,
        );
        callbacks.onAgentEnd();
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    const owners = harness.operations.filter(
      (operation): operation is Extract<TelegramOperation, { kind: "markup" }> =>
        operation.kind === "markup" && operation.hasAbort,
    ).map((operation) => operation.messageId);
    expect(owners).toEqual([2, 4]);
    expect(harness.trackCallbackMessages).toEqual([1, 2, 4]);
  });

  it.each([
    ["success", false, true],
    ["failure", true, false],
  ])("cleans a rejected Abort candidate on %s finalization", async (_outcome, promptFails, expectedResult) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const attachAttempted = deferred();
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onMarkup: (messageId, hasAbort) => {
        if (messageId === 2 && hasAbort) {
          attachAttempted.resolve();
          return Promise.reject(new Error("markup applied then rejected"));
        }
      },
      onPrompt: async (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "1", delta: "activity" });
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 1 && operation.hasAbort,
        );
        callbacks.onTextDelta("first answer");
        await attachAttempted.promise;
        if (promptFails) {
          throw new Error("prompt failed");
        }
      },
    });

    try {
      await expect(harness.run()).resolves.toBe(expectedResult);
      expect(harness.trackCallbackMessages).toEqual([1, 2]);
      expect(harness.markupAttempts).toContainEqual({ messageId: 2, hasAbort: true });
      const clearedOwners = harness.operations.filter(
        (operation): operation is Extract<TelegramOperation, { kind: "markup" }> =>
          operation.kind === "markup" && !operation.hasAbort,
      ).map((operation) => operation.messageId);
      expect(clearedOwners).toEqual(expect.arrayContaining([1, 2]));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("cleans every historical Abort owner after an old-owner detach rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failedDetach = new Set<number>();
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onMarkup: (messageId, hasAbort) => {
        if (messageId === 1 && !hasAbort && !failedDetach.has(messageId)) {
          failedDetach.add(messageId);
          return Promise.reject(new Error("detach failed"));
        }
      },
      onPrompt: async (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "1", delta: "activity" });
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 1 && operation.hasAbort,
        );
        callbacks.onTextDelta("assistant");
        await harness.waitForOperation(
          (operation) => operation.kind === "markup" && operation.messageId === 2 && operation.hasAbort,
        );
        callbacks.onAgentEnd();
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    const clearedOwners = harness.operations.filter(
      (operation): operation is Extract<TelegramOperation, { kind: "markup" }> =>
        operation.kind === "markup" && !operation.hasAbort,
    ).map((operation) => operation.messageId);
    try {
      expect(clearedOwners).toEqual(expect.arrayContaining([1, 2]));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps typing for the prompt lifetime and refreshes after output sends", async () => {
    vi.useFakeTimers();
    const promptRelease = deferred();
    const promptStarted = deferred<PiSessionCallbacks>();
    const harness = createPromptHarness({
      typingIntervalMs: 4_500,
      onPrompt: async (callbacks) => {
        promptStarted.resolve(callbacks);
        await promptRelease.promise;
        callbacks.onAgentEnd();
      },
    });

    try {
      const result = harness.run();
      const callbacks = await promptStarted.promise;
      const typingAfterStart = harness.operations.filter((operation) => operation.kind === "typing").length;
      expect(typingAfterStart).toBe(2);

      callbacks.onTextDelta("answer");
      await vi.advanceTimersByTimeAsync(0);
      const typingAfterOutput = harness.operations.filter((operation) => operation.kind === "typing").length;
      expect(typingAfterOutput).toBeGreaterThan(typingAfterStart);

      await vi.advanceTimersByTimeAsync(9_000);
      expect(harness.operations.filter((operation) => operation.kind === "typing")).toHaveLength(typingAfterOutput + 2);

      promptRelease.resolve();
      await expect(result).resolves.toBe(true);
      const typingAfterSettlement = harness.operations.filter((operation) => operation.kind === "typing").length;
      await vi.advanceTimersByTimeAsync(9_000);
      expect(harness.operations.filter((operation) => operation.kind === "typing")).toHaveLength(typingAfterSettlement);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["prompt failure", new Error("prompt failed")],
    ["abort settlement", new Error("aborted")],
  ])("ends the typing lifetime after %s", async (_scenario, promptError) => {
    vi.useFakeTimers();
    const harness = createPromptHarness({ typingIntervalMs: 4_500, promptError });

    try {
      await expect(harness.run()).resolves.toBe(false);
      expect(harness.operations.filter(
        (operation) => operation.kind === "send" || operation.kind === "edit",
      )).toHaveLength(2);
      const typingAfterSettlement = harness.operations.filter((operation) => operation.kind === "typing").length;
      await vi.advanceTimersByTimeAsync(9_000);
      expect(harness.operations.filter((operation) => operation.kind === "typing")).toHaveLength(typingAfterSettlement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the typing lifetime after activation failure", async () => {
    vi.useFakeTimers();
    const harness = createPromptHarness({
      typingIntervalMs: 4_500,
      ensureActiveSession: async () => undefined,
    });

    try {
      await expect(harness.run()).resolves.toBe(false);
      const typingAfterSettlement = harness.operations.filter((operation) => operation.kind === "typing").length;
      await vi.advanceTimersByTimeAsync(9_000);
      expect(harness.operations.filter((operation) => operation.kind === "typing")).toHaveLength(typingAfterSettlement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the delivery worker before success cleanup and leaves no timer operation", async () => {
    vi.useFakeTimers();
    const firstSegmentSend = deferred();
    const firstSegmentStarted = deferred();
    const promptRelease = deferred();
    const promptStarted = deferred<PiSessionCallbacks>();
    const harness = createPromptHarness({
      editDebounceMs: 10,
      onEdit: async (text, messageId) => {
        if (messageId === 1 && text.includes("first activity")) {
          firstSegmentStarted.resolve();
          await firstSegmentSend.promise;
        }
      },
      onPrompt: async (callbacks) => {
        promptStarted.resolve(callbacks);
        callbacks.onThinkingDelta({ blockKey: "1", delta: "first activity" });
        await promptRelease.promise;
      },
    });

    try {
      const result = harness.run();
      const callbacks = await promptStarted.promise;
      await vi.advanceTimersByTimeAsync(10);
      await firstSegmentStarted.promise;
      callbacks.onTextDelta("later answer");
      await vi.advanceTimersByTimeAsync(10);
      callbacks.onAgentEnd();
      promptRelease.resolve();

      expect(harness.operations).not.toContainEqual(
        expect.objectContaining({ kind: "markup", messageId: 1, hasAbort: false }),
      );

      firstSegmentSend.resolve();
      await expect(result).resolves.toBe(true);
      expect(harness.operations).toContainEqual(
        expect.objectContaining({ kind: "send", messageId: 2, text: expect.stringContaining("later answer") }),
      );
      expect(harness.operations).toContainEqual(
        expect.objectContaining({ kind: "markup", messageId: 1, hasAbort: false }),
      );

      const operationCount = harness.operations.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.operations).toHaveLength(operationCount);
    } finally {
      firstSegmentSend.resolve();
      promptRelease.resolve();
      vi.useRealTimers();
    }
  });

  it("reports one terminal failure after an activity delivery failure while delivering later assistant segments", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const activitySendAttempted = deferred();
    const harness = createPromptHarness({
      onEdit: (text, messageId) => {
        if (messageId === 1 && text.includes("activity")) {
          activitySendAttempted.resolve();
          return Promise.reject(new Error("activity delivery failed"));
        }
      },
      onPrompt: async (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "1", delta: "activity" });
        await activitySendAttempted.promise;
        callbacks.onTextDelta("assistant answer");
        callbacks.onAgentEnd();
      },
    });

    try {
      await expect(harness.run()).resolves.toBe(false);
      expect(harness.operations).toContainEqual(
        expect.objectContaining({ kind: "edit", messageId: 1, text: expect.stringContaining("assistant answer") }),
      );
      expect(harness.operations.filter(
        (operation) => operation.kind === "send" && operation.text.includes("activity delivery failed"),
      )).toHaveLength(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each(["all", "errors-only"] as const)(
    "reports one terminal failure after an activity-off %s tool delivery failure while delivering assistant text",
    async (toolVerbosity) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const toolDeliveryText = toolVerbosity === "all" ? "Running:" : "❌";
      const harness = createPromptHarness({
        activityEnabled: false,
        toolVerbosity,
        onEdit: (text, messageId) => {
          if (messageId === 1 && text.includes(toolDeliveryText)) {
            return Promise.reject(new Error("activity-off tool delivery failed"));
          }
        },
        onPrompt: (callbacks) => {
          callbacks.onToolStart("bash", "tool-1", {});
          callbacks.onToolUpdate("tool-1", "stderr");
          if (toolVerbosity === "errors-only") {
            callbacks.onToolEnd("tool-1", true);
          }
          callbacks.onTextDelta("assistant answer");
          if (toolVerbosity === "all") {
            callbacks.onToolEnd("tool-1", true);
          }
          callbacks.onAgentEnd();
        },
      });

      try {
        await expect(harness.run()).resolves.toBe(false);
        expect(harness.operations).toContainEqual(
          expect.objectContaining({ kind: "edit", messageId: 1, text: expect.stringContaining("assistant answer") }),
        );
        expect(harness.operations.filter(
          (operation) => operation.kind === "send" && operation.text.includes("activity-off tool delivery failed"),
        )).toHaveLength(1);
      } finally {
        consoleError.mockRestore();
      }
    },
  );

  it("edits the working message with an assistant delivery failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createPromptHarness({
      onEdit: (text, messageId) => {
        if (messageId === 1 && text.includes("assistant answer")) {
          return Promise.reject(new Error("assistant delivery failed"));
        }
      },
      onPrompt: (callbacks) => {
        callbacks.onTextDelta("assistant answer");
        callbacks.onAgentEnd();
      },
    });

    try {
      await expect(harness.run()).resolves.toBe(false);
      expect(harness.operations).toContainEqual(expect.objectContaining({
        kind: "edit",
        messageId: 1,
        text: expect.stringContaining("assistant delivery failed"),
      }));
      expect(harness.operations.filter(
        (operation) => operation.kind === "send" || operation.kind === "edit",
      )).toHaveLength(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("finalizes a summary-only tool prompt without waiting for debounce timers", async () => {
    vi.useFakeTimers();
    const harness = createPromptHarness({
      activityEnabled: false,
      toolVerbosity: "summary",
      editDebounceMs: 1_000,
      onPrompt: (callbacks) => {
        callbacks.onToolStart("read", "tool-1", { path: "src/a.ts" });
      },
    });

    try {
      expect(await settlesWithinMicrotasks(harness.run())).toEqual({ settled: true, value: true, error: undefined });
      expect(harness.operations).toContainEqual(
        expect.objectContaining({ kind: "edit", messageId: 1, text: expect.stringContaining("🔧 1 tool used: read"), hasAbort: true }),
      );
      expect(harness.operations).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "markup", messageId: 1, hasAbort: false }),
      ]));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps post-tool text and its summary out of the delivered pre-tool message", async () => {
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      activityEnabled: false,
      toolVerbosity: "summary",
      onPrompt: async (callbacks) => {
        callbacks.onTextDelta("I'll inspect first.");
        await harness.waitForOperation(
          (operation) => operation.kind === "edit"
            && operation.messageId === 1
            && operation.text.includes("I'll inspect first."),
        );
        callbacks.onToolStart("read", "tool-1", { path: "src/index.ts" });
        callbacks.onToolEnd("tool-1", false);
        callbacks.onTextDelta("I found it.");
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    const assistantOperations = harness.operations.filter(
      (operation): operation is Extract<TelegramOperation, { kind: "send" | "edit" }> =>
        (operation.kind === "send" || operation.kind === "edit")
        && operation.text.includes("Assistant"),
    );
    const preToolOperation = assistantOperations.find(
      (operation) => operation.text.includes("I'll inspect first."),
    );
    const postToolOperation = assistantOperations.find(
      (operation) => operation.text.includes("I found it.") && operation.text.includes("🔧 1 tool used: read"),
    );

    expect(preToolOperation).toBeDefined();
    expect(postToolOperation).toBeDefined();
    expect(preToolOperation?.text).not.toContain("I found it.");
    expect(preToolOperation?.text).not.toContain("🔧 1 tool used: read");
    expect(postToolOperation?.messageId).not.toBe(preToolOperation?.messageId);
  });

  it("emits a tool summary after a sealed assistant segment", async () => {
    const harness = createPromptHarness({
      activityEnabled: false,
      toolVerbosity: "summary",
      onPrompt: (callbacks) => {
        callbacks.onTextDelta("I'll inspect first.");
        callbacks.onToolStart("read", "tool-1", { path: "src/index.ts" });
        callbacks.onToolEnd("tool-1", false);
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    const assistantOperations = harness.operations.filter(
      (operation): operation is Extract<TelegramOperation, { kind: "send" | "edit" }> =>
        (operation.kind === "send" || operation.kind === "edit")
        && operation.text.includes("Assistant"),
    );
    expect(assistantOperations.map((operation) => operation.text)).toEqual([
      expect.stringContaining("I'll inspect first."),
      expect.stringContaining("🔧 1 tool used: read"),
    ]);
    expect(assistantOperations[1]?.messageId).not.toBe(assistantOperations[0]?.messageId);
  });

  it("preserves summary tool verbosity after adopting the working message", async () => {
    const harness = createPromptHarness({
      activityEnabled: false,
      onPrompt: (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "1", delta: "hidden thinking" });
        callbacks.onToolStart("read", "tool-1", { path: "src/a.ts" });
        callbacks.onTextDelta("final answer");
        callbacks.onAgentEnd();
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    const outputText = harness.operations.filter(
      (operation): operation is Extract<TelegramOperation, { kind: "send" | "edit" }> =>
        operation.kind === "send" || operation.kind === "edit",
    ).map((operation) => operation.text).join("\n");
    expect(outputText).toContain("read");
    expect(outputText).not.toContain("hidden thinking");
    expect(outputText).toContain("Working");
  });

  it("preserves onSessionInfoChanged topic synchronization", async () => {
    const harness = createPromptHarness({
      onPrompt: (callbacks) => {
        callbacks.onSessionInfoChanged?.("renamed session");
        callbacks.onAgentEnd();
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    expect(harness.renameForumTopicToSessionName).toHaveBeenCalledWith(
      { chatId: 123 },
      expect.objectContaining({ sessionName: "renamed session" }),
    );
  });

  it("keeps delivered plain assistant chunks when later deltas become rich Markdown", async () => {
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onPrompt: async (callbacks) => {
        callbacks.onTextDelta("plain ".repeat(1_500));
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 3,
        );

        callbacks.onTextDelta("\n# Report");
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    const assistantMessages = new Map<number, string>();
    for (const operation of harness.operations) {
      if (operation.kind === "send" || operation.kind === "edit") {
        assistantMessages.set(operation.messageId, operation.text);
      }
    }

    expect([...assistantMessages.keys()]).toEqual([1, 2, 3]);
    expect(assistantMessages.get(3)).toContain("# Report");
    expect(harness.operations.filter(
      (operation) => operation.kind === "send" || operation.kind === "edit",
    ).every((operation) => operation.delivery === "plain")).toBe(true);
  });

  it.each([
    ["extension binding", { bindExtensionsError: new Error("bind failed") }],
    ["event subscription", { subscribeError: new Error("subscribe failed") }],
  ])("reports the failure and finalizes typing when %s rejects before Abort is published", async (_phase, failure) => {
    vi.useFakeTimers();
    const harness = createPromptHarness({ typingIntervalMs: 4_500, ...failure });

    try {
      await expect(harness.run()).resolves.toBe(false);
      expect(harness.operations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "send",
          messageId: 1,
          text: expect.stringMatching(/bind failed|subscribe failed/),
          hasAbort: false,
        }),
      ]));
      expect(harness.operations).not.toContainEqual(expect.objectContaining({
        kind: "send",
        text: expect.stringMatching(/Working/i),
        hasAbort: true,
      }));

      const typingAfterSettlement = harness.operations.filter((operation) => operation.kind === "typing").length;
      await vi.advanceTimersByTimeAsync(9_000);
      expect(harness.operations.filter((operation) => operation.kind === "typing")).toHaveLength(typingAfterSettlement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for deferred all-mode tool delivery before cleanup", async () => {
    const toolStartRelease = deferred();
    const toolStartStarted = deferred();
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      activityEnabled: false,
      toolVerbosity: "all",
      onEdit: async (text, messageId) => {
        if (messageId === 1 && text.includes("Running:")) {
          toolStartStarted.resolve();
          await toolStartRelease.promise;
        }
      },
      onPrompt: async (callbacks) => {
        callbacks.onToolStart("bash", "tool-1", {});
        await toolStartStarted.promise;
        callbacks.onToolUpdate("tool-1", "stderr");
        callbacks.onToolEnd("tool-1", true);
      },
    });

    let settled = false;
    const result = harness.run().then((value) => {
      settled = true;
      return value;
    });
    await toolStartStarted.promise;
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(harness.operations).not.toContainEqual(
      expect.objectContaining({ kind: "markup", messageId: 1, hasAbort: false }),
    );

    toolStartRelease.resolve();
    await expect(result).resolves.toBe(true);

    const workingAbort = harness.operations.findIndex(
      (operation) => operation.kind === "send" && operation.messageId === 1 && operation.hasAbort,
    );
    const toolFinish = harness.operations.findIndex(
      (operation) => operation.kind === "edit" && operation.messageId === 1 && operation.text.includes("❌"),
    );
    const clearWorkingAbort = harness.operations.findIndex(
      (operation) => operation.kind === "markup" && operation.messageId === 1 && !operation.hasAbort,
    );
    expect(workingAbort).toBeGreaterThanOrEqual(0);
    expect(toolFinish).toBeGreaterThan(workingAbort);
    expect(clearWorkingAbort).toBeGreaterThan(toolFinish);
  });

  it.each(["all", "errors-only"] as const)(
    "keeps activity-off %s tool output visibly before later assistant text",
    async (toolVerbosity) => {
      const toolDeliveryRelease = deferred();
      const toolDeliveryStarted = deferred();
      const assistantEmitted = deferred();
      const promptRelease = deferred();
      const toolDeliveryText = toolVerbosity === "all" ? "Running:" : "❌";
      const waitForToolDelivery = async (text: string): Promise<void> => {
        if (text.includes(toolDeliveryText)) {
          toolDeliveryStarted.resolve();
          await toolDeliveryRelease.promise;
        }
      };
      let harness!: ReturnType<typeof createPromptHarness>;
      harness = createPromptHarness({
        activityEnabled: false,
        toolVerbosity,
        onSend: waitForToolDelivery,
        onEdit: waitForToolDelivery,
        onPrompt: async (callbacks) => {
          callbacks.onToolStart("bash", "tool-1", {});
          callbacks.onToolUpdate("tool-1", "stderr");
          if (toolVerbosity === "errors-only") {
            callbacks.onToolEnd("tool-1", true);
          }
          await toolDeliveryStarted.promise;

          callbacks.onTextDelta("later assistant text");
          if (toolVerbosity === "all") {
            callbacks.onToolEnd("tool-1", true);
          }
          assistantEmitted.resolve();
          await promptRelease.promise;
        },
      });

      vi.useFakeTimers();
      try {
        const result = harness.run();
        await toolDeliveryStarted.promise;
        await assistantEmitted.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.operations).not.toContainEqual(
          expect.objectContaining({ text: expect.stringContaining("later assistant text") }),
        );

        toolDeliveryRelease.resolve();
        await vi.advanceTimersByTimeAsync(0);
        await harness.waitForOperation(
          (operation) => (operation.kind === "send" || operation.kind === "edit")
            && operation.text.includes("later assistant text"),
        );
        await harness.waitForOperation(
          (operation) => operation.kind === "markup" && operation.messageId === 2 && operation.hasAbort,
        );
        await harness.waitForOperation(
          (operation) => operation.kind === "markup" && operation.messageId === 1 && !operation.hasAbort,
        );
        const outputOperations = harness.operations.filter(
          (operation): operation is Extract<TelegramOperation, { kind: "send" | "edit" }> =>
            operation.kind === "send" || operation.kind === "edit",
        );
        const toolOutputs = outputOperations.filter((operation) => operation.text.includes(toolDeliveryText));
        const assistantOutput = outputOperations.find((operation) => operation.text.includes("later assistant text"));
        if (!assistantOutput) {
          throw new Error("Expected later assistant text to be delivered");
        }

        expect(toolOutputs).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "edit", messageId: 1 }),
        ]));
        expect(assistantOutput).toMatchObject({ kind: "send", messageId: 2 });
        expect(assistantOutput.messageId).toBeGreaterThan(Math.max(...toolOutputs.map((operation) => operation.messageId)));
        const abortOwners = new Set<number>();
        const ownersAfterMigrations: number[][] = [];
        for (const operation of harness.operations) {
          if (operation.kind === "send" && operation.hasAbort) {
            abortOwners.add(operation.messageId);
          }
          if (operation.kind === "markup") {
            if (operation.hasAbort) {
              abortOwners.add(operation.messageId);
            } else {
              abortOwners.delete(operation.messageId);
              ownersAfterMigrations.push([...abortOwners]);
            }
          }
        }
        expect(ownersAfterMigrations).toEqual([[2]]);
        expect(harness.trackCallbackMessages).toEqual([1, 2]);

        promptRelease.resolve();
        await expect(result).resolves.toBe(true);
        expect(harness.operations.filter(
          (operation): operation is Extract<TelegramOperation, { kind: "send" | "edit" }> =>
            operation.kind === "send" || operation.kind === "edit",
        ).map((operation) => [operation.kind, operation.messageId])).toEqual(
          toolVerbosity === "all"
            ? [["send", 1], ["edit", 1], ["send", 2], ["edit", 1]]
            : [["send", 1], ["edit", 1], ["send", 2]],
        );
        for (const operation of harness.operations) {
          if (operation.kind === "markup" && !operation.hasAbort) {
            abortOwners.delete(operation.messageId);
          }
        }
        expect(abortOwners).toEqual(new Set());
      } finally {
        toolDeliveryRelease.resolve();
        promptRelease.resolve();
        vi.useRealTimers();
      }
    },
  );

  it("waits for deferred errors-only delivery and ignores late tool callbacks after settlement", async () => {
    const toolErrorRelease = deferred();
    const toolErrorStarted = deferred();
    const lateOperationWait = deferred();
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      activityEnabled: false,
      toolVerbosity: "errors-only",
      onEdit: async (text, messageId) => {
        if (messageId === 1 && text.includes("❌")) {
          toolErrorStarted.resolve();
          await toolErrorRelease.promise;
        }
        if (text.includes("late error")) {
          lateOperationWait.resolve();
        }
      },
      onPrompt: async (callbacks) => {
        callbacks.onToolStart("bash", "tool-1", {});
        callbacks.onToolUpdate("tool-1", "stderr");
        callbacks.onToolEnd("tool-1", true);
        await toolErrorStarted.promise;
      },
    });

    let settled = false;
    const result = harness.run().then((value) => {
      settled = true;
      return value;
    });
    await toolErrorStarted.promise;
    await Promise.resolve();

    expect(settled).toBe(false);
    toolErrorRelease.resolve();
    await expect(result).resolves.toBe(true);

    const workingAbort = harness.operations.findIndex(
      (operation) => operation.kind === "send" && operation.messageId === 1 && operation.hasAbort,
    );
    const toolError = harness.operations.findIndex(
      (operation) => operation.kind === "edit" && operation.messageId === 1 && operation.text.includes("❌"),
    );
    const clearWorkingAbort = harness.operations.findIndex(
      (operation) => operation.kind === "markup" && operation.messageId === 1 && !operation.hasAbort,
    );
    expect(workingAbort).toBeGreaterThanOrEqual(0);
    expect(toolError).toBeGreaterThan(workingAbort);
    expect(clearWorkingAbort).toBeGreaterThan(toolError);

    const callbacks = harness.callbacks();
    callbacks?.onToolStart("bash", "late-tool", {});
    callbacks?.onToolUpdate("late-tool", "late error");
    callbacks?.onToolEnd("late-tool", true);
    await Promise.race([
      lateOperationWait.promise,
      new Promise<void>((resolve) => setTimeout(resolve, 20)),
    ]);
    expect(harness.operations.filter(
      (operation) => (operation.kind === "send" || operation.kind === "edit") && operation.text.includes("late error"),
    )).toEqual([]);
  });
});
