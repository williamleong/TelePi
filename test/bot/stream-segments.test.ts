import { createStreamSegments } from "../../src/bot/stream-segments.js";

describe("chronological stream segments", () => {
  it("creates and seals segments when the stream switches between activity and assistant text", () => {
    const stream = createStreamSegments();
    stream.appendThinking({ blockKey: "1:0", delta: "Think A" });
    stream.startTool("read", "tool-1", { path: "src/a.ts" });
    stream.appendAssistantText("Answer A");
    stream.appendThinking({ blockKey: "2:0", delta: "Think B" });
    stream.appendAssistantText("Answer B");

    expect(stream.getSegments().map((segment) => segment.kind)).toEqual([
      "activity",
      "assistant",
      "activity",
      "assistant",
    ]);
    expect(stream.getSegments().map((segment) => segment.sealed)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("coalesces adjacent events of each kind and increments revisions for content mutations", () => {
    const stream = createStreamSegments();
    const activity = stream.appendThinking({ blockKey: "1:0", delta: "Think" });
    const activityRevision = activity.revision;
    stream.startTool("read", "tool-1", { path: "src/a.ts" });
    stream.appendThinking({ blockKey: "1:1", delta: "More" });

    const assistant = stream.appendAssistantText("Answer");
    const assistantRevision = assistant.revision;
    stream.appendAssistantText(" continued");

    expect(stream.getSegments()).toHaveLength(2);
    expect(activity.activity?.entries).toEqual([
      { kind: "thinking", blockKey: "1:0", text: "Think" },
      {
        kind: "tool",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "src/a.ts" },
        status: "running",
      },
      { kind: "thinking", blockKey: "1:1", text: "More" },
    ]);
    expect(activity.revision).toBeGreaterThan(activityRevision);
    expect(assistant.assistantText).toBe("Answer continued");
    expect(assistant.revision).toBeGreaterThan(assistantRevision);
  });

  it("does not mutate a sealed segment when a later kind is appended", () => {
    const stream = createStreamSegments();
    const assistant = stream.appendAssistantText("Answer A");
    stream.appendThinking({ blockKey: "1:0", delta: "Think B" });
    const sealedAssistant = { ...assistant };
    stream.appendThinking({ blockKey: "1:1", delta: "Think C" });

    expect(assistant).toMatchObject(sealedAssistant);
    expect(stream.getSegments().map((segment) => segment.kind)).toEqual(["assistant", "activity"]);
  });

  it("updates the original activity segment when a tool finishes after assistant text", () => {
    const stream = createStreamSegments();
    const activity = stream.startTool("read", "tool-1", { path: "src/a.ts" });
    stream.appendAssistantText("Answer A");
    const assistant = stream.getSegments()[1];
    const activityRevision = activity.revision;

    const updated = stream.finishTool("tool-1", false);

    expect(updated).toBe(activity);
    expect(updated?.revision).toBeGreaterThan(activityRevision);
    expect(stream.getSegments().map((segment) => segment.kind)).toEqual(["activity", "assistant"]);
    expect(assistant?.assistantText).toBe("Answer A");
    expect(activity.activity?.entries[0]).toMatchObject({ status: "success" });
  });

  it("tracks rendered chunks, delivery, and delivery failures per segment", () => {
    const stream = createStreamSegments();
    const activity = stream.appendThinking({ blockKey: "1:0", delta: "Think" });
    const assistant = stream.appendAssistantText("Answer");

    stream.setRenderedChunks(assistant.id, [{
      text: "<b>💬 Assistant</b>\nAnswer",
      fallbackText: "💬 Assistant\nAnswer",
      parseMode: "HTML",
      sourceText: "Answer",
    }]);
    stream.setChunkMessageId(assistant.id, 0, 42);
    stream.markDelivered(assistant.id, assistant.revision);
    stream.markDeliveryFailed(activity.id);

    expect(assistant.chunks).toEqual([{
      messageId: 42,
      rendered: {
        text: "<b>💬 Assistant</b>\nAnswer",
        fallbackText: "💬 Assistant\nAnswer",
        parseMode: "HTML",
        sourceText: "Answer",
      },
    }]);
    expect(assistant.deliveredRevision).toBe(assistant.revision);
    expect(activity.deliveryFailed).toBe(true);
    expect(stream.getDirtySegments()).toEqual([]);

    stream.appendAssistantText(" B");

    expect(stream.getDirtySegments()).toEqual([assistant]);
  });
});
