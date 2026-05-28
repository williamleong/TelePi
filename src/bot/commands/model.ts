import { type Context } from "grammy";

import { escapeHTML } from "../../format.js";
import type { PiSessionContext, PiSessionInfo, PiSessionModelOption, PiSessionService } from "../../pi-session.js";
import { type KeyboardItem } from "../keyboard.js";
import { renderFailedText, renderPrefixedError, renderSessionInfoPlain, renderSessionInfoHTML } from "../message-rendering.js";
import type { TextOptions } from "../telegram-transport.js";

export function createModelCommandHandlers(deps: {
  getContextKey: (target: PiSessionContext) => string;
  getExistingSession: (target: PiSessionContext) => PiSessionService | undefined;
  getOrCreateSession: (target: PiSessionContext) => Promise<PiSessionService>;
  isBusy: (target: PiSessionContext) => boolean;
  refreshChatScopedCommands: (target: PiSessionContext, piSession: PiSessionService) => Promise<void>;
  pendingModelPicks: Map<string, PiSessionModelOption[]>;
  pendingModelButtons: Map<string, KeyboardItem[]>;
  pendingModelExtraButtons: Map<string, KeyboardItem[]>;
  buildKeyboard: (
    items: KeyboardItem[],
    page: number,
    prefix: string,
    extraItems?: KeyboardItem[],
  ) => any;
  safeReply: (ctx: Context, text: string, options?: TextOptions, target?: PiSessionContext) => Promise<void>;
  safeEditMessage: (target: PiSessionContext, messageId: number, text: string, options?: TextOptions) => Promise<void>;
  surfaceStartupErrorDiagnostics: (ctx: Context, target: PiSessionContext, info: PiSessionInfo) => Promise<void>;
}) {
  const {
    getContextKey,
    getExistingSession,
    getOrCreateSession,
    isBusy,
    refreshChatScopedCommands,
    pendingModelPicks,
    pendingModelButtons,
    pendingModelExtraButtons,
    buildKeyboard,
    safeReply,
    safeEditMessage,
    surfaceStartupErrorDiagnostics,
  } = deps;

  const renderModelPicker = async (
    ctx: Context,
    target: PiSessionContext,
    piSession: PiSessionService,
    options?: { showAll?: boolean; messageId?: number },
  ): Promise<void> => {
    const contextKey = getContextKey(target);
    const showAll = options?.showAll ?? false;
    const messageId = options?.messageId;
    const models = await piSession.listModels(showAll);

    if (models.length === 0) {
      const message = "No models available.";
      if (messageId) {
        await safeEditMessage(target, messageId, escapeHTML(message), { fallbackText: message });
      } else {
        await safeReply(ctx, escapeHTML(message), { fallbackText: message }, target);
      }
      return;
    }

    pendingModelPicks.set(contextKey, models);

    const modelButtons = models.map((model, index) => {
      const modelRef = `${model.provider}/${model.id}`;
      const nameSuffix = model.name && model.name !== model.id ? ` · ${model.name}` : "";
      const thinkingSuffix = model.thinkingLevel ? ` : ${model.thinkingLevel}` : "";
      return {
        label: `${model.current ? "✅ " : ""}${modelRef}${nameSuffix}${thinkingSuffix}`,
        callbackData: `model_${index}`,
      };
    });
    pendingModelButtons.set(contextKey, modelButtons);

    let extraButtons: KeyboardItem[] = [];
    if (!showAll) {
      const allModels = await piSession.listModels(true);
      if (allModels.length > models.length) {
        extraButtons = [{ label: "Show all models", callbackData: "model_show_all" }];
      }
    }
    pendingModelExtraButtons.set(contextKey, extraButtons);

    const info = piSession.getInfo();
    const currentModelText = info.model ? `Current: ${info.model}` : "No model selected";
    const scopeHint = extraButtons.length > 0 ? "Showing the current Pi model scope." : undefined;
    const html = ["<b>Select a model</b>", escapeHTML(currentModelText), scopeHint ? `<i>${escapeHTML(scopeHint)}</i>` : undefined]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    const fallbackText = ["Select a model", currentModelText, scopeHint]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    const replyMarkup = buildKeyboard(modelButtons, 0, "model", extraButtons);

    if (messageId) {
      await safeEditMessage(target, messageId, html, { fallbackText, replyMarkup });
      return;
    }

    await safeReply(ctx, html, { fallbackText, replyMarkup }, target);
  };

  const handleModelCommand = async (ctx: Context, target: PiSessionContext): Promise<void> => {
    const existing = getExistingSession(target);
    const hadActiveSession = existing?.hasActiveSession() === true;
    let piSession: PiSessionService;
    try {
      piSession = await getOrCreateSession(target);
    } catch (error) {
      const failure = renderPrefixedError("Failed to create session", error);
      await safeReply(ctx, failure.text, {
        fallbackText: failure.fallbackText,
        parseMode: failure.parseMode,
      }, target);
      return;
    }

    if (!piSession.hasActiveSession()) {
      try {
        await piSession.newSession();
      } catch (error) {
        const failure = renderPrefixedError("Failed to create session", error);
        await safeReply(ctx, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        }, target);
        return;
      }
    }

    if (!hadActiveSession) {
      await surfaceStartupErrorDiagnostics(ctx, target, piSession.getInfo());
    }

    await refreshChatScopedCommands(target, piSession);
    await renderModelPicker(ctx, target, piSession);
  };

  return {
    renderModelPicker,
    handleModelCommand,
  };
}
