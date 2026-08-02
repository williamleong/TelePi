import { createExtensionDialogManager } from "../../src/bot/extension-dialogs.js";
import { renderDialogPanel } from "../../src/bot/message-rendering.js";
import type { PiSessionContext } from "../../src/pi-session.js";

describe("extension dialog manager", () => {
  const target: PiSessionContext = { chatId: 123 };
  const topicTarget: PiSessionContext = { chatId: 123, messageThreadId: 77 };
  const rootTarget: PiSessionContext = { chatId: 123 };

  function createManager() {
    const sendTextMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const manager = createExtensionDialogManager({
      getContextKey: (ctx) => `${String(ctx.chatId)}::${ctx.messageThreadId ?? "root"}`,
      sendTextMessage,
      editMessage,
    });

    return { manager, sendTextMessage, editMessage };
  }

  it("opens and resolves select dialogs after the callback answer step", async () => {
    const { manager, sendTextMessage, editMessage } = createManager();

    const pendingChoice = manager.openSelect(target, "Pick one", ["Alpha — Stop deployment", "Beta — Continue deployment"]);
    await Promise.resolve();

    const opened = renderDialogPanel("Pick one", [
      "1. Alpha — Stop deployment",
      "2. Beta — Continue deployment",
      "Use the buttons below.",
    ], "🧭");
    expect(sendTextMessage).toHaveBeenCalledWith(target, opened.text, expect.objectContaining({
      fallbackText: opened.fallbackText,
      parseMode: "HTML",
    }));

    const result = await manager.resolveSelect(target, "1", 1, 1);
    expect(result.callbackText).toBe("Selected Beta — Continue deployment");
    expect(editMessage).not.toHaveBeenCalled();

    await result.afterAnswer?.();

    const selected = renderDialogPanel("Pick one", ["Selected: Beta — Continue deployment"], "✅");
    expect(editMessage).toHaveBeenCalledWith(
      target,
      1,
      selected.text,
      expect.objectContaining({ fallbackText: selected.fallbackText, parseMode: "HTML" }),
    );
    await expect(pendingChoice).resolves.toBe("Beta — Continue deployment");
  });

  it("keeps dialogs without an explicit timeout pending", async () => {
    const { manager, editMessage } = createManager();

    vi.useFakeTimers();
    try {
      const pending = manager.openSelect(target, "Pick one", ["Alpha", "Beta"]);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(manager.hasPending(target)).toBe(true);
      expect(editMessage).not.toHaveBeenCalled();
      await manager.cancelPending(target);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves select dialogs by dialogId when the callback target loses its thread context", async () => {
    const { manager, editMessage } = createManager();

    const pendingChoice = manager.openSelect(topicTarget, "Pick one", ["Alpha", "Beta"]);
    await Promise.resolve();

    const result = await manager.resolveSelect(rootTarget, "1", 1, 1);
    expect(result.callbackText).toBe("Selected Beta");

    await result.afterAnswer?.();

    const selected = renderDialogPanel("Pick one", ["Selected: Beta"], "✅");
    expect(editMessage).toHaveBeenCalledWith(
      rootTarget,
      1,
      selected.text,
      expect.objectContaining({ fallbackText: selected.fallbackText, parseMode: "HTML" }),
    );
    await expect(pendingChoice).resolves.toBe("Beta");
  });

  it("times out dialogs and finalizes them in Telegram", async () => {
    const { manager, editMessage } = createManager();

    const pendingInput = manager.openInput(target, "Name", "Your name", { timeout: 5 });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(pendingInput).resolves.toBeUndefined();
    const timedOut = renderDialogPanel("Name", ["Dialog timed out."], "⏰");
    expect(editMessage).toHaveBeenCalledWith(
      target,
      1,
      timedOut.text,
      expect.objectContaining({ fallbackText: timedOut.fallbackText, parseMode: "HTML" }),
    );
  });

  it("consumes input replies and can cancel pending dialogs", async () => {
    const { manager, editMessage } = createManager();

    expect(await manager.consumeInput(target, "Bene")).toBe(false);

    const pendingInput = manager.openInput(target, "Name", "Your name");
    await Promise.resolve();
    expect(manager.getPendingKind(target)).toBe("input");

    await expect(manager.consumeInput(target, "Bene")).resolves.toBe(true);
    await expect(pendingInput).resolves.toBe("Bene");
    const received = renderDialogPanel("Name", ["Received: Bene"], "✅");
    expect(editMessage).toHaveBeenCalledWith(
      target,
      1,
      received.text,
      expect.objectContaining({ fallbackText: received.fallbackText, parseMode: "HTML" }),
    );

    const pendingConfirm = manager.openConfirm(target, "Confirm deploy", "Ship it?");
    await Promise.resolve();
    await expect(manager.cancelPending(target)).resolves.toBe(true);
    await expect(pendingConfirm).resolves.toBe(false);
    const cancelled = renderDialogPanel("Confirm deploy", ["Dialog cancelled."], "⛔");
    expect(editMessage).toHaveBeenLastCalledWith(
      target,
      1,
      cancelled.text,
      expect.objectContaining({ fallbackText: cancelled.fallbackText, parseMode: "HTML" }),
    );
  });

  it("resolves confirm and cancel callbacks after the callback answer step", async () => {
    const { manager, editMessage } = createManager();

    const pendingConfirm = manager.openConfirm(target, "Confirm deploy", "Ship it?");
    await Promise.resolve();

    const confirmResult = await manager.resolveConfirm(target, "1", 1, true);
    expect(confirmResult.callbackText).toBe("Confirmed");
    expect(editMessage).not.toHaveBeenCalled();
    await confirmResult.afterAnswer?.();
    await expect(pendingConfirm).resolves.toBe(true);
    const confirmed = renderDialogPanel("Confirm deploy", ["Confirmed."], "✅");
    expect(editMessage).toHaveBeenCalledWith(
      target,
      1,
      confirmed.text,
      expect.objectContaining({ fallbackText: confirmed.fallbackText, parseMode: "HTML" }),
    );

    const pendingSelect = manager.openSelect(target, "Pick one", ["Alpha"]);
    await Promise.resolve();
    const cancelResult = await manager.resolveCancel(target, "2", 1);
    expect(cancelResult.callbackText).toBe("Cancelled");
    await cancelResult.afterAnswer?.();
    await expect(pendingSelect).resolves.toBeUndefined();
  });

  it("resolves confirm and cancel callbacks by dialogId even when callback message IDs are missing", async () => {
    const { manager, editMessage } = createManager();

    const pendingConfirm = manager.openConfirm(topicTarget, "Confirm deploy", "Ship it?");
    await Promise.resolve();

    const confirmResult = await manager.resolveConfirm(rootTarget, "1", undefined, true);
    expect(confirmResult.callbackText).toBe("Confirmed");
    await confirmResult.afterAnswer?.();
    await expect(pendingConfirm).resolves.toBe(true);
    const confirmed = renderDialogPanel("Confirm deploy", ["Confirmed."], "✅");
    expect(editMessage).toHaveBeenCalledWith(
      rootTarget,
      1,
      confirmed.text,
      expect.objectContaining({ fallbackText: confirmed.fallbackText, parseMode: "HTML" }),
    );

    editMessage.mockClear();

    const pendingInput = manager.openInput(topicTarget, "Name", "Your name");
    await Promise.resolve();

    const cancelResult = await manager.resolveCancel(rootTarget, "2", undefined);
    expect(cancelResult.callbackText).toBe("Cancelled");
    await cancelResult.afterAnswer?.();
    await expect(pendingInput).resolves.toBeUndefined();
    const cancelled = renderDialogPanel("Name", ["Dialog cancelled."], "⛔");
    expect(editMessage).toHaveBeenCalledWith(
      rootTarget,
      1,
      cancelled.text,
      expect.objectContaining({ fallbackText: cancelled.fallbackText, parseMode: "HTML" }),
    );
  });

  it("still resolves extension promises when finalizing the dialog message fails", async () => {
    const sendTextMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    const editMessage = vi.fn().mockRejectedValue(new Error("telegram down"));
    const manager = createExtensionDialogManager({
      getContextKey: (ctx) => `${String(ctx.chatId)}::${ctx.messageThreadId ?? "root"}`,
      sendTextMessage,
      editMessage,
    });

    const pendingChoice = manager.openSelect(target, "Pick one", ["Alpha"]);
    await Promise.resolve();

    const result = await manager.resolveSelect(target, "1", 1, 0);
    await expect(result.afterAnswer?.()).rejects.toThrow("telegram down");
    await expect(pendingChoice).resolves.toBe("Alpha");
  });
});
