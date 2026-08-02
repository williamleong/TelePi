import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

import { formatError } from "../errors.js";
import {
  appendWithCap,
  formatToolSummaryLine,
  getAssistantSegmentDelivery,
  isMessageNotModifiedError,
  renderAssistantSegment,
  renderExtensionError,
  renderExtensionNotice,
  renderPrefixedError,
  renderPromptFailure,
  renderToolEndMessage,
  renderToolStartMessage,
  TOOL_OUTPUT_PREVIEW_LIMIT,
  type RenderedChunk,
  type RenderedText,
} from "./message-rendering.js";
import { renderActivityTranscript } from "./activity-rendering.js";
import { createStreamSegments, type StreamSegment } from "./stream-segments.js";
import {
  safeEditMessage,
  safeReply,
  sendChatAction,
  sendTextMessage,
} from "./telegram-transport.js";
import { createTelegramUIContext } from "../telegram-ui-context.js";
import type { ToolVerbosity } from "../config.js";
import type { ExtensionDialogManager } from "./extension-dialogs.js";
import type { ChatTaskRunner } from "./chat-task-runner.js";
import type { PiSessionContext, PiSessionInfo, PiSessionService } from "../pi-session.js";

export interface HandleUserPromptOptions {
  waitForCompletion?: boolean;
  allowSteering?: boolean;
}

