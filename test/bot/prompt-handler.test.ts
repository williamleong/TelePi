import { describe, expect, it, vi } from "vitest";

import { createPromptHandler } from "../../src/bot/prompt-handler.js";
import type { PiSessionCallbacks } from "../../src/pi-session.js";

type TelegramOperation =
  | { kind: "send"; messageId: number; text: string; hasAbort: boolean }
  | { kind: "edit"; messageId: number; text: string; hasAbort: boolean }
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
    bindExtensions: vi.fn().mockResolvedValue(undefined),
    subscribe(nextCallbacks: PiSessionCallbacks) {
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
        record({ kind: "send", messageId, text, hasAbort: hasAbortKeyboard(sendOptions?.reply_markup) });
        return { message_id: messageId };
      },
      async editMessageText(
        _chatId: number,
        messageId: number,
        text: string,
        editOptions?: { reply_markup?: unknown },
      ) {
        await options.onEdit?.(text, messageId);
        record({ kind: "edit", messageId, text, hasAbort: hasAbortKeyboard(editOptions?.reply_markup) });
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
        taskPromise = task();
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

  it("keeps the old Abort owner when the new-owner attach rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let harness!: ReturnType<typeof createPromptHarness>;
    const promptRelease = deferred();
    harness = createPromptHarness({
      onMarkup: (messageId, hasAbort) => {
        if (messageId === 2 && hasAbort) {
          return Promise.reject(new Error("attach failed"));
        }
      },
      onPrompt: async (callbacks) => {
        callbacks.onThinkingDelta({ blockKey: "1", delta: "activity" });
        await promptRelease.promise;
        callbacks.onAgentEnd();
      },
    });

    const result = harness.run();
    await harness.waitForOperation((operation) => operation.kind === "send" && operation.messageId === 2);
    await Promise.resolve();
    expect(harness.markupAttempts).toContainEqual({ messageId: 2, hasAbort: true });
    expect(harness.operations).not.toContainEqual(
      expect.objectContaining({ kind: "markup", messageId: 1, hasAbort: false }),
    );

    promptRelease.resolve();
    try {
      await expect(result).resolves.toBe(true);
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
});
