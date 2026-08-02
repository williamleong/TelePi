import { describe, expect, it, vi } from "vitest";
import { deliverSessionExchangePreview } from "../../src/bot/session-exchange-preview.js";

it("delivers a rendered preview when one exists", async () => {
  const piSession = {
    getLastExchangePreview: vi.fn().mockReturnValue({ userText: "Question", assistantText: "Answer" }),
  } as any;
  const send = vi.fn().mockResolvedValue(undefined);

  await deliverSessionExchangePreview(piSession, send);

  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    fallbackText: expect.stringContaining("Question\n\nPi\nAnswer"),
  }));
});

it("does nothing without a completed exchange", async () => {
  const piSession = { getLastExchangePreview: vi.fn().mockReturnValue(undefined) } as any;
  const send = vi.fn();
  await deliverSessionExchangePreview(piSession, send);
  expect(send).not.toHaveBeenCalled();
});

it("logs and suppresses preview failures", async () => {
  const piSession = {
    getLastExchangePreview: vi.fn().mockReturnValue({ userText: "Question", assistantText: "Answer" }),
  } as any;
  const send = vi.fn().mockRejectedValue(new Error("Telegram unavailable"));
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

  await expect(deliverSessionExchangePreview(piSession, send)).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledWith("Failed to deliver resumed session preview:", expect.any(Error));
  log.mockRestore();
});

it("logs a preview lookup failure without sending", async () => {
  const piSession = {
    getLastExchangePreview: vi.fn().mockImplementation(() => {
      throw new Error("Session context unavailable");
    }),
  } as any;
  const send = vi.fn();
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

  await expect(deliverSessionExchangePreview(piSession, send)).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledWith("Failed to deliver resumed session preview:", expect.any(Error));
  expect(send).not.toHaveBeenCalled();
  log.mockRestore();
});
