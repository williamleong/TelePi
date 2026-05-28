import type { Context } from "grammy";

import { formatError } from "../errors.js";

export const COMMAND_MENU_CALLBACK_PREFIX = "cmdm_";

const STALE_CALLBACK_LOG_WINDOW_MS = 30_000;
const staleCallbackLogState = new Map<string, { lastLoggedAt: number; suppressed: number }>();

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function isStaleCallbackQueryError(error: unknown): boolean {
  const message = formatError(error).trim().toLowerCase();
  return (
    message.includes("query is too old") ||
    message.includes("query too old") ||
    message.includes("query_id_invalid")
  );
}

export function describeCallbackQuerySource(callbackData: string | undefined): string {
  if (!callbackData) {
    return "callback.unknown";
  }

  if (callbackData.startsWith("cmdm_")) {
    return "native.command-menu";
  }

  if (callbackData.startsWith("ui_sel_")) {
    return "extension.select";
  }

  if (callbackData.startsWith("ui_cfm_")) {
    return "extension.confirm";
  }

  if (callbackData.startsWith("ui_x_")) {
    return "extension.cancel";
  }

  if (callbackData.startsWith("tree_")) {
    return "tree";
  }

  if (callbackData.startsWith("switch_")) {
    return "session.switch";
  }

  if (callbackData.startsWith("newws_")) {
    return "session.new-workspace";
  }

  if (callbackData.startsWith("model_")) {
    return "model";
  }

  if (callbackData.startsWith("cmd_")) {
    return "command-picker";
  }

  if (callbackData === "pi_abort") {
    return "abort";
  }

  if (callbackData === "noop_page") {
    return "pagination.noop";
  }

  const prefix = callbackData.split("_", 1)[0];
  return prefix ? `callback.${prefix}` : "callback.unknown";
}

function buildCallbackDetails(
  ctx: Pick<Context, "callbackQuery">,
  options?: { responseText?: string },
): string {
  const details: string[] = [];
  const callbackData = ctx.callbackQuery?.data;

  if (callbackData) {
    details.push(`data=${truncate(callbackData, 80)}`);
  }

  if (options?.responseText) {
    details.push(`reply=${JSON.stringify(truncate(options.responseText, 80))}`);
  }

  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

export async function answerCallbackQuerySafely(
  ctx: Context,
  options?: Parameters<Context["answerCallbackQuery"]>[0],
  logOptions?: { source?: string },
): Promise<void> {
  const responseText = typeof options === "object" && options !== null && "text" in options
    ? options.text
    : undefined;

  try {
    await ctx.answerCallbackQuery(options);
  } catch (error) {
    logCallbackQueryError(ctx, error, {
      phase: "answer",
      source: logOptions?.source,
      responseText,
    });
  }
}

export function logCallbackQueryError(
  ctx: Pick<Context, "callbackQuery">,
  error: unknown,
  options?: { source?: string; phase?: "answer" | "handler"; responseText?: string },
): void {
  const message = formatError(error).trim();
  const source = options?.source ?? describeCallbackQuerySource(ctx.callbackQuery?.data);
  const action = options?.phase === "handler" ? "callback query" : "callback answer";
  const details = buildCallbackDetails(ctx, { responseText: options?.responseText });

  if (!isStaleCallbackQueryError(error)) {
    console.error(`Failed Telegram ${action} [${source}]${details}: ${message}`);
    return;
  }

  const key = `${source}|${message.toLowerCase()}`;
  const now = Date.now();
  const previous = staleCallbackLogState.get(key);

  if (previous && now - previous.lastLoggedAt < STALE_CALLBACK_LOG_WINDOW_MS) {
    previous.suppressed += 1;
    staleCallbackLogState.set(key, previous);
    return;
  }

  const suppressedSuffix = previous?.suppressed ? ` (+${previous.suppressed} similar suppressed)` : "";
  staleCallbackLogState.set(key, { lastLoggedAt: now, suppressed: 0 });
  console.error(`Ignored stale Telegram ${action} [${source}]${details}: ${message}${suppressedSuffix}`);
}

export function resetCallbackQueryLogStateForTests(): void {
  staleCallbackLogState.clear();
}
