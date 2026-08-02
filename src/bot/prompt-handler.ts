import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

import { formatError } from "../errors.js";
import {
  appendWithCap,
  formatToolSummaryLine,
  isMessageNotModifiedError,
  renderAssistantSegment,
  renderExtensionError,
  renderExtensionNotice,
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
}

type PromptFlowDeps = Omit<CreatePromptHandlerOptions, "isBusy" | "taskRunner" | "sendBusyReply">;

type PromptTaskOutcome = "completed" | "failed";

type ToolState = {
  toolName: string;
  partialResult: string;
  messageId?: number;
  finalStatus?: RenderedText;
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
  let statusMessageId: number | undefined;
  let workingMessagePromise: Promise<void> | undefined;
  let abortOwnerMessageId: number | undefined;
  const abortOwnerMessageIds = new Set<number>();
  let deliveryTimer: NodeJS.Timeout | undefined;
  let deliveryWorkerPromise: Promise<void> | undefined;
  let deliveryPending = false;
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

    await bot.api.editMessageReplyMarkup(target.chatId, messageId, {
      reply_markup: abortKeyboard,
    });
    trackCallbackMessage?.(target, messageId);
    abortOwnerMessageIds.add(messageId);

    const previousOwnerMessageId = abortOwnerMessageId;
    if (previousOwnerMessageId !== undefined) {
      await clearAbortKeyboard(previousOwnerMessageId);
    }
    abortOwnerMessageId = messageId;
  };

  const ensureWorkingMessage = async (): Promise<void> => {
    if (statusMessageId !== undefined) {
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
      statusMessageId = message.message_id;
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

  const renderSegment = (segment: StreamSegment): RenderedChunk[] => segment.kind === "assistant"
    ? renderAssistantSegment(segment.assistantText)
    : renderActivityTranscript(segment.activity!);

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
        const message = await sendTextMessage(bot.api, target, rendered.text, {
          parseMode: rendered.parseMode,
          fallbackText: rendered.fallbackText,
          delivery: rendered.delivery,
        });
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
        await migrateAbortOwner(newestMessageId);
      }
    }
    streamSegments.markDelivered(segment.id, revision);
    lastDeliveryAt = Date.now();
  };

  const runDeliveryWorker = (): Promise<void> => {
    if (deliveryWorkerPromise) {
      deliveryPending = true;
      return deliveryWorkerPromise;
    }

    const worker = (async () => {
      do {
        deliveryPending = false;
        for (const segment of streamSegments.getDirtySegments()) {
          try {
            await deliverSegment(segment);
          } catch (error) {
            if (segment.kind === "activity") {
              console.error("Failed to update Telegram activity transcript", error);
              streamSegments.markDeliveryFailed(segment.id);
              continue;
            }
            deliveryFailure = error;
            throw error;
          }
        }
      } while (deliveryPending || streamSegments.getDirtySegments().length > 0);
    })();

    deliveryWorkerPromise = worker;
    void worker.finally(() => {
      if (deliveryWorkerPromise === worker) {
        deliveryWorkerPromise = undefined;
      }
    }).catch(() => {});
    return worker;
  };

  const requestDelivery = (): Promise<void> => {
    if (deliveryFinalizing || deliveryFinalized) {
      return deliveryWorkerPromise ?? Promise.resolve();
    }
    deliveryPending = true;
    if (deliveryWorkerPromise) {
      return deliveryWorkerPromise;
    }
    if (deliveryTimer) {
      return Promise.resolve();
    }

    const delay = Math.max(0, editDebounceMs - (Date.now() - lastDeliveryAt));
    deliveryTimer = setTimeout(() => {
      deliveryTimer = undefined;
      if (deliveryFinalizing || deliveryFinalized) {
        return;
      }
      void runDeliveryWorker().catch(() => {});
    }, delay);
    return Promise.resolve();
  };

  const drainDelivery = async (): Promise<void> => {
    clearDeliveryTimer();
    while (true) {
      if (deliveryFailure) {
        throw deliveryFailure;
      }
      const worker = deliveryWorkerPromise ?? runDeliveryWorker();
      await worker;
      if (deliveryFailure) {
        throw deliveryFailure;
      }
      if (streamSegments.getDirtySegments().length === 0 && !deliveryPending) {
        return;
      }
    }
  };

  const drainDeliveryAfterFailure = async (): Promise<void> => {
    clearDeliveryTimer();
    if (deliveryWorkerPromise) {
      await deliveryWorkerPromise.catch(() => {});
    }
    if (!deliveryFailure && streamSegments.getDirtySegments().length > 0) {
      await runDeliveryWorker().catch(() => {});
    }
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

  const updateStatus = async (text: string, fallbackText: string): Promise<void> => {
    if (statusMessageId === undefined) {
      await safeReply(ctx, text, { fallbackText }, target);
      return;
    }
    await safeEditMessage(bot, target, statusMessageId, text, { fallbackText });
  };

  const finalizeSuccess = async (): Promise<void> => {
    if (finalizationPromise) {
      return finalizationPromise;
    }

    finalizationPromise = (async () => {
      deliveryFinalizing = true;
      clearDeliveryTimer();
      appendToolSummary();
      await drainDelivery();
      await updateStatus("<b>✅ Done</b>", "✅ Done");
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
        await updateStatus(status, status);
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

  await ensureWorkingMessage();
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

  const unsubscribe = piSession.subscribe({
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
      void (async () => {
        const message = await sendTextMessage(bot.api, target, messageText.text, {
          parseMode: messageText.parseMode,
          fallbackText: messageText.fallbackText,
        });
        const state = toolStates.get(toolCallId);
        if (!state) {
          return;
        }
        state.messageId = message.message_id;
        if (state.finalStatus) {
          await safeEditMessage(bot, target, state.messageId, state.finalStatus.text, {
            parseMode: state.finalStatus.parseMode,
            fallbackText: state.finalStatus.fallbackText,
          });
        }
      })().catch((error) => {
        console.error(`Failed to send tool start message for ${toolName}`, error);
      });
    },
    onToolUpdate: (toolCallId, partialResult) => {
      if (activityEnabled || toolVerbosity === "none" || toolVerbosity === "summary") {
        return;
      }
      const state = toolStates.get(toolCallId);
      if (!state || !partialResult) {
        return;
      }
      state.partialResult = appendWithCap(state.partialResult, partialResult, TOOL_OUTPUT_PREVIEW_LIMIT);
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
        void sendTextMessage(bot.api, target, state.finalStatus.text, {
          parseMode: state.finalStatus.parseMode,
          fallbackText: state.finalStatus.fallbackText,
        }).catch((error) => {
          console.error(`Failed to send tool error message for ${state.toolName}`, error);
        });
        return;
      }
      if (state.messageId === undefined) {
        return;
      }
      void safeEditMessage(bot, target, state.messageId, state.finalStatus.text, {
        parseMode: state.finalStatus.parseMode,
        fallbackText: state.finalStatus.fallbackText,
      }).catch((error) => {
        console.error(`Failed to update tool message for ${state.toolName}`, error);
      });
    },
    onAgentEnd: () => {
      void finalizeSuccess().catch((error) => {
        console.error("Failed to finalize Telegram response message", error);
      });
    },
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

  try {
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
    unsubscribe();
  }
}

export function createPromptHandler(options: CreatePromptHandlerOptions): HandleUserPrompt {
  const {
    isBusy,
    taskRunner,
    sendBusyReply,
    ...promptFlowDeps
  } = options;

  return async (
    ctx: Context,
    target: PiSessionContext,
    userText: string,
    preloadedSlashCommands?: SlashCommandInfo[],
    images?: ImageContent[],
    options?: HandleUserPromptOptions,
  ): Promise<boolean> => {
    if (isBusy(target)) {
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
