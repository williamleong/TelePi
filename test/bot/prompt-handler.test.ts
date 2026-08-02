import { describe, expect, it, vi } from "vitest";

import { createPromptHandler } from "../../src/bot/prompt-handler.js";
import type { PiSessionCallbacks } from "../../src/pi-session.js";

type TelegramOperation =
  | { kind: "send"; messageId: number; text: string; hasAbort: boolean; delivery: "plain" | "rich" }
  | { kind: "edit"; messageId: number; text: string; hasAbort: boolean; delivery: "plain" | "rich" }
  | { kind: "markup"; messageId: number; hasAbort: boolean }
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

function createExtensionDialogs() {
  return {
    openSelect: vi.fn().mockResolvedValue(undefined),
    openConfirm: vi.fn().mockResolvedValue(false),
    openInput: vi.fn().mockResolvedValue(undefined),
  };
}

function createPromptHarness(options: {
  activityEnabled?: boolean;
  toolVerbosity?: "none" | "summary" | "errors-only" | "all";
  editDebounceMs?: number;
  typingIntervalMs?: number;
  onPrompt?: (callbacks: PiSessionCallbacks) => void | Promise<void>;
  promptError?: Error;
  bindExtensionsError?: Error;
  subscribeError?: Error;
  ensureActiveSession?: () => Promise<unknown>;
  onSend?: (text: string, messageId: number) => Promise<void> | void;
  onEdit?: (text: string, messageId: number) => Promise<void> | void;
  onMarkup?: (messageId: number, hasAbort: boolean) => Promise<void> | void;
}) {
  const operations: TelegramOperation[] = [];
  const markupAttempts: Array<{ messageId: number; hasAbort: boolean }> = [];
  const trackCallbackMessages: number[] = [];
  const operationWaiters = new Set<() => void>();
  let callbacks: PiSessionCallbacks | undefined;
  let nextMessageId = 0;
  let taskPromise: Promise<void> | undefined;
  const renameForumTopicToSessionName = vi.fn().mockResolvedValue(undefined);

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

  const fakePiSession = {
    bindExtensions: options.bindExtensionsError
      ? vi.fn().mockRejectedValue(options.bindExtensionsError)
      : vi.fn().mockResolvedValue(undefined),
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

  const handler = createPromptHandler({
    bot: { api: {
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
    } } as any,
    toolVerbosity: options.toolVerbosity ?? "summary",
    isActivityEnabled: () => options.activityEnabled ?? true,
    editDebounceMs: options.editDebounceMs ?? 0,
    typingIntervalMs: options.typingIntervalMs ?? 60_000,
    isBusy: () => false,
    taskRunner: {
      tryStartPrompt(_target, _promptText, task) {
        taskPromise = task().catch(() => {});
        return "started";
      },
    },
    ensureActiveSession: vi.fn(options.ensureActiveSession ?? (async () => fakePiSession)),
    syncChatScopedCommands: vi.fn(),
    refreshChatScopedCommands: vi.fn(),
    extensionDialogs: createExtensionDialogs(),
    trackCallbackMessage: (_target, messageId) => {
      trackCallbackMessages.push(messageId);
    },
    renameForumTopicToSessionName,
    sendBusyReply: vi.fn(),
  });

  return {
    callbacks: () => callbacks,
    markupAttempts,
    operations,
    renameForumTopicToSessionName,
    trackCallbackMessages,
    task: () => taskPromise,
    waitForOperation,
    run: (waitForCompletion = true) => handler(
      {} as any,
      { chatId: 123 },
      "prompt",
      undefined,
      undefined,
      { waitForCompletion },
    ),
  };
}

describe("prompt handler", () => {
  it("waits for completion when requested", async () => {
    const promptRelease = deferred();
    const harness = createPromptHarness({
      onPrompt: async (callbacks) => {
        await promptRelease.promise;
        callbacks.onAgentEnd();
      },
    });

    let settled = false;
    const result = harness.run().then((value) => {
      settled = true;
      return value;
    });

    await harness.waitForOperation((operation) => operation.kind === "send" && operation.messageId === 1);
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
      expect(harness.operations).not.toContainEqual(
        expect.objectContaining({ kind: "edit", messageId: 1, text: expect.stringMatching(/Done/i) }),
      );
      expect(harness.operations).not.toContainEqual(
        expect.objectContaining({ kind: "markup", messageId: 1, hasAbort: false }),
      );

      callbacks.onThinkingDelta({ blockKey: "late-thinking", delta: "late thought" });
      await vi.advanceTimersByTimeAsync(0);
      await harness.waitForOperation(
        (operation) => operation.kind === "send" && operation.messageId === 2 && operation.text.includes("late thought"),
      );

      callbacks.onTextDelta("late answer");
      await vi.advanceTimersByTimeAsync(0);
      await harness.waitForOperation(
        (operation) => operation.kind === "send" && operation.messageId === 3 && operation.text.includes("late answer"),
      );

      const typingBeforeInterval = harness.operations.filter((operation) => operation.kind === "typing").length;
      await vi.advanceTimersByTimeAsync(4_500);
      expect(harness.operations.filter((operation) => operation.kind === "typing")).toHaveLength(typingBeforeInterval + 1);

      promptRelease.resolve();
      await expect(result).resolves.toBe(true);
      expect(harness.operations).toContainEqual(
        expect.objectContaining({ kind: "edit", messageId: 1, text: expect.stringMatching(/Done/i) }),
      );
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

  it("status-only lifecycle preserves chronological output segments", async () => {
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onPrompt: async (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "thinking-1", delta: "first thought" });
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 2,
        );

        callbacks.onTextDelta("first answer");
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 3,
        );

        callbacks.onTextDelta(" extended");
        await harness.waitForOperation(
          (operation) => operation.kind === "edit" && operation.messageId === 3 && operation.text.includes("extended"),
        );

        callbacks.onThinkingDelta({ blockKey: "thinking-2", delta: "second thought" });
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 4,
        );

        callbacks.onTextDelta("final answer");
        callbacks.onAgentEnd();
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    const statusMessages = harness.operations.filter(
      (operation): operation is Extract<TelegramOperation, { kind: "send" | "edit" }> =>
        (operation.kind === "send" || operation.kind === "edit") && operation.messageId === 1,
    );
    expect(statusMessages[0]).toMatchObject({ kind: "send", text: expect.stringMatching(/Working/i), hasAbort: true });
    expect(statusMessages.at(-1)).toMatchObject({ kind: "edit", text: expect.stringMatching(/Done/i) });
    expect(statusMessages.every((operation) => !operation.text.includes("answer"))).toBe(true);

    const outputSends = harness.operations.filter(
      (operation): operation is Extract<TelegramOperation, { kind: "send" }> =>
        operation.kind === "send" && operation.messageId > 1,
    );
    expect(outputSends.map((operation) => operation.messageId)).toEqual([2, 3, 4, 5]);
    expect(outputSends.map((operation) => operation.text)).toEqual([
      expect.stringContaining("first thought"),
      expect.stringContaining("first answer"),
      expect.stringContaining("second thought"),
      expect.stringContaining("final answer"),
    ]);

    const adjacentAssistantEdits = harness.operations.filter(
      (operation): operation is Extract<TelegramOperation, { kind: "edit" }> =>
        operation.kind === "edit" && operation.text.includes("extended"),
    );
    expect(adjacentAssistantEdits).toEqual([
      expect.objectContaining({ messageId: 3 }),
    ]);
  });

  it("edits the Agent activity message with live progress", async () => {
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onPrompt: async (callbacks) => {
        callbacks.onToolStart("Agent", "agent-1", { description: "Find relevant code" });
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 2,
        );
        callbacks.onToolUpdate("agent-1", {
          details: { activity: "running command…" },
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
    expect(harness.operations.filter(
      (operation) => operation.kind === "send" && operation.messageId > 1,
    )).toHaveLength(1);
  });

  it("settles Agent progress without discarding a delivered activity chunk", async () => {
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onPrompt: async (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "1:0", delta: "x".repeat(3_900) });
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 2,
        );
        callbacks.onToolStart("Agent", "agent-1", { description: "Find relevant code" });
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 3,
        );
        callbacks.onToolUpdate("agent-1", {
          details: { activity: "running command ".repeat(30) },
        });
        await harness.waitForOperation(
          (operation) => operation.kind === "edit"
            && operation.messageId === 3
            && operation.text.includes("running command"),
        );
        callbacks.onToolEnd("agent-1", false);
      },
    });

    await expect(harness.run()).resolves.toBe(true);
    expect(harness.operations).toContainEqual(expect.objectContaining({
      kind: "edit",
      messageId: 3,
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
      messageId: 2,
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
      kind: "send",
      messageId: 2,
      text: expect.stringContaining("running command"),
    }));
  });

  it("status-only lifecycle marks a silent prompt done without an output message", async () => {
    const harness = createPromptHarness({
      onPrompt: (callbacks) => {
        callbacks.onAgentEnd();
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    expect(harness.operations.filter((operation) => operation.kind === "send")).toEqual([
      expect.objectContaining({ messageId: 1, text: expect.stringMatching(/Working/i) }),
    ]);
    expect(harness.operations).toContainEqual(
      expect.objectContaining({ kind: "edit", messageId: 1, text: expect.stringMatching(/Done/i) }),
    );
  });

  it("migrates the Abort owner by attaching the output before detaching status", async () => {
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onPrompt: async (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "1", delta: "activity" });
        await harness.waitForOperation(
          (operation) => operation.kind === "markup" && operation.messageId === 2 && operation.hasAbort,
        );
        callbacks.onAgentEnd();
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    const attachOutput = harness.operations.findIndex(
      (operation) => operation.kind === "markup" && operation.messageId === 2 && operation.hasAbort,
    );
    const detachStatus = harness.operations.findIndex(
      (operation) => operation.kind === "markup" && operation.messageId === 1 && !operation.hasAbort,
    );
    expect(attachOutput).toBeGreaterThanOrEqual(0);
    expect(detachStatus).toBeGreaterThan(attachOutput);
    expect(harness.trackCallbackMessages).toEqual(expect.arrayContaining([1, 2]));
  });

  it("migrates the Abort owner on a kind switch and chunk rollover", async () => {
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      onPrompt: async (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "1", delta: "activity" });
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 2,
        );
        callbacks.onTextDelta("assistant");
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 3,
        );
        callbacks.onThinkingDelta({ blockKey: "2", delta: "x".repeat(4_100) });
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 5,
        );
        callbacks.onAgentEnd();
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    const owners = harness.operations.filter(
      (operation): operation is Extract<TelegramOperation, { kind: "markup" }> =>
        operation.kind === "markup" && operation.hasAbort,
    ).map((operation) => operation.messageId);
    expect(owners).toEqual([2, 3, 5]);
    expect(harness.trackCallbackMessages).toEqual([1, 2, 3, 5]);
  });

  it("isolates failed assistant Abort attachment and delivers later assistant deltas", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const attachAttempted = deferred();
    const promptRelease = deferred();
    const harness = createPromptHarness({
      onMarkup: (messageId, hasAbort) => {
        if (messageId === 2 && hasAbort) {
          attachAttempted.resolve();
          return Promise.reject(new Error("attach failed"));
        }
      },
      onPrompt: async (callbacks) => {
        callbacks.onTextDelta("first answer");
        await attachAttempted.promise;
        callbacks.onTextDelta(" extended");
        await promptRelease.promise;
      },
    });

    const result = harness.run();
    await attachAttempted.promise;
    expect(harness.trackCallbackMessages).toEqual([1]);
    expect(harness.operations).not.toContainEqual(
      expect.objectContaining({ kind: "markup", messageId: 1, hasAbort: false }),
    );

    await harness.waitForOperation(
      (operation) => operation.kind === "edit" && operation.messageId === 2 && operation.text.includes("extended"),
    );
    promptRelease.resolve();

    try {
      await expect(result).resolves.toBe(true);
      expect(harness.operations).toContainEqual(
        expect.objectContaining({ kind: "edit", messageId: 1, text: expect.stringMatching(/Done/i) }),
      );
    } finally {
      promptRelease.resolve();
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

  it("keeps typing for the prompt lifetime and refreshes after status and output sends", async () => {
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
      const typingAfterStatus = harness.operations.filter((operation) => operation.kind === "typing").length;
      expect(typingAfterStatus).toBeGreaterThanOrEqual(2);

      callbacks.onTextDelta("answer");
      await vi.advanceTimersByTimeAsync(0);
      const typingAfterOutput = harness.operations.filter((operation) => operation.kind === "typing").length;
      expect(typingAfterOutput).toBeGreaterThan(typingAfterStatus);

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

  it("waits for the delivery worker before status finalization and leaves no timer operation", async () => {
    vi.useFakeTimers();
    const firstSegmentSend = deferred();
    const firstSegmentStarted = deferred();
    const promptRelease = deferred();
    const promptStarted = deferred<PiSessionCallbacks>();
    const harness = createPromptHarness({
      editDebounceMs: 10,
      onSend: async (text, messageId) => {
        if (messageId === 2 && text.includes("first activity")) {
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
        expect.objectContaining({ kind: "edit", messageId: 1, text: expect.stringMatching(/Done/i) }),
      );

      firstSegmentSend.resolve();
      await expect(result).resolves.toBe(true);
      expect(harness.operations).toContainEqual(
        expect.objectContaining({ kind: "send", messageId: 3, text: expect.stringContaining("later answer") }),
      );
      expect(harness.operations).toContainEqual(
        expect.objectContaining({ kind: "edit", messageId: 1, text: expect.stringMatching(/Done/i) }),
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

  it("contains activity delivery failures and continues with later assistant segments", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const activitySendAttempted = deferred();
    const harness = createPromptHarness({
      onSend: (text, messageId) => {
        if (messageId === 2 && text.includes("activity")) {
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
      await expect(harness.run()).resolves.toBe(true);
      expect(harness.operations).toContainEqual(
        expect.objectContaining({ kind: "send", messageId: 3, text: expect.stringContaining("assistant answer") }),
      );
      expect(harness.operations).toContainEqual(
        expect.objectContaining({ kind: "edit", messageId: 1, text: expect.stringMatching(/Done/i) }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("propagates assistant delivery failures into the prompt failure status", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createPromptHarness({
      onSend: (text, messageId) => {
        if (messageId === 2 && text.includes("assistant answer")) {
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
      expect(harness.operations).toContainEqual(
        expect.objectContaining({ kind: "edit", messageId: 1, text: expect.stringContaining("assistant delivery failed") }),
      );
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
        expect.objectContaining({ kind: "send", messageId: 1, text: expect.stringMatching(/Working/i), hasAbort: true }),
      );
      expect(harness.operations).toContainEqual(
        expect.objectContaining({ kind: "send", messageId: 2, text: expect.stringContaining("🔧 1 tool used: read") }),
      );
      expect(harness.operations).toContainEqual(
        expect.objectContaining({ kind: "edit", messageId: 1, text: expect.stringMatching(/Done/i) }),
      );
      expect(harness.operations).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "markup", messageId: 1, hasAbort: false }),
        expect.objectContaining({ kind: "markup", messageId: 2, hasAbort: false }),
      ]));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves summary tool verbosity without writing it into the status", async () => {
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

    const statusText = harness.operations.filter(
      (operation): operation is Extract<TelegramOperation, { kind: "send" | "edit" }> =>
        (operation.kind === "send" || operation.kind === "edit") && operation.messageId === 1,
    ).map((operation) => operation.text).join("\n");
    const outputText = harness.operations.filter(
      (operation): operation is Extract<TelegramOperation, { kind: "send" | "edit" }> =>
        (operation.kind === "send" || operation.kind === "edit") && operation.messageId > 1,
    ).map((operation) => operation.text).join("\n");
    expect(statusText).not.toContain("read");
    expect(outputText).toContain("read");
    expect(outputText).not.toContain("hidden thinking");
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
          (operation) => operation.kind === "send" && operation.messageId === 4,
        );

        callbacks.onTextDelta("\n# Report");
      },
    });

    await expect(harness.run()).resolves.toBe(true);

    const assistantMessages = new Map<number, string>();
    for (const operation of harness.operations) {
      if ((operation.kind === "send" || operation.kind === "edit") && operation.messageId > 1) {
        assistantMessages.set(operation.messageId, operation.text);
      }
    }

    expect([...assistantMessages.keys()]).toEqual([2, 3, 4]);
    expect(assistantMessages.get(4)).toContain("# Report");
    expect(harness.operations.filter(
      (operation) => (operation.kind === "send" || operation.kind === "edit") && operation.messageId > 1,
    ).every((operation) => operation.delivery === "plain")).toBe(true);
  });

  it.each([
    ["extension binding", { bindExtensionsError: new Error("bind failed") }],
    ["event subscription", { subscribeError: new Error("subscribe failed") }],
  ])("finalizes controls and typing when %s rejects", async (_phase, failure) => {
    vi.useFakeTimers();
    const harness = createPromptHarness({ typingIntervalMs: 4_500, ...failure });

    try {
      await expect(harness.run()).resolves.toBe(false);
      expect(harness.operations).toContainEqual(
        expect.objectContaining({ kind: "edit", messageId: 1, text: expect.stringMatching(/failed/i) }),
      );
      expect(harness.operations).toContainEqual(
        expect.objectContaining({ kind: "markup", messageId: 1, hasAbort: false }),
      );

      const typingAfterSettlement = harness.operations.filter((operation) => operation.kind === "typing").length;
      await vi.advanceTimersByTimeAsync(9_000);
      expect(harness.operations.filter((operation) => operation.kind === "typing")).toHaveLength(typingAfterSettlement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for deferred all-mode tool delivery before Done and clears its migrated Abort button", async () => {
    const toolStartRelease = deferred();
    const toolStartStarted = deferred();
    let harness!: ReturnType<typeof createPromptHarness>;
    harness = createPromptHarness({
      activityEnabled: false,
      toolVerbosity: "all",
      onSend: async (text, messageId) => {
        if (messageId === 2 && text.includes("Running:")) {
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
      expect.objectContaining({ kind: "edit", messageId: 1, text: expect.stringMatching(/Done/i) }),
    );

    toolStartRelease.resolve();
    await expect(result).resolves.toBe(true);

    const toolFinish = harness.operations.findIndex(
      (operation) => operation.kind === "edit" && operation.messageId === 2 && operation.text.includes("❌"),
    );
    const statusDone = harness.operations.findIndex(
      (operation) => operation.kind === "edit" && operation.messageId === 1 && /Done/i.test(operation.text),
    );
    const attachToolAbort = harness.operations.findIndex(
      (operation) => operation.kind === "markup" && operation.messageId === 2 && operation.hasAbort,
    );
    const clearToolAbort = harness.operations.findIndex(
      (operation) => operation.kind === "markup" && operation.messageId === 2 && !operation.hasAbort,
    );
    expect(toolFinish).toBeGreaterThanOrEqual(0);
    expect(statusDone).toBeGreaterThan(toolFinish);
    expect(attachToolAbort).toBeGreaterThanOrEqual(0);
    expect(clearToolAbort).toBeGreaterThan(statusDone);
  });

  it.each(["all", "errors-only"] as const)(
    "serializes an earlier activity-off %s tool delivery before later assistant text and keeps one Abort owner",
    async (toolVerbosity) => {
      const toolDeliveryRelease = deferred();
      const toolDeliveryStarted = deferred();
      const assistantEmitted = deferred();
      const promptRelease = deferred();
      const toolDeliveryText = toolVerbosity === "all" ? "Running:" : "❌";
      let harness!: ReturnType<typeof createPromptHarness>;
      harness = createPromptHarness({
        activityEnabled: false,
        toolVerbosity,
        onSend: async (text, messageId) => {
          if (messageId === 2 && text.includes(toolDeliveryText)) {
            toolDeliveryStarted.resolve();
            await toolDeliveryRelease.promise;
          }
        },
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
          expect.objectContaining({ kind: "send", messageId: 3, text: expect.stringContaining("later assistant text") }),
        );

        toolDeliveryRelease.resolve();
        await vi.advanceTimersByTimeAsync(0);
        await harness.waitForOperation(
          (operation) => operation.kind === "send" && operation.messageId === 3 && operation.text.includes("later assistant text"),
        );
        await harness.waitForOperation(
          (operation) => operation.kind === "markup" && operation.messageId === 3 && operation.hasAbort,
        );
        await harness.waitForOperation(
          (operation) => operation.kind === "markup" && operation.messageId === 2 && !operation.hasAbort,
        );
        if (toolVerbosity === "all") {
          await harness.waitForOperation(
            (operation) => operation.kind === "edit" && operation.messageId === 2 && operation.text.includes("❌"),
          );
        }

        const outputOperations = harness.operations.filter(
          (operation): operation is Extract<TelegramOperation, { kind: "send" | "edit" }> =>
            (operation.kind === "send" || operation.kind === "edit") && operation.messageId > 1,
        );
        expect(outputOperations.map((operation) => [operation.kind, operation.messageId])).toEqual(
          toolVerbosity === "all"
            ? [["send", 2], ["send", 3], ["edit", 2]]
            : [["send", 2], ["send", 3]],
        );
        expect(outputOperations[0].text).toContain(toolDeliveryText);
        expect(outputOperations[1].text).toContain("later assistant text");
        if (toolVerbosity === "all") {
          expect(outputOperations[2].text).toContain("❌");
        }

        const statusDone = harness.operations.findIndex(
          (operation) => operation.kind === "edit" && operation.messageId === 1 && /Done/i.test(operation.text),
        );
        expect(statusDone).toBe(-1);
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
        expect(ownersAfterMigrations).toEqual([[2], [3]]);
        expect(harness.trackCallbackMessages).toEqual([1, 2, 3]);

        promptRelease.resolve();
        await expect(result).resolves.toBe(true);
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
      onSend: async (text, messageId) => {
        if (messageId === 2 && text.includes("❌")) {
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

    const statusDone = harness.operations.findIndex(
      (operation) => operation.kind === "edit" && operation.messageId === 1 && /Done/i.test(operation.text),
    );
    const toolError = harness.operations.findIndex(
      (operation) => operation.kind === "send" && operation.messageId === 2 && operation.text.includes("❌"),
    );
    const attachToolAbort = harness.operations.findIndex(
      (operation) => operation.kind === "markup" && operation.messageId === 2 && operation.hasAbort,
    );
    const clearToolAbort = harness.operations.findIndex(
      (operation) => operation.kind === "markup" && operation.messageId === 2 && !operation.hasAbort,
    );
    expect(statusDone).toBeGreaterThan(toolError);
    expect(attachToolAbort).toBeGreaterThanOrEqual(0);
    expect(clearToolAbort).toBeGreaterThan(statusDone);

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
