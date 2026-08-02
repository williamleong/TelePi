import type { PiSessionContext } from "../pi-session.js";
import { getPiSessionContextKey } from "../pi-session.js";

export interface BotChatState {
  isLocallyBusy(target: PiSessionContext): boolean;
  beginProcessing(target: PiSessionContext, promptText: string): void;
  endProcessing(target: PiSessionContext): void;
  beginSwitching(target: PiSessionContext): void;
  endSwitching(target: PiSessionContext): void;
  beginTranscribing(target: PiSessionContext): void;
  endTranscribing(target: PiSessionContext): void;
  getLastPrompt(target: PiSessionContext): string | undefined;
  clearPromptMemory(target: PiSessionContext): void;
  readonly isActivityEnabled: (target: PiSessionContext) => boolean;
  readonly setActivityEnabled: (target: PiSessionContext, enabled: boolean) => void;
}

export function createBotChatState(): BotChatState {
  const processingContexts = new Set<string>();
  const switchingContexts = new Set<string>();
  const transcribingContexts = new Set<string>();
  const lastPrompts = new Map<string, string>();
  const activityDisabledContexts = new Set<string>();

  const getContextKey = (target: PiSessionContext): string => getPiSessionContextKey(target);

  return {
    isLocallyBusy(target) {
      const contextKey = getContextKey(target);
      return (
        processingContexts.has(contextKey) ||
        switchingContexts.has(contextKey) ||
        transcribingContexts.has(contextKey)
      );
    },

    beginProcessing(target, promptText) {
      const contextKey = getContextKey(target);
      processingContexts.add(contextKey);
      lastPrompts.set(contextKey, promptText);
    },

    endProcessing(target) {
      processingContexts.delete(getContextKey(target));
    },

    beginSwitching(target) {
      switchingContexts.add(getContextKey(target));
    },

    endSwitching(target) {
      switchingContexts.delete(getContextKey(target));
    },

    beginTranscribing(target) {
      transcribingContexts.add(getContextKey(target));
    },

    endTranscribing(target) {
      transcribingContexts.delete(getContextKey(target));
    },

    getLastPrompt(target) {
      return lastPrompts.get(getContextKey(target));
    },

    clearPromptMemory(target) {
      lastPrompts.delete(getContextKey(target));
    },

    isActivityEnabled(target) {
      return !activityDisabledContexts.has(getContextKey(target));
    },

    setActivityEnabled(target, enabled) {
      const contextKey = getContextKey(target);
      if (enabled) {
        activityDisabledContexts.delete(contextKey);
        return;
      }
      activityDisabledContexts.add(contextKey);
    },
  };
}
