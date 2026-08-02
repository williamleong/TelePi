import { createBotChatState } from "../../src/bot/chat-state.js";

describe("bot chat state", () => {
  it("defaults activity on and isolates overrides by chat and topic", () => {
    const state = createBotChatState();
    const root = { chatId: 10 };
    const topicA = { chatId: 10, messageThreadId: 1 };
    const topicB = { chatId: 10, messageThreadId: 2 };
    const otherChat = { chatId: 20 };

    expect(state.isActivityEnabled(root)).toBe(true);
    expect(state.isActivityEnabled(topicA)).toBe(true);

    state.setActivityEnabled(topicA, false);

    expect(state.isActivityEnabled(topicA)).toBe(false);
    expect(state.isActivityEnabled(root)).toBe(true);
    expect(state.isActivityEnabled(topicB)).toBe(true);
    expect(state.isActivityEnabled(otherChat)).toBe(true);

    state.clearPromptMemory(topicA);
    expect(state.isActivityEnabled(topicA)).toBe(false);

    state.setActivityEnabled(topicA, true);
    expect(state.isActivityEnabled(topicA)).toBe(true);
  });

  it("tracks busy state and prompt memory per chat/topic", () => {
    const state = createBotChatState();
    const root = { chatId: 123 };
    const topic = { chatId: 123, messageThreadId: 456 };

    expect(state.isLocallyBusy(root)).toBe(false);
    expect(state.getLastPrompt(root)).toBeUndefined();

    state.beginProcessing(root, "hello");
    expect(state.isLocallyBusy(root)).toBe(true);
    expect(state.isSteeringBlocked(root)).toBe(false);
    expect(state.getLastPrompt(root)).toBe("hello");
    expect(state.isLocallyBusy(topic)).toBe(false);
    expect(state.getLastPrompt(topic)).toBeUndefined();

    state.endProcessing(root);
    expect(state.isLocallyBusy(root)).toBe(false);

    state.beginSwitching(topic);
    expect(state.isLocallyBusy(topic)).toBe(true);
    expect(state.isSteeringBlocked(topic)).toBe(true);
    state.endSwitching(topic);
    expect(state.isLocallyBusy(topic)).toBe(false);
    expect(state.isSteeringBlocked(topic)).toBe(false);

    state.beginTranscribing(topic);
    expect(state.isLocallyBusy(topic)).toBe(true);
    expect(state.isSteeringBlocked(topic)).toBe(true);
    state.endTranscribing(topic);
    expect(state.isLocallyBusy(topic)).toBe(false);
    expect(state.isSteeringBlocked(topic)).toBe(false);

    state.clearPromptMemory(root);
    expect(state.getLastPrompt(root)).toBeUndefined();
  });
});
