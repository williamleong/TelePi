import type { Context } from "grammy";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import { escapeHTML } from "../../format.js";
import type { PiSessionContext, PiSessionRegistry, PiSessionService } from "../../pi-session.js";
import { renderFailedText, renderHelpHTML, renderHelpPlain, renderPrefixedError, renderSessionInfoHTML, renderSessionInfoPlain, renderVoiceSupportHTML, renderVoiceSupportPlain } from "../message-rendering.js";
import type { TextOptions } from "../telegram-transport.js";

export function createBasicCommandHandlers(deps: {
  sessionRegistry: PiSessionRegistry;
  getExistingSession: (target: PiSessionContext) => PiSessionService | undefined;
  getOrCreateSession: (target: PiSessionContext) => Promise<PiSessionService>;
  refreshChatScopedCommands: (target: PiSessionContext, piSession: PiSessionService) => Promise<void>;
  openCommandPicker: (ctx: Context, target: PiSessionContext) => Promise<void>;
  handleUserPrompt: (
    ctx: Context,
    target: PiSessionContext,
    userText: string,
    preloadedSlashCommands?: SlashCommandInfo[],
  ) => Promise<boolean>;
  getLastPrompt: (target: PiSessionContext) => string | undefined;
  isActivityEnabled: (target: PiSessionContext) => boolean;
  setActivityEnabled: (target: PiSessionContext, enabled: boolean) => void;
  extensionDialogs: { cancelPending: (target: PiSessionContext) => Promise<boolean> };
  getVoiceBackendStatus: () => Promise<{ backends: string[]; warning?: string }>;
  safeReply: (ctx: Context, text: string, options?: TextOptions, target?: PiSessionContext) => Promise<void>;
}) {
  const {
    sessionRegistry,
    getExistingSession,
    getOrCreateSession,
    refreshChatScopedCommands,
    openCommandPicker,
    handleUserPrompt,
    getLastPrompt,
    isActivityEnabled,
    setActivityEnabled,
    extensionDialogs,
    getVoiceBackendStatus,
    safeReply,
  } = deps;

  const handleStartCommand = async (ctx: Context, target: PiSessionContext): Promise<void> => {
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

    await refreshChatScopedCommands(target, piSession);
    const info = piSession.getInfo();
    let voiceStatus: { backends: string[]; warning?: string } = { backends: [] };
    try {
      voiceStatus = (await getVoiceBackendStatus()) ?? { backends: [] };
    } catch {
      // Keep /start working even if backend probing fails.
    }
    const voiceInfoPlain = renderVoiceSupportPlain(voiceStatus.backends, voiceStatus.warning);
    const voiceInfoHTML = renderVoiceSupportHTML(voiceStatus.backends, voiceStatus.warning);
    const plainText = [
      "TelePi is ready.",
      "",
      "Each Telegram chat/topic gets its own Pi session.",
      "Send any text message to continue the current Pi session from Telegram.",
      "Send a voice message or audio file to transcribe it into a Pi prompt.",
      "Use /help to see all commands. Use /retry to resend the last prompt in this chat/topic.",
      voiceInfoPlain,
      "",
      renderSessionInfoPlain(info),
    ].join("\n");
    const html = [
      "<b>TelePi is ready.</b>",
      "",
      "Each Telegram chat/topic gets its own Pi session.",
      "Send any text message to continue the current Pi session from Telegram.",
      "Send a voice message or audio file to transcribe it into a Pi prompt.",
      "Use <code>/help</code> to see all commands. Use <code>/retry</code> to resend the last prompt in this chat/topic.",
      voiceInfoHTML,
      "",
      renderSessionInfoHTML(info),
    ].join("\n");

    await safeReply(ctx, html, { fallbackText: plainText }, target);
  };

  const handleHelpCommand = async (ctx: Context, target: PiSessionContext): Promise<void> => {
    const info = sessionRegistry.getInfo(target);
    await safeReply(ctx, renderHelpHTML(info), {
      fallbackText: renderHelpPlain(info),
    }, target);
  };

  const handleCommandsCommand = async (ctx: Context, target: PiSessionContext): Promise<void> => {
    await openCommandPicker(ctx, target);
  };

  const handleAbortCommand = async (ctx: Context, target: PiSessionContext): Promise<void> => {
    await extensionDialogs.cancelPending(target);

    const piSession = getExistingSession(target);
    if (!piSession?.hasActiveSession()) {
      await safeReply(ctx, escapeHTML("No active session to abort."), {
        fallbackText: "No active session to abort.",
      }, target);
      return;
    }

    try {
      await piSession.abort();
      await safeReply(ctx, escapeHTML("Aborted current operation"), {
        fallbackText: "Aborted current operation",
      }, target);
    } catch (error) {
      const failure = renderFailedText(error);
      await safeReply(ctx, failure.text, {
        fallbackText: failure.fallbackText,
        parseMode: failure.parseMode,
      }, target);
    }
  };

  const handleSessionCommand = async (ctx: Context, target: PiSessionContext): Promise<void> => {
    const info = sessionRegistry.getInfo(target);
    await safeReply(ctx, renderSessionInfoHTML(info), {
      fallbackText: renderSessionInfoPlain(info),
    }, target);
  };

  const handleActivityCommand = async (ctx: Context, target: PiSessionContext): Promise<void> => {
    const argument = typeof ctx.match === "string" ? ctx.match.trim().toLowerCase() : "";

    if (argument === "on" || argument === "off") {
      setActivityEnabled(target, argument === "on");
    }

    const enabled = isActivityEnabled(target);
    const stateText = `Activity details: ${enabled ? "on" : "off"}`;
    const usageText = "Usage: /activity on|off";
    const invalid = argument !== "" && argument !== "on" && argument !== "off";
    const showUsage = argument === "" || invalid;
    const plainText = showUsage ? `${stateText}\n${usageText}` : stateText;

    await safeReply(ctx, escapeHTML(plainText), { fallbackText: plainText }, target);
  };

  const handleRetryCommand = async (ctx: Context, target: PiSessionContext): Promise<void> => {
    const lastPrompt = getLastPrompt(target);
    if (!lastPrompt) {
      await safeReply(ctx, escapeHTML("Nothing to retry yet in this chat/topic."), {
        fallbackText: "Nothing to retry yet in this chat/topic.",
      }, target);
      return;
    }

    await handleUserPrompt(ctx, target, lastPrompt);
  };

  return {
    handleStartCommand,
    handleHelpCommand,
    handleCommandsCommand,
    handleAbortCommand,
    handleSessionCommand,
    handleActivityCommand,
    handleRetryCommand,
  };
}
