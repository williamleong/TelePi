import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

import { formatError } from "../errors.js";
import {
  appendWithCap,
  buildStreamingPreview,
  formatToolSummaryLine,
  isMessageNotModifiedError,
  isRichMarkdownCandidate,
  renderExtensionError,
  renderExtensionNotice,
  renderPromptFailure,
  renderToolEndMessage,
  renderToolStartMessage,
  renderMarkdownChunkWithinLimit,
  splitMarkdownForTelegram,
  splitRichMarkdownForTelegram,
  TOOL_OUTPUT_PREVIEW_LIMIT,
  type RenderedChunk,
  type RenderedText,
} from "./message-rendering.js";
import {
  createActivityTranscript,
  renderActivityTranscript,
} from "./activity-rendering.js";
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

  const activityEnabled = deps.isActivityEnabled?.(target) ?? true;
  const activityTranscript = activityEnabled ? createActivityTranscript() : undefined;
  const abortKeyboard = new InlineKeyboard().text("⏹ Abort", "pi_abort");
  const toolStates = new Map<string, ToolState>();
  const toolCounts = new Map<string, number>();
  let accumulatedText = "";
  let responseMessageId: number | undefined;
  let responseMessagePromise: Promise<void> | undefined;
  let lastRenderedText = "";
  let lastEditAt = 0;
  let flushTimer: NodeJS.Timeout | undefined;
  let isFlushing = false;
  let flushPending = false;
  let finalized = false;
  let finalizationPromise: Promise<void> | undefined;
  let activityMessageIds: number[] = [];
  let lastActivityChunks: RenderedChunk[] = [];
  let activityFlushTimer: NodeJS.Timeout | undefined;
  let activityDeliveryFailed = false;
  let activityFlushInProgress = false;
  let activityFlushPending = false;
  let activityFlushPromise: Promise<void> | undefined;
  let activityFinalizationPromise: Promise<void> | undefined;
  let activityFinalized = false;
  let lastActivityFlushAt = 0;
  let typingStopped = false;

  const typingInterval = setInterval(() => {
    void sendChatAction(bot.api, target, "typing").catch(() => {});
  }, typingIntervalMs);
  void sendChatAction(bot.api, target, "typing").catch(() => {});

  const stopTyping = (): void => {
    if (typingStopped) {
      return;
    }
    typingStopped = true;
    clearInterval(typingInterval);
  };

  const clearFlushTimer = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  };

  const clearActivityFlushTimer = (): void => {
    if (activityFlushTimer) {
      clearTimeout(activityFlushTimer);
      activityFlushTimer = undefined;
    }
  };

  const renderPreview = (): RenderedChunk => {
    const previewText = buildStreamingPreview(accumulatedText);
    return renderMarkdownChunkWithinLimit(previewText);
  };

  const buildFinalResponseText = (text: string): string => {
    if (activityEnabled || toolVerbosity !== "summary") {
      return text.trim();
    }

    const summaryLine = formatToolSummaryLine(toolCounts);
    const trimmedText = text.trim();
    if (!summaryLine) {
      return trimmedText;
    }

    return trimmedText ? `${trimmedText}\n\n${summaryLine}` : summaryLine;
  };

  const ensureWorkingMessage = async (): Promise<void> => {
    if (responseMessageId) {
      return;
    }
    if (responseMessagePromise) {
      try {
        await responseMessagePromise;
      } catch {
        // A later text delta or final response can try sending again.
      }
      return;
    }

    const workingText = "<i>⏳ Working…</i>";
    const fallbackText = "⏳ Working…";
    responseMessagePromise = (async () => {
      const message = await sendTextMessage(bot.api, target, workingText, {
        fallbackText,
        replyMarkup: abortKeyboard,
      });
      trackCallbackMessage?.(target, message.message_id);
      responseMessageId = message.message_id;
      lastRenderedText = workingText;
      lastEditAt = Date.now();
      stopTyping();
    })();

    try {
      await responseMessagePromise;
    } catch (error) {
      console.error("Failed to send Telegram working message", error);
    } finally {
      responseMessagePromise = undefined;
    }
  };

  const ensureResponseMessage = async (): Promise<void> => {
    if (responseMessageId) {
      return;
    }
    if (responseMessagePromise) {
      await responseMessagePromise;
      return;
    }

    responseMessagePromise = (async () => {
      stopTyping();
      const preview = renderPreview();
      const message = await sendTextMessage(bot.api, target, preview.text, {
        parseMode: preview.parseMode,
        fallbackText: preview.fallbackText,
        replyMarkup: abortKeyboard,
      });
      trackCallbackMessage?.(target, message.message_id);
      responseMessageId = message.message_id;
      lastRenderedText = preview.text;
      lastEditAt = Date.now();
    })();

    try {
      await responseMessagePromise;
    } finally {
      responseMessagePromise = undefined;
    }
  };

  const flushResponse = async (force = false): Promise<void> => {
    if (!accumulatedText) {
      return;
    }
    if (!responseMessageId) {
      await ensureResponseMessage();
      return;
    }
    if (isFlushing) {
      flushPending = true;
      return;
    }

    const now = Date.now();
    if (!force && now - lastEditAt < editDebounceMs) {
      return;
    }

    const nextText = renderPreview();
    if (nextText.text === lastRenderedText) {
      return;
    }

    isFlushing = true;
    try {
      await safeEditMessage(bot, target, responseMessageId, nextText.text, {
        parseMode: nextText.parseMode,
        fallbackText: nextText.fallbackText,
        replyMarkup: abortKeyboard,
      });
      lastRenderedText = nextText.text;
      lastEditAt = Date.now();
    } finally {
      isFlushing = false;
      if (flushPending) {
        flushPending = false;
        scheduleFlush();
      }
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer || finalized) {
      return;
    }

    const delay = Math.max(0, editDebounceMs - (Date.now() - lastEditAt));
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushResponse().catch((error) => {
        console.error("Failed to update Telegram response message", error);
      });
    }, delay);
  };

  const scheduleActivityFlush = (): void => {
    if (!activityTranscript || activityDeliveryFailed || activityFinalized || activityFlushTimer) {
      return;
    }

    const delay = Math.max(0, editDebounceMs - (Date.now() - lastActivityFlushAt));
    activityFlushTimer = setTimeout(() => {
      activityFlushTimer = undefined;
      activityFlushPromise = flushActivity();
      void activityFlushPromise.catch(() => {});
    }, delay);
  };

  const flushActivity = async (force = false): Promise<void> => {
    if (!activityTranscript || activityDeliveryFailed || activityTranscript.entries.length === 0) {
      return;
    }
    if (activityFlushInProgress) {
      activityFlushPending = true;
      return;
    }

    const now = Date.now();
    if (!force && now - lastActivityFlushAt < editDebounceMs) {
      scheduleActivityFlush();
      return;
    }

    activityFlushInProgress = true;
    try {
      const chunks = renderActivityTranscript(activityTranscript);
      for (const [index, chunk] of chunks.entries()) {
        const messageId = activityMessageIds[index];
        const previousChunk = lastActivityChunks[index];
        if (messageId === undefined) {
          const message = await sendTextMessage(bot.api, target, chunk.text, {
            parseMode: chunk.parseMode,
            fallbackText: chunk.fallbackText,
            delivery: chunk.delivery,
          });
          activityMessageIds[index] = message.message_id;
          continue;
        }
        if (previousChunk?.text === chunk.text && previousChunk?.fallbackText === chunk.fallbackText) {
          continue;
        }
        await safeEditMessage(bot, target, messageId, chunk.text, {
          parseMode: chunk.parseMode,
          fallbackText: chunk.fallbackText,
          delivery: chunk.delivery,
        });
      }
      lastActivityChunks = chunks;
      lastActivityFlushAt = Date.now();
    } catch (error) {
      console.error("Failed to update Telegram activity transcript", error);
      activityDeliveryFailed = true;
      clearActivityFlushTimer();
    } finally {
      activityFlushInProgress = false;
      if (activityFlushPending && !activityDeliveryFailed && !activityFinalized) {
        activityFlushPending = false;
        scheduleActivityFlush();
      }
    }
  };

  const finalizeActivity = async (): Promise<void> => {
    if (activityFinalizationPromise) {
      await activityFinalizationPromise;
      return;
    }

    activityFinalizationPromise = (async () => {
      clearActivityFlushTimer();
      if (activityFlushInProgress) {
        activityFlushPending = true;
        await activityFlushPromise;
      }
      activityFlushPromise = flushActivity(true);
      await activityFlushPromise;
      clearActivityFlushTimer();
      activityFlushPromise = flushActivity(true);
      await activityFlushPromise;
      activityFinalized = true;
    })();

    await activityFinalizationPromise;
  };

  const removeAbortKeyboard = async (): Promise<void> => {
    if (!responseMessageId) {
      return;
    }

    try {
      await bot.api.editMessageReplyMarkup(target.chatId, responseMessageId, {
        reply_markup: new InlineKeyboard(),
      });
    } catch (error) {
      if (!isMessageNotModifiedError(error)) {
        console.error("Failed to clear Abort button", error);
      }
    }
  };

  const deliverRenderedChunks = async (chunks: RenderedChunk[]): Promise<void> => {
    if (chunks.length === 0) {
      return;
    }

    const [firstChunk, ...remainingChunks] = chunks;
    if (responseMessageId) {
      await safeEditMessage(bot, target, responseMessageId, firstChunk.text, {
        parseMode: firstChunk.parseMode,
        fallbackText: firstChunk.fallbackText,
        delivery: firstChunk.delivery,
      });
      await removeAbortKeyboard();
    } else {
      const message = await sendTextMessage(bot.api, target, firstChunk.text, {
        parseMode: firstChunk.parseMode,
        fallbackText: firstChunk.fallbackText,
        delivery: firstChunk.delivery,
      });
      responseMessageId = message.message_id;
    }

    for (const chunk of remainingChunks) {
      await sendTextMessage(bot.api, target, chunk.text, {
        parseMode: chunk.parseMode,
        fallbackText: chunk.fallbackText,
        delivery: chunk.delivery,
      });
    }
  };

  const finalizeResponse = async (): Promise<void> => {
    if (finalizationPromise) {
      await finalizationPromise;
      return;
    }

    finalizationPromise = (async () => {
      finalized = true;
      stopTyping();
      clearFlushTimer();
      await finalizeActivity();
      if (responseMessagePromise) {
        try {
          await responseMessagePromise;
        } catch {
          // If the initial send failed, we will fall back to sending the final response below.
        }
      }

      const finalText = buildFinalResponseText(accumulatedText);
      if (!finalText) {
        const html = "<b>✅ Done</b>";
        const plainText = "✅ Done";

        if (responseMessageId) {
          await safeEditMessage(bot, target, responseMessageId, html, { fallbackText: plainText });
          await removeAbortKeyboard();
        } else {
          await safeReply(ctx, html, { fallbackText: plainText }, target);
        }
        return;
      }

      const chunks = isRichMarkdownCandidate(finalText)
        ? splitRichMarkdownForTelegram(finalText)
        : splitMarkdownForTelegram(finalText);
      await deliverRenderedChunks(chunks);
    })();

    await finalizationPromise;
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

  const slashCommands = preloadedSlashCommands;
  if (slashCommands) {
    void syncChatScopedCommands(target, slashCommands).catch((error) => {
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
      accumulatedText += delta;
      if (!responseMessageId) {
        void ensureResponseMessage()
          .then(() => {
            scheduleFlush();
          })
          .catch((error) => {
            console.error("Failed to send initial Telegram response message", error);
          });
        return;
      }

      scheduleFlush();
    },
    onThinkingDelta: (event) => {
      if (!activityTranscript) {
        return;
      }
      activityTranscript.appendThinking(event);
      scheduleActivityFlush();
    },
    onToolStart: (toolName, toolCallId, args) => {
      if (activityTranscript) {
        activityTranscript.startTool(toolCallId, toolName, args);
        scheduleActivityFlush();
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
      if (activityTranscript || toolVerbosity === "none" || toolVerbosity === "summary") {
        return;
      }

      const state = toolStates.get(toolCallId);
      if (!state || !partialResult) {
        return;
      }

      state.partialResult = appendWithCap(state.partialResult, partialResult, TOOL_OUTPUT_PREVIEW_LIMIT);
    },
    onToolEnd: (toolCallId, isError) => {
      if (activityTranscript) {
        activityTranscript.finishTool(toolCallId, isError);
        scheduleActivityFlush();
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

      if (!state.messageId) {
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
      void finalizeResponse().catch((error) => {
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
    await finalizeResponse();
    return "completed";
  } catch (error) {
    stopTyping();
    clearFlushTimer();
    await finalizeActivity();
    if (responseMessagePromise) {
      try {
        await responseMessagePromise;
      } catch {
        // Ignore; we will send an error message below.
      }
    }

    if (finalized) {
      console.error("Pi prompt error after finalization:", formatError(error));
    } else {
      finalized = true;

      const combinedText = buildFinalResponseText(renderPromptFailure(accumulatedText, error));
      const chunks = splitMarkdownForTelegram(combinedText);
      try {
        await deliverRenderedChunks(chunks);
      } catch (telegramError) {
        console.error("Failed to send error message to Telegram:", telegramError);
      }
    }
    return "failed";
  } finally {
    stopTyping();
    clearFlushTimer();
    clearActivityFlushTimer();
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
