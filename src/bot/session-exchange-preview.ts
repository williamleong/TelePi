import type { PiSessionService } from "../pi-session.js";
import { renderSessionExchangePreview, type RenderedText } from "./message-rendering.js";

export type SessionExchangePreviewSender = (rendered: RenderedText) => Promise<void>;

export async function deliverSessionExchangePreview(
  piSession: PiSessionService,
  send: SessionExchangePreviewSender,
): Promise<void> {
  try {
    const preview = piSession.getLastExchangePreview();
    if (!preview) return;
    await send(renderSessionExchangePreview(preview));
  } catch (error) {
    console.error("Failed to deliver resumed session preview:", error);
  }
}
