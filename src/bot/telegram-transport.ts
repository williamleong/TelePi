import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { type InlineKeyboard, Bot, type Context } from "grammy";

import {
  isMessageNotModifiedError,
  isTelegramParseError,
  splitTelegramText,
  type TelegramParseMode,
} from "./message-rendering.js";
import type { PiSessionContext } from "../pi-session.js";

export type TextOptions = {
  parseMode?: TelegramParseMode;
  fallbackText?: string;
  replyMarkup?: InlineKeyboard;
  onSentMessage?: (message: { message_id: number }) => void;
};

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

export function getTelegramTarget(ctx: Context): PiSessionContext | undefined {
  const chatId = ctx.chat?.id;
  if (chatId === undefined || chatId === null) {
    return undefined;
  }

  const messageThreadId =
    ctx.message?.message_thread_id ??
    (ctx.callbackQuery?.message && "message_thread_id" in ctx.callbackQuery.message
      ? ctx.callbackQuery.message.message_thread_id
      : undefined);

  return messageThreadId !== undefined ? { chatId, messageThreadId } : { chatId };
}

export async function safeReply(
  ctx: Context,
  text: string,
  options: TextOptions = {},
  target = getTelegramTarget(ctx),
): Promise<void> {
  if (!target) {
    return;
  }

  const parseMode = options.parseMode !== undefined ? options.parseMode : ("HTML" as TelegramParseMode);

  const chunks = splitTelegramText(text);
  const fallbackChunks = options.fallbackText ? splitTelegramText(options.fallbackText) : [];

  for (const [index, chunk] of chunks.entries()) {
    await sendTextMessage(ctx.api, target, chunk, {
      parseMode,
      fallbackText: fallbackChunks[index] ?? chunk,
      replyMarkup: index === 0 ? options.replyMarkup : undefined,
      onSentMessage: index === 0 ? options.onSentMessage : undefined,
    });
  }
}

export async function sendTextMessage(
  api: Context["api"],
  target: PiSessionContext,
  text: string,
  options: TextOptions = {},
): Promise<{ message_id: number }> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode")
    ? options.parseMode
    : "HTML";

  try {
    const message = await api.sendMessage(target.chatId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(target.messageThreadId !== undefined ? { message_thread_id: target.messageThreadId } : {}),
      reply_markup: options.replyMarkup,
    });
    options.onSentMessage?.(message);
    return message;
  } catch (error) {
    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      const message = await api.sendMessage(target.chatId, options.fallbackText, {
        ...(target.messageThreadId !== undefined ? { message_thread_id: target.messageThreadId } : {}),
        reply_markup: options.replyMarkup,
      });
      options.onSentMessage?.(message);
      return message;
    }
    throw error;
  }
}

export async function safeEditMessage(
  bot: Bot<Context>,
  target: PiSessionContext,
  messageId: number,
  text: string,
  options: TextOptions = {},
): Promise<void> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode")
    ? options.parseMode
    : "HTML";

  try {
    await bot.api.editMessageText(target.chatId, messageId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return;
    }

    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      await bot.api.editMessageText(target.chatId, messageId, options.fallbackText, {
        reply_markup: options.replyMarkup,
      });
      return;
    }

    throw error;
  }
}

export async function sendChatAction(
  api: Context["api"],
  target: PiSessionContext,
  action: "typing",
): Promise<void> {
  await api.sendChatAction(target.chatId, action, {
    ...(target.messageThreadId !== undefined ? { message_thread_id: target.messageThreadId } : {}),
  });
}

export async function downloadTelegramFile(
  api: Context["api"],
  token: string,
  fileId: string,
  options: {
    maxFileSizeBytes?: number;
    fileKind?: string;
    tempFilePrefix?: string;
  } = {},
): Promise<string> {
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not return a file path");
  }

  const maxFileSizeBytes = options.maxFileSizeBytes ?? MAX_FILE_SIZE;
  const label = options.fileKind ?? "File";
  if (file.file_size && file.file_size > maxFileSizeBytes) {
    throw createFileTooLargeError(label, file.file_size, maxFileSizeBytes);
  }

  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${options.fileKind ?? "voice file"}: ${response.status}`);
  }

  const contentLength = parseContentLength(response.headers?.get?.("content-length") ?? null);
  if (contentLength !== undefined && contentLength > maxFileSizeBytes) {
    throw createFileTooLargeError(label, contentLength, maxFileSizeBytes);
  }

  const extension = path.extname(file.file_path) || ".ogg";
  const tempPrefix = options.tempFilePrefix ?? "telepi-voice";
  const tempPath = path.join(tmpdir(), `${tempPrefix}-${randomUUID()}${extension}`);

  try {
    await streamResponseToFile(response, tempPath, maxFileSizeBytes, label);
    return tempPath;
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function streamResponseToFile(
  response: Response,
  tempPath: string,
  maxFileSizeBytes: number,
  label: string,
): Promise<void> {
  const fileHandle = await open(tempPath, "w");
  let bytesWritten = 0;

  try {
    if (!response.body) {
      const buffer = Buffer.from(await response.arrayBuffer());
      bytesWritten = buffer.byteLength;
      if (bytesWritten > maxFileSizeBytes) {
        throw createFileTooLargeError(label, bytesWritten, maxFileSizeBytes);
      }
      await fileHandle.writeFile(buffer);
      return;
    }

    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        bytesWritten += value.byteLength;
        if (bytesWritten > maxFileSizeBytes) {
          await reader.cancel().catch(() => {});
          throw createFileTooLargeError(label, bytesWritten, maxFileSizeBytes);
        }

        await fileHandle.write(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    await fileHandle.close();
  }
}

function createFileTooLargeError(label: string, actualBytes: number, maxBytes: number): Error {
  return new Error(`${label} too large (${formatMegabytes(actualBytes)} MB, max ${formatMegabytes(maxBytes)} MB)`);
}

function formatMegabytes(bytes: number): number {
  return Math.ceil(bytes / 1024 / 1024);
}