function stringifyToolUpdate(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export type HandleUserPrompt = (
  ctx: Context,
  target: PiSessionContext,
  userText: string,
  preloadedSlashCommands?: SlashCommandInfo[],
  images?: ImageContent[],
  options?: HandleUserPromptOptions,
) => Promise<boolean>;

interface CreatePromptHandlerOptions {
  bot: Bot<Context>;
  toolVerbosity: ToolVerbosity;
  isActivityEnabled: (target: PiSessionContext) => boolean;
  editDebounceMs: number;
  typingIntervalMs: number;
  isBusy: (target: PiSessionContext) => boolean;
  taskRunner: ChatTaskRunner;
  ensureActiveSession: (ctx: Context, target: PiSessionContext) => Promise<PiSessionService | undefined>;
  syncChatScopedCommands: (target: PiSessionContext, slashCommands: SlashCommandInfo[]) => Promise<void>;
  refreshChatScopedCommands: (target: PiSessionContext, piSession: PiSessionService) => Promise<void>;
  extensionDialogs: Pick<ExtensionDialogManager, "openSelect" | "openConfirm" | "openInput">;
  trackCallbackMessage?: (target: PiSessionContext, messageId: number) => void;
  renameForumTopicToSessionName?: (target: PiSessionContext, info: PiSessionInfo) => Promise<void>;
  sendBusyReply: (ctx: Context) => Promise<void>;
  trySteer: (target: PiSessionContext, text: string) => Promise<boolean>;
}

type PromptFlowDeps = Omit<CreatePromptHandlerOptions, "isBusy" | "taskRunner" | "sendBusyReply" | "trySteer">;

type PromptTaskOutcome = "completed" | "failed";

type ToolState = {
  toolName: string;
  partialResult: string;
  messageId?: number;
  finalStatus?: RenderedText;
};

type DeliveryOperation = {
  readyAt: number;
  waitingForDebounce?: boolean;
  execute: () => Promise<void>;
  onError?: (error: unknown) => void;
};

function renderedChunksMatch(left: RenderedChunk | undefined, right: RenderedChunk): boolean {
  return left?.text === right.text
    && left.fallbackText === right.fallbackText
    && left.parseMode === right.parseMode
    && left.delivery === right.delivery;
}

async function runPromptFlow(
  deps: PromptFlowDeps,
  ctx: Context,
  target: PiSessionContext,
  userText: string,
  preloadedSlashCommands?: SlashCommandInfo[],
  images?: ImageContent[],
): Promise<PromptTaskOutcome> {
  const {
    bot,
    toolVerbosity,
    editDebounceMs,
    typingIntervalMs,
    ensureActiveSession,
    syncChatScopedCommands,
    refreshChatScopedCommands,
    extensionDialogs,
    trackCallbackMessage,
    renameForumTopicToSessionName,
  } = deps;

  const activityEnabled = deps.isActivityEnabled(target);
  const abortKeyboard = new InlineKeyboard().text("⏹ Abort", "pi_abort");
  const streamSegments = createStreamSegments();
  const toolStates = new Map<string, ToolState>();
  const toolCounts = new Map<string, number>();
  let abortOwnerMessageId: number | undefined;
  const abortOwnerMessageIds = new Set<number>();
  let workingMessageId: number | undefined;
  let workingMessagePromise: Promise<void> | undefined;
  let workingMessageAdopted = false;
  let deliveryTimer: NodeJS.Timeout | undefined;
  let deliveryWorkerPromise: Promise<void> | undefined;
  const deliveryQueue: DeliveryOperation[] = [];
  let segmentDeliveryOperation: DeliveryOperation | undefined;
  let deliveryFinalizing = false;
  let deliveryFinalized = false;
  let deliveryFailure: unknown;
  let lastDeliveryAt = 0;
  let finalizationPromise: Promise<void> | undefined;
  let failureFinalizationPromise: Promise<void> | undefined;
  let typingStopped = false;

  const sendTyping = (): void => {
    if (typingStopped) {
      return;
    }
    void sendChatAction(bot.api, target, "typing").catch(() => {});
  };

  const typingInterval = setInterval(sendTyping, typingIntervalMs);
  sendTyping();

  const stopTyping = (): void => {
    if (typingStopped) {
      return;
    }
    typingStopped = true;
    clearInterval(typingInterval);
  };

  const clearDeliveryTimer = (): void => {
    if (deliveryTimer) {
      clearTimeout(deliveryTimer);
      deliveryTimer = undefined;
    }
  };

  const clearAbortKeyboard = async (messageId: number): Promise<void> => {
    try {
      await bot.api.editMessageReplyMarkup(target.chatId, messageId, {
        reply_markup: new InlineKeyboard(),
      });
    } catch (error) {
      if (!isMessageNotModifiedError(error)) {
        console.error("Failed to clear Abort button", error);
      }
    }
  };

  const cleanupAbortOwners = async (): Promise<void> => {
    for (const messageId of abortOwnerMessageIds) {
      await clearAbortKeyboard(messageId);
    }
  };

  const migrateAbortOwner = async (messageId: number): Promise<void> => {
    if (abortOwnerMessageId === messageId) {
      return;
    }

    abortOwnerMessageIds.add(messageId);
    trackCallbackMessage?.(target, messageId);
    await bot.api.editMessageReplyMarkup(target.chatId, messageId, {
      reply_markup: abortKeyboard,
    });

    const previousOwnerMessageId = abortOwnerMessageId;
    abortOwnerMessageId = messageId;
    if (previousOwnerMessageId !== undefined) {
      await clearAbortKeyboard(previousOwnerMessageId);
    }
  };

  const ensureWorkingMessage = async (): Promise<void> => {
    if (workingMessageId !== undefined) {
      return;
    }
    if (workingMessagePromise) {
      return workingMessagePromise;
    }

    workingMessagePromise = (async () => {
      const message = await sendTextMessage(bot.api, target, "<i>⏳ Working…</i>", {
        fallbackText: "⏳ Working…",
        replyMarkup: abortKeyboard,
      });
      workingMessageId = message.message_id;
      abortOwnerMessageId = message.message_id;
      abortOwnerMessageIds.add(message.message_id);
      trackCallbackMessage?.(target, message.message_id);
      sendTyping();
    })();

    try {
      await workingMessagePromise;
    } catch (error) {
      console.error("Failed to send Telegram working message", error);
    } finally {
      workingMessagePromise = undefined;
    }
  };

  const adoptWorkingMessage = async (rendered: RenderedText): Promise<number | undefined> => {
    if (workingMessageId === undefined || workingMessageAdopted) {
      return undefined;
    }

    await safeEditMessage(bot, target, workingMessageId, rendered.text, {
      parseMode: rendered.parseMode,
      fallbackText: rendered.fallbackText,
      delivery: rendered.delivery,
      replyMarkup: abortKeyboard,
    });
    workingMessageAdopted = true;
    sendTyping();
    return workingMessageId;
  };

  const sendLegacyOutput = async (rendered: RenderedText): Promise<number> => {
    const hasAbortOwner = abortOwnerMessageId !== undefined;
    const message = await sendTextMessage(bot.api, target, rendered.text, {
      parseMode: rendered.parseMode,
      fallbackText: rendered.fallbackText,
      replyMarkup: hasAbortOwner ? undefined : abortKeyboard,
    });

    if (!hasAbortOwner) {
      abortOwnerMessageId = message.message_id;
      abortOwnerMessageIds.add(message.message_id);
      trackCallbackMessage?.(target, message.message_id);
    } else {
      try {
        await migrateAbortOwner(message.message_id);
      } catch (error) {
        console.error("Failed to migrate Telegram Abort button", error);
      }
    }

    return message.message_id;
  };

  const latestOutputMessageId = (): number | undefined => {
    for (const segment of [...streamSegments.getSegments()].reverse()) {
      for (const chunk of [...segment.chunks].reverse()) {
        if (chunk.messageId !== undefined) {
          return chunk.messageId;
        }
      }
    }
    return undefined;
  };

  const renderSegment = (segment: StreamSegment): RenderedChunk[] => {
    if (segment.kind === "activity") {
      return renderActivityTranscript(segment.activity!);
    }

    const delivery = streamSegments.lockAssistantDelivery(
      segment.id,
      getAssistantSegmentDelivery(segment.assistantText),
    );
    return renderAssistantSegment(segment.assistantText, delivery);
  };

  const recordDeliveryFailure = (error: unknown, message: string): void => {
    console.error(message, error);
    deliveryFailure ??= error;
  };

  const deliverSegment = async (segment: StreamSegment): Promise<void> => {
    const revision = segment.revision;
    const previousChunks = segment.chunks;
    const renderedChunks = renderSegment(segment);
    streamSegments.setRenderedChunks(segment.id, renderedChunks);

    let changed = false;
    for (const [index, rendered] of renderedChunks.entries()) {
      const previous = previousChunks[index];
      const current = streamSegments.getSegments().find((candidate) => candidate.id === segment.id)?.chunks[index];
      if (!current) {
        continue;
      }

      if (current.messageId === undefined) {
        const adoptedMessageId = await adoptWorkingMessage(rendered);
        if (adoptedMessageId !== undefined) {
          streamSegments.setChunkMessageId(segment.id, index, adoptedMessageId);
          changed = true;
          continue;
        }
      }

      if (current.messageId === undefined) {
        const message = await sendTextMessage(bot.api, target, rendered.text, {
          parseMode: rendered.parseMode,
          fallbackText: rendered.fallbackText,
          delivery: rendered.delivery,
          replyMarkup: abortOwnerMessageId === undefined ? abortKeyboard : undefined,
        });
        if (abortOwnerMessageId === undefined) {
          abortOwnerMessageId = message.message_id;
          abortOwnerMessageIds.add(message.message_id);
          trackCallbackMessage?.(target, message.message_id);
        }
        streamSegments.setChunkMessageId(segment.id, index, message.message_id);
        changed = true;
        sendTyping();
        continue;
      }

      if (renderedChunksMatch(previous?.rendered, rendered)) {
        continue;
      }

      await safeEditMessage(bot, target, current.messageId, rendered.text, {
        parseMode: rendered.parseMode,
        fallbackText: rendered.fallbackText,
        delivery: rendered.delivery,
      });
      changed = true;
    }

    if (changed) {
      const newestMessageId = latestOutputMessageId();
      if (newestMessageId !== undefined) {
        try {
          await migrateAbortOwner(newestMessageId);
        } catch (error) {
          console.error("Failed to migrate Telegram Abort button", error);
        }
      }
    }
    streamSegments.markDelivered(segment.id, revision);
    lastDeliveryAt = Date.now();
  };

  const runDeliveryWorker = (): Promise<void> => {
    if (deliveryWorkerPromise) {
      return deliveryWorkerPromise;
    }

    const worker = (async () => {
      while (deliveryQueue.length > 0) {
        const operation = deliveryQueue[0];
        const delay = operation.readyAt - Date.now();
        if (operation.waitingForDebounce || delay > 0) {
          if (!deliveryTimer) {
            deliveryTimer = setTimeout(() => {
              operation.waitingForDebounce = false;
              deliveryTimer = undefined;
              void runDeliveryWorker();
            }, Math.max(0, delay));
          }
          return;
        }

        deliveryQueue.shift();
        try {
          await operation.execute();
        } catch (error) {
          if (operation.onError) {
            operation.onError(error);
          } else {
            console.error("Failed to deliver Telegram prompt output", error);
          }
        }
      }
    })();

    deliveryWorkerPromise = worker;
    void worker.finally(() => {
      if (deliveryWorkerPromise === worker) {
        deliveryWorkerPromise = undefined;
      }
    }).then(() => {
      if (deliveryQueue.length > 0 && !deliveryTimer) {
        void runDeliveryWorker();
      }
    }).catch(() => {});
    return worker;
  };

  const enqueueSegmentDelivery = (readyAt: number, waitForDebounce = true): void => {
    if (segmentDeliveryOperation) {
      return;
    }

    const operation: DeliveryOperation = {
      readyAt,
      waitingForDebounce: waitForDebounce,
      execute: async () => {
        try {
          do {
            for (const segment of streamSegments.getDirtySegments()) {
              try {
                await deliverSegment(segment);
              } catch (error) {
                if (segment.kind === "activity") {
                  recordDeliveryFailure(error, "Failed to update Telegram activity transcript");
                  streamSegments.markDeliveryFailed(segment.id);
                  continue;
                }
                throw error;
              }
            }
          } while (streamSegments.getDirtySegments().length > 0);
        } finally {
          segmentDeliveryOperation = undefined;
        }
      },
      onError: (error) => {
        recordDeliveryFailure(error, "Failed to deliver Telegram prompt output");
      },
    };
    segmentDeliveryOperation = operation;
    deliveryQueue.push(operation);
    if (waitForDebounce) {
      deliveryTimer = setTimeout(() => {
        operation.waitingForDebounce = false;
        deliveryTimer = undefined;
        void runDeliveryWorker();
      }, Math.max(0, readyAt - Date.now()));
    }
    void runDeliveryWorker();
  };

  const enqueueLegacyDelivery = (delivery: () => Promise<void>, errorMessage: string): void => {
    if (deliveryFinalizing || deliveryFinalized) {
      return;
    }

    deliveryQueue.push({
      readyAt: Date.now(),
      execute: delivery,
      onError: (error) => {
        recordDeliveryFailure(error, errorMessage);
      },
    });
    void runDeliveryWorker();
  };

  const requestDelivery = (): Promise<void> => {
    if (deliveryFinalizing || deliveryFinalized) {
      return deliveryWorkerPromise ?? Promise.resolve();
    }

    const readyAt = Date.now() + Math.max(0, editDebounceMs - (Date.now() - lastDeliveryAt));
    enqueueSegmentDelivery(readyAt);
    return deliveryWorkerPromise ?? Promise.resolve();
  };

  const forceSegmentDelivery = (): Promise<void> => {
    clearDeliveryTimer();
    if (streamSegments.getDirtySegments().length === 0) {
      return deliveryWorkerPromise ?? Promise.resolve();
    }
    if (segmentDeliveryOperation) {
      segmentDeliveryOperation.readyAt = Date.now();
      segmentDeliveryOperation.waitingForDebounce = false;
    } else {
      enqueueSegmentDelivery(Date.now(), false);
    }
    return runDeliveryWorker();
  };

  const drainDeliveryQueue = async (): Promise<void> => {
    while (deliveryWorkerPromise || deliveryQueue.length > 0) {
      const worker = deliveryWorkerPromise ?? runDeliveryWorker();
      await worker;
    }
  };

  const drainDelivery = async (): Promise<void> => {
    await forceSegmentDelivery();
    await drainDeliveryQueue();
    if (deliveryFailure) {
      throw deliveryFailure;
    }
  };

  const drainDeliveryAfterFailure = async (): Promise<void> => {
    await forceSegmentDelivery();
    await drainDeliveryQueue();
  };

  const appendToolSummary = (): void => {
    if (activityEnabled || toolVerbosity !== "summary") {
      return;
    }
    const summary = formatToolSummaryLine(toolCounts);
    if (!summary) {
      return;
    }

    const lastAssistant = [...streamSegments.getSegments()].reverse().find(
      (segment) => segment.kind === "assistant",
    );
    if (!lastAssistant) {
      streamSegments.appendAssistantText(summary);
      return;
    }

    lastAssistant.assistantText = lastAssistant.assistantText.trim()
      ? `${lastAssistant.assistantText}\n\n${summary}`
      : summary;
    lastAssistant.revision += 1;
  };

  const deleteUnusedWorkingMessage = async (): Promise<void> => {
    if (workingMessageId === undefined || workingMessageAdopted) {
      return;
    }

    try {
      await bot.api.deleteMessage(target.chatId, workingMessageId);
      abortOwnerMessageIds.delete(workingMessageId);
      if (abortOwnerMessageId === workingMessageId) {
        abortOwnerMessageId = undefined;
      }
    } catch (error) {
      console.error("Failed to delete Telegram working message", error);
    }
  };

  const finalizeSuccess = async (): Promise<void> => {
    if (finalizationPromise) {
      return finalizationPromise;
    }

    finalizationPromise = (async () => {
      deliveryFinalizing = true;
      appendToolSummary();
      await drainDelivery();
      await deleteUnusedWorkingMessage();
      await cleanupAbortOwners();
      deliveryFinalized = true;
      stopTyping();
    })();
    return finalizationPromise;
  };

  const finalizeFailure = async (error: unknown): Promise<void> => {
    if (failureFinalizationPromise) {
      return failureFinalizationPromise;
    }

    failureFinalizationPromise = (async () => {
      deliveryFinalizing = true;
      await drainDeliveryAfterFailure();
      const status = renderPromptFailure("", error);
      try {
        if (workingMessageId !== undefined && !workingMessageAdopted) {
          await safeEditMessage(bot, target, workingMessageId, status, {
            fallbackText: status,
            replyMarkup: abortKeyboard,
          });
        } else {
          await safeReply(ctx, status, { fallbackText: status }, target);
        }
      } catch (telegramError) {
        console.error("Failed to send Telegram prompt failure status", telegramError);
      }
      await cleanupAbortOwners();
      deliveryFinalized = true;
      stopTyping();
    })();
    return failureFinalizationPromise;
  };

  let piSession: PiSessionService | undefined;
  try {
    piSession = await ensureActiveSession(ctx, target);
  } catch (error) {
    stopTyping();
    throw error;
  }
  if (!piSession) {
    stopTyping();
    return "failed";
  }

  if (preloadedSlashCommands) {
    void syncChatScopedCommands(target, preloadedSlashCommands).catch((error) => {
      console.error("Failed to sync chat-scoped Telegram commands", error);
    });
  } else {
    void refreshChatScopedCommands(target, piSession);
  }

  let unsubscribe: (() => void) | undefined;
  try {
    await piSession.bindExtensions({
    commandContextActions: {
      waitForIdle: async () => {
        await piSession.getSession().agent.waitForIdle();
      },
      newSession: async (options) => {
        const result = await piSession.newSession(options);
        return { cancelled: !result.created };
      },
      fork: async (entryId, forkOptions) => piSession.fork(entryId, forkOptions),
      navigateTree: async (targetId, navOptions) => {
        const result = await piSession.navigateTree(targetId, navOptions);
        return { cancelled: result.cancelled };
      },
      switchSession: async (sessionPath, switchOptions) => {
        const result = await piSession.switchSession(sessionPath, switchOptions);
        return { cancelled: result.cancelled };
      },
      reload: async () => {
        await piSession.reload();
      },
    },
    uiContext: createTelegramUIContext({
      notify: (message, type) => {
        const rendered = renderExtensionNotice(message, type);
        void sendTextMessage(bot.api, target, rendered.text, {
          parseMode: rendered.parseMode,
          fallbackText: rendered.fallbackText,
        }).catch((error) => {
          console.error("Failed to send extension notification", error);
        });
      },
      select: (title, choices, dialogOptions) => extensionDialogs.openSelect(target, title, choices, dialogOptions),
      confirm: (title, message, dialogOptions) => extensionDialogs.openConfirm(target, title, message, dialogOptions),
      input: (title, placeholder, dialogOptions) => extensionDialogs.openInput(target, title, placeholder, dialogOptions),
    }),
    onError: (error) => {
      const rendered = renderExtensionError(error.extensionPath, error.event, error.error);
      void sendTextMessage(bot.api, target, rendered.text, {
        parseMode: rendered.parseMode,
        fallbackText: rendered.fallbackText,
      }).catch((sendError) => {
        console.error("Failed to send extension error", sendError);
      });
    },
    });

    unsubscribe = piSession.subscribe({
    onTextDelta: (delta) => {
      streamSegments.appendAssistantText(delta);
      void requestDelivery();
    },
    onThinkingDelta: (event) => {
      if (!activityEnabled) {
        return;
      }
      streamSegments.appendThinking(event);
      void requestDelivery();
    },
    onToolStart: (toolName, toolCallId, args) => {
      if (activityEnabled) {
        streamSegments.startTool(toolName, toolCallId, args);
        void requestDelivery();
        return;
      }

      if (toolVerbosity === "summary") {
        toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
        return;
      }
      if (toolVerbosity === "none") {
        return;
      }

      toolStates.set(toolCallId, { toolName, partialResult: "" });
      if (toolVerbosity !== "all") {
        return;
      }
      const messageText = renderToolStartMessage(toolName);
      enqueueLegacyDelivery(async () => {
        const state = toolStates.get(toolCallId);
        if (!state) {
          return;
        }
        const adoptedMessageId = await adoptWorkingMessage(messageText);
        if (adoptedMessageId !== undefined) {
          state.messageId = adoptedMessageId;
          return;
        }

        state.messageId = await sendLegacyOutput(messageText);
      }, `Failed to send tool start message for ${toolName}`);
    },
    onToolUpdate: (toolCallId, partialResult) => {
      if (activityEnabled) {
        if (streamSegments.updateTool(toolCallId, partialResult)) {
          void requestDelivery();
        }
        return;
      }
      if (toolVerbosity === "none" || toolVerbosity === "summary") {
        return;
      }
      const state = toolStates.get(toolCallId);
      if (!state || !partialResult) {
        return;
      }
      state.partialResult = appendWithCap(
        state.partialResult,
        stringifyToolUpdate(partialResult),
        TOOL_OUTPUT_PREVIEW_LIMIT,
      );
    },
    onToolEnd: (toolCallId, isError) => {
      if (activityEnabled) {
        if (streamSegments.finishTool(toolCallId, isError)) {
          void requestDelivery();
        }
        return;
      }
      if (toolVerbosity === "none" || toolVerbosity === "summary") {
        return;
      }

      const state = toolStates.get(toolCallId);
      if (!state) {
        return;
      }
      state.finalStatus = renderToolEndMessage(state.toolName, state.partialResult, isError);
      if (toolVerbosity === "errors-only") {
        if (!isError) {
          return;
        }
        enqueueLegacyDelivery(async () => {
          const adoptedMessageId = await adoptWorkingMessage(state.finalStatus!);
          if (adoptedMessageId !== undefined) {
            return;
          }

          await sendLegacyOutput(state.finalStatus!);
        }, `Failed to send tool error message for ${state.toolName}`);
        return;
      }
      enqueueLegacyDelivery(async () => {
        const currentState = toolStates.get(toolCallId);
        if (currentState?.messageId === undefined || !currentState.finalStatus) {
          return;
        }
        await safeEditMessage(bot, target, currentState.messageId, currentState.finalStatus.text, {
          parseMode: currentState.finalStatus.parseMode,
          fallbackText: currentState.finalStatus.fallbackText,
        });
      }, `Failed to update tool message for ${state.toolName}`);
    },
    onAgentEnd: () => {},
    onSessionInfoChanged: (sessionName) => {
      if (!renameForumTopicToSessionName) {
        return;
      }
      void renameForumTopicToSessionName(target, {
        ...piSession.getInfo(),
        sessionName,
      });
    },
  });

    await ensureWorkingMessage();

    if (images && images.length > 0) {
      await piSession.prompt(userText, images);
    } else {
      await piSession.prompt(userText);
    }
    await finalizeSuccess();
    return "completed";
  } catch (error) {
    if (finalizationPromise) {
      await finalizationPromise.catch(() => {});
    }
    await finalizeFailure(error);
    return "failed";
  } finally {
    stopTyping();
    clearDeliveryTimer();
    unsubscribe?.();
  }
}

export function createPromptHandler(options: CreatePromptHandlerOptions): HandleUserPrompt {
  const {
    isBusy,
    taskRunner,
    sendBusyReply,
    trySteer,
    ...promptFlowDeps
  } = options;

  const acceptSteering = async (ctx: Context, target: PiSessionContext, text: string): Promise<boolean> => {
    try {
      return await trySteer(target, text);
    } catch (error) {
      const failure = renderPrefixedError("Steering failed", error);
      await safeReply(ctx, failure.text, {
        fallbackText: failure.fallbackText,
        parseMode: failure.parseMode,
      }, target);
      return true;
    }
  };

  return async (
    ctx: Context,
    target: PiSessionContext,
    userText: string,
    preloadedSlashCommands?: SlashCommandInfo[],
    images?: ImageContent[],
    options?: HandleUserPromptOptions,
  ): Promise<boolean> => {
    const steerableInput = options?.allowSteering !== false
      && preloadedSlashCommands === undefined
      && (!images || images.length === 0);
    if (isBusy(target)) {
      if (steerableInput && await acceptSteering(ctx, target, userText)) {
        return true;
      }
      await sendBusyReply(ctx);
      return false;
    }

    let completion: Promise<PromptTaskOutcome> | undefined;
    const result = taskRunner.tryStartPrompt(
      target,
      userText,
      () => {
        completion = runPromptFlow(promptFlowDeps, ctx, target, userText, preloadedSlashCommands, images);
        return completion.then(() => undefined);
      },
    );
    if (result === "busy") {
      if (steerableInput && await acceptSteering(ctx, target, userText)) {
        return true;
      }
      await sendBusyReply(ctx);
      return false;
    }

    if (options?.waitForCompletion && completion) {
      const outcome = await completion.catch((error) => {
        console.error("Prompt task failed while waiting for completion", formatError(error));
        return "failed" as const;
      });
      return outcome === "completed";
    }

    return true;
  };
}
