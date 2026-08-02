import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  ASSISTANT_PREVIEW_LIMIT,
  SHORTENED_RESPONSE_MARKER,
  USER_PREVIEW_LIMIT,
  buildLastExchangePreview,
} from "../src/session-exchange-preview.js";

const user = (content: unknown): AgentMessage => ({
  role: "user",
  content,
  timestamp: 1,
} as AgentMessage);

const assistant = (content: unknown): AgentMessage => ({
  role: "assistant",
  content,
  timestamp: 2,
} as AgentMessage);

const toolResult = (): AgentMessage => ({
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "read",
  content: [{ type: "text", text: "secret tool output" }],
  isError: false,
  timestamp: 3,
} as AgentMessage);

describe("buildLastExchangePreview", () => {
  it("combines every assistant text segment after the latest user message", () => {
    const result = buildLastExchangePreview([
      user("Earlier request"),
      assistant([{ type: "text", text: "Earlier answer" }]),
      user([
        { type: "text", text: "Inspect this" },
        { type: "image", data: "base64-secret", mimeType: "image/png" },
      ]),
      assistant([
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "First visible part" },
        { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      ]),
      toolResult(),
      assistant([{ type: "text", text: "Final visible part" }]),
    ]);

    expect(result).toEqual({
      userText: "Inspect this\n[image]",
      assistantText: "First visible part\n\nFinal visible part",
    });
  });

  it("falls back to the previous completed exchange", () => {
    expect(buildLastExchangePreview([
      user("Completed request"),
      assistant([{ type: "text", text: "Completed answer" }]),
      user("Unanswered request"),
    ])).toEqual({ userText: "Completed request", assistantText: "Completed answer" });
  });

  it("returns undefined without a completed exchange", () => {
    expect(buildLastExchangePreview([user("Unanswered")])).toBeUndefined();
  });

  it("bounds user text and preserves both ends of long assistant text", () => {
    const result = buildLastExchangePreview([
      user("u".repeat(USER_PREVIEW_LIMIT + 100)),
      assistant([{ type: "text", text: `START-${"a".repeat(ASSISTANT_PREVIEW_LIMIT)}-END` }]),
    ]);

    expect(result?.userText).toHaveLength(USER_PREVIEW_LIMIT);
    expect(result?.assistantText).toHaveLength(ASSISTANT_PREVIEW_LIMIT);
    expect(result?.assistantText).toContain(SHORTENED_RESPONSE_MARKER);
    expect(result?.assistantText).toMatch(/^START-/);
    expect(result?.assistantText).toMatch(/-END$/);
  });

  it("ignores non-user and non-assistant context messages", () => {
    const result = buildLastExchangePreview([
      user("Question"),
      {
        role: "custom",
        customType: "notice",
        content: "hidden custom text",
        display: false,
        timestamp: 2,
      } as AgentMessage,
      toolResult(),
      {
        role: "compactionSummary",
        summary: "hidden summary",
        tokensBefore: 10_000,
        timestamp: 4,
      } as AgentMessage,
      assistant([{ type: "text", text: "Visible answer" }]),
    ]);

    expect(result).toEqual({ userText: "Question", assistantText: "Visible answer" });
  });
});
