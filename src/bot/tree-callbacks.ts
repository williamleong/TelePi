import { InlineKeyboard, type Bot, type Context } from "grammy";

import { escapeHTML } from "../format.js";
import type { PiSessionContext, PiSessionService } from "../pi-session.js";
import {
  renderBranchConfirmation,
  renderTree,
  truncateText,
  type TreeFilterMode,
} from "../tree.js";
import { renderFailedText, stripHtml } from "./message-rendering.js";
import type { KeyboardItem } from "./keyboard.js";
import type { TextOptions } from "./telegram-transport.js";
import { answerCallbackQuerySafely } from "./callback-query-logging.js";

export type PendingTreeView = {
  mode: TreeFilterMode;
};

export function registerTreeCallbacks(deps: {
  bot: Bot<Context>;
  getTelegramTarget: (ctx: Context) => PiSessionContext | undefined;
  getContextKey: (target: PiSessionContext) => string;
  getExistingSession: (target: PiSessionContext) => PiSessionService | undefined;
  isBusy: (target: PiSessionContext) => boolean;
  beginSwitching: (target: PiSessionContext) => void;
  endSwitching: (target: PiSessionContext) => void;
  pendingTreeViews: Map<string, PendingTreeView>;
  pendingTreeNavs: Map<string, string>;
  pendingBranchButtons: Map<string, KeyboardItem[]>;
  setPendingTreeView: (contextKey: string, mode: TreeFilterMode) => void;
  clearPendingTreeView: (contextKey: string) => void;
  buildTreeKeyboard: (items: KeyboardItem[]) => InlineKeyboard;
  buildKeyboard: (items: KeyboardItem[], page: number, prefix: string, extraItems?: KeyboardItem[]) => InlineKeyboard;
  collectLabelsMap: (piSession: PiSessionService) => Map<string, string>;
  safeReply: (ctx: Context, text: string, options?: TextOptions, target?: PiSessionContext) => Promise<void>;
  safeEditMessage: (target: PiSessionContext, messageId: number, text: string, options?: TextOptions) => Promise<void>;
}) {
  const {
    bot,
    getTelegramTarget,
    getContextKey,
    getExistingSession,
    isBusy,
    beginSwitching,
    endSwitching,
    pendingTreeViews,
    pendingTreeNavs,
    pendingBranchButtons,
    setPendingTreeView,
    clearPendingTreeView,
    buildTreeKeyboard,
    buildKeyboard,
    collectLabelsMap,
    safeReply,
    safeEditMessage,
  } = deps;

  const updateNavigationResult = async (
    ctx: Context,
    target: PiSessionContext,
    messageId: number | undefined,
    entryId: string,
    result: { editorText?: string; cancelled: boolean },
    options?: { summarize?: boolean },
  ): Promise<void> => {
    if (result.cancelled) {
      const html = escapeHTML("Navigation cancelled.");
      if (messageId) {
        await safeEditMessage(target, messageId, html, { fallbackText: "Navigation cancelled." });
      } else {
        await safeReply(ctx, "Navigation cancelled.", { fallbackText: "Navigation cancelled.", parseMode: undefined }, target);
      }
      return;
    }

    let html = `<b>✅ Navigated to</b> <code>${escapeHTML(entryId.slice(0, 8))}</code>`;
    let plain = `✅ Navigated to ${entryId.slice(0, 8)}`;
    if (options?.summarize) {
      html += "\n📝 Branch summary saved.";
      plain += "\n📝 Branch summary saved.";
    }
    if (result.editorText) {
      html += `\n\nRe-submit: <i>${escapeHTML(truncateText(result.editorText, 200))}</i>`;
      plain += `\n\nRe-submit: ${truncateText(result.editorText, 200)}`;
    }
    html += "\n\nSend your next message to create a new branch from this point.";
    plain += "\n\nSend your next message to create a new branch from this point.";

    if (messageId) {
      await safeEditMessage(target, messageId, html, { fallbackText: plain });
      return;
    }

    await safeReply(ctx, html, { fallbackText: plain }, target);
  };

  const handleTreeNavigation = async (
    ctx: Context,
    target: PiSessionContext,
    entryId: string,
    options?: { summarize?: boolean; busyText?: string; expiredText?: string },
  ): Promise<void> => {
    const messageId = ctx.callbackQuery?.message?.message_id;
    const contextKey = getContextKey(target);
    const piSession = getExistingSession(target);

    if (isBusy(target)) {
      await answerCallbackQuerySafely(ctx, { text: "Wait for the current prompt to finish" });
      return;
    }

    const pendingId = pendingTreeNavs.get(contextKey);
    if (pendingId !== entryId || !piSession) {
      await answerCallbackQuerySafely(ctx, { text: options?.expiredText ?? "Confirmation expired. Use /branch again." });
      return;
    }

    await answerCallbackQuerySafely(ctx, { text: options?.busyText ?? "Navigating..." });
    pendingTreeNavs.delete(contextKey);
    pendingBranchButtons.delete(contextKey);
    clearPendingTreeView(contextKey);

    beginSwitching(target);
    try {
      const result = options?.summarize
        ? await piSession.navigateTree(entryId, { summarize: true })
        : await piSession.navigateTree(entryId);
      await updateNavigationResult(ctx, target, messageId, entryId, result, options);
    } catch (error) {
      const failure = renderFailedText(error);
      if (messageId) {
        await safeEditMessage(target, messageId, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        });
      } else {
        await safeReply(ctx, failure.text, {
          fallbackText: failure.fallbackText,
          parseMode: failure.parseMode,
        }, target);
      }
    } finally {
      endSwitching(target);
    }
  };

  bot.callbackQuery(/^tree_page_(\d+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery?.message?.message_id;
    const page = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!target || !messageId || Number.isNaN(page)) {
      await answerCallbackQuerySafely(ctx);
      return;
    }

    const contextKey = getContextKey(target);
    const pendingTreeView = pendingTreeViews.get(contextKey);
    if (!pendingTreeView) {
      await answerCallbackQuerySafely(ctx, { text: "Expired, run /tree again" });
      return;
    }

    if (isBusy(target)) {
      await answerCallbackQuerySafely(ctx, { text: "Wait for the current prompt to finish" });
      return;
    }

    const piSession = getExistingSession(target);
    if (!piSession?.hasActiveSession()) {
      await answerCallbackQuerySafely(ctx, { text: "No active session" });
      return;
    }

    const result = renderTree(piSession.getTree(), piSession.getLeafId(), {
      mode: pendingTreeView.mode,
      page,
    });

    await answerCallbackQuerySafely(ctx);
    await safeEditMessage(target, messageId, result.text, {
      fallbackText: stripHtml(result.text),
      replyMarkup: result.buttons.length > 0 ? buildTreeKeyboard(result.buttons) : undefined,
    });
  });

  bot.callbackQuery(/^tree_nav_(.+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery?.message?.message_id;
    const entryId = ctx.match?.[1];
    if (!target || !entryId) {
      await answerCallbackQuerySafely(ctx);
      return;
    }

    const contextKey = getContextKey(target);
    const piSession = getExistingSession(target);

    if (isBusy(target)) {
      await answerCallbackQuerySafely(ctx, { text: "Wait for the current prompt to finish" });
      return;
    }

    if (!piSession?.hasActiveSession()) {
      await answerCallbackQuerySafely(ctx, { text: "No active session" });
      return;
    }

    const entry = piSession.getEntry(entryId);
    if (!entry) {
      await answerCallbackQuerySafely(ctx, { text: "Entry not found" });
      return;
    }

    const leafId = piSession.getLeafId();
    if (entry.id === leafId) {
      await answerCallbackQuerySafely(ctx, { text: "Already at this point" });
      return;
    }

    await answerCallbackQuerySafely(ctx, { text: "Loading..." });

    const confirmation = renderBranchConfirmation(
      entry,
      piSession.getChildren(entry.id),
      leafId,
      collectLabelsMap(piSession),
    );
    pendingTreeNavs.set(contextKey, entry.id);
    pendingBranchButtons.set(contextKey, confirmation.buttons);

    const keyboard = buildKeyboard(confirmation.buttons, 0, "branch");

    if (messageId) {
      await safeEditMessage(target, messageId, confirmation.text, {
        fallbackText: stripHtml(confirmation.text),
        replyMarkup: keyboard,
      });
    } else {
      await safeReply(ctx, confirmation.text, {
        fallbackText: stripHtml(confirmation.text),
        replyMarkup: keyboard,
      }, target);
    }
  });

  bot.callbackQuery(/^tree_go_(.+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const entryId = ctx.match?.[1];
    if (!target || !entryId) {
      await answerCallbackQuerySafely(ctx);
      return;
    }

    await handleTreeNavigation(ctx, target, entryId);
  });

  bot.callbackQuery(/^tree_sum_(.+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const entryId = ctx.match?.[1];
    if (!target || !entryId) {
      await answerCallbackQuerySafely(ctx);
      return;
    }

    await handleTreeNavigation(ctx, target, entryId, {
      summarize: true,
      busyText: "Navigating with summary...",
    });
  });

  bot.callbackQuery("tree_cancel", async (ctx) => {
    const target = getTelegramTarget(ctx);
    if (target) {
      const contextKey = getContextKey(target);
      pendingTreeNavs.delete(contextKey);
      pendingBranchButtons.delete(contextKey);
      clearPendingTreeView(contextKey);
    }
    await answerCallbackQuerySafely(ctx, { text: "Cancelled" });
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (target && messageId) {
      await safeEditMessage(target, messageId, escapeHTML("Navigation cancelled."), {
        fallbackText: "Navigation cancelled.",
      });
    }
  });

  bot.callbackQuery(/^tree_mode_(.+)$/, async (ctx) => {
    const target = getTelegramTarget(ctx);
    const messageId = ctx.callbackQuery?.message?.message_id;
    const mode = ctx.match?.[1];
    if (!target || !messageId) {
      await answerCallbackQuerySafely(ctx);
      return;
    }

    const contextKey = getContextKey(target);
    const pendingTreeView = pendingTreeViews.get(contextKey);
    if (!pendingTreeView) {
      await answerCallbackQuerySafely(ctx, { text: "Expired, run /tree again" });
      return;
    }

    if (isBusy(target)) {
      await answerCallbackQuerySafely(ctx, { text: "Wait for the current prompt to finish" });
      return;
    }

    const piSession = getExistingSession(target);
    if (!piSession?.hasActiveSession()) {
      await answerCallbackQuerySafely(ctx, { text: "No active session" });
      return;
    }

    await answerCallbackQuerySafely(ctx);

    let filterMode: TreeFilterMode = "default";
    if (mode === "all") {
      filterMode = "all-with-buttons";
    } else if (mode === "user") {
      filterMode = "user-only";
    }

    const result = renderTree(piSession.getTree(), piSession.getLeafId(), { mode: filterMode });
    const keyboard = result.buttons.length > 0 ? buildTreeKeyboard(result.buttons) : undefined;

    if (keyboard) {
      setPendingTreeView(contextKey, filterMode);
    } else {
      clearPendingTreeView(contextKey);
    }

    await safeEditMessage(target, messageId, result.text, {
      fallbackText: stripHtml(result.text),
      replyMarkup: keyboard,
    });
  });
}
