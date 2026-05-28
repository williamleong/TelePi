import { rmSync } from "node:fs";

import { InlineKeyboard } from "grammy";

import {
  downloadTelegramFile,
  getTelegramTarget,
  safeEditMessage,
  safeReply,
  sendTextMessage,
} from "../../src/bot/telegram-transport.js";

describe("bot telegram transport helpers", () => {
  it("derives the Telegram target from messages and callback queries", () => {
    expect(
      getTelegramTarget({
        chat: { id: 123 },
        message: { message_thread_id: 456 },
      } as any),
    ).toEqual({ chatId: 123, messageThreadId: 456 });

    expect(
      getTelegramTarget({
        chat: { id: 123 },
        callbackQuery: {
          message: {
            message_thread_id: 789,
          },
        },
      } as any),
    ).toEqual({ chatId: 123, messageThreadId: 789 });

    expect(getTelegramTarget({} as any)).toBeUndefined();
  });

  it("sends text messages with HTML parse mode and falls back on Telegram parse errors", async () => {
    const api = {
      sendMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
        .mockResolvedValueOnce({ message_id: 11 }),
    };

    const result = await sendTextMessage(api as any, { chatId: 123, messageThreadId: 456 }, "<b>bad</b>", {
      parseMode: "HTML",
      fallbackText: "plain text",
    });

    expect(result).toEqual({ message_id: 11 });
    expect(api.sendMessage).toHaveBeenNthCalledWith(1, 123, "<b>bad</b>", {
      parse_mode: "HTML",
      message_thread_id: 456,
      reply_markup: undefined,
    });
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, 123, "plain text", {
      message_thread_id: 456,
      reply_markup: undefined,
    });
  });

  it("splits long replies and only attaches reply markup to the first chunk", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    };
    const keyboard = new InlineKeyboard().text("Abort", "abort");
    const ctx = {
      api,
      chat: { id: 123 },
      message: { message_thread_id: 456 },
    } as any;

    await safeReply(ctx, `${"a".repeat(3900)}\n${"b".repeat(3900)}`, {
      fallbackText: `${"a".repeat(3900)}\n${"b".repeat(3900)}`,
      replyMarkup: keyboard,
    });

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage.mock.calls[0]?.[2]).toMatchObject({
      parse_mode: "HTML",
      message_thread_id: 456,
      reply_markup: keyboard,
    });
    expect(api.sendMessage.mock.calls[1]?.[2]).toMatchObject({
      parse_mode: "HTML",
      message_thread_id: 456,
      reply_markup: undefined,
    });
  });

  it("rejects Telegram downloads that exceed the byte limit while streaming", async () => {
    const api = {
      getFile: vi.fn().mockResolvedValue({
        file_path: "photos/large.jpg",
      }),
    };
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(new Response("12345", { status: 200 }));
    globalThis.fetch = fetchMock;
    let downloadedPath: string | undefined;

    try {
      await expect(
        downloadTelegramFile(api as any, "bot-token", "file-id", {
          fileKind: "image file",
          maxFileSizeBytes: 4,
        }).then((filePath) => {
          downloadedPath = filePath;
          return filePath;
        }),
      ).rejects.toThrow("image file too large");
    } finally {
      globalThis.fetch = originalFetch;
      if (downloadedPath) {
        rmSync(downloadedPath, { force: true });
      }
    }
  });

  it("ignores not-modified edits and falls back to plain text on parse errors", async () => {
    const bot = {
      api: {
        editMessageText: vi
          .fn()
          .mockRejectedValueOnce(new Error("Bad Request: message is not modified"))
          .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
          .mockResolvedValueOnce(true),
      },
    };

    await expect(
      safeEditMessage(bot as any, { chatId: 123 }, 1, "same", { fallbackText: "same" }),
    ).resolves.toBeUndefined();

    await expect(
      safeEditMessage(bot as any, { chatId: 123 }, 2, "<b>bad</b>", {
        fallbackText: "plain",
      }),
    ).resolves.toBeUndefined();

    expect(bot.api.editMessageText).toHaveBeenNthCalledWith(2, 123, 2, "<b>bad</b>", {
      parse_mode: "HTML",
      reply_markup: undefined,
    });
    expect(bot.api.editMessageText).toHaveBeenNthCalledWith(3, 123, 2, "plain", {
      reply_markup: undefined,
    });
  });
});
