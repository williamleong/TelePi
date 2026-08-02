# Resumed Session Last-Exchange Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the latest completed user turn and all following assistant text after TelePi resumes a saved session.

**Architecture:** A pure extractor converts Pi's compaction-aware `AgentMessage[]` into a bounded `PiSessionExchangePreview`. `PiSessionService` exposes that preview, while a Telegram renderer and best-effort delivery helper keep UI concerns outside session logic. Both saved-session switch paths invoke the same delivery helper after confirming the switch.

**Tech Stack:** TypeScript, Pi SDK `SessionManager`, grammY, Vitest.

## Global Constraints

- Read messages through `session.sessionManager.buildSessionContext().messages`; do not parse session JSONL.
- Use only the active, compaction-aware branch.
- Define an exchange as one user message plus all later assistant text before the next user message.
- Select the newest completed exchange; fall back past an unanswered latest user message.
- Exclude thinking, tool calls, tool results, custom messages, and summaries.
- Replace each user image with `[image]`; never expose image data.
- Limit user text to 1,000 characters and combined assistant text to 2,000 characters.
- Preserve both ends of a shortened assistant response and insert `… recent response shortened …`.
- Keep the preview below Telegram's 4,000-character limit.
- Treat preview delivery as best-effort; it must not reverse or report failure for a successful switch.
- Do not append the preview to the Pi session or send it to the model.
- Add no dependencies or configuration options.

---

### Task 1: Extract the latest completed exchange

**Files:**
- Create: `src/session-exchange-preview.ts`
- Modify: `src/pi-session.ts` near `PiSessionInfo` and `PiSessionService.getInfo()`
- Create: `test/session-exchange-preview.test.ts`
- Modify: `test/pi-session.test.ts` in the `PiSessionService` describe block

**Interfaces:**
- Consumes: `AgentMessage[]` from `session.sessionManager.buildSessionContext().messages`.
- Produces: `PiSessionExchangePreview`, `buildLastExchangePreview(messages)`, and `PiSessionService.getLastExchangePreview()`.

- [ ] **Step 1: Write failing extractor tests**

Create `test/session-exchange-preview.test.ts`. Use small message factories with valid role/content fields and cast only the factories' final objects to `AgentMessage`. Cover the multi-message behavior in one table-driven suite:

```typescript
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
});
```

Add this explicit exclusion test:

```typescript
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
```

- [ ] **Step 2: Run the extractor tests and verify RED**

Run:

```bash
npm test -- test/session-exchange-preview.test.ts
```

Expected: FAIL because `src/session-exchange-preview.ts` does not exist.

- [ ] **Step 3: Implement the pure extractor**

Create `src/session-exchange-preview.ts` with these exports and limits:

```typescript
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const USER_PREVIEW_LIMIT = 1_000;
export const ASSISTANT_PREVIEW_LIMIT = 2_000;
export const SHORTENED_RESPONSE_MARKER = "… recent response shortened …";

export interface PiSessionExchangePreview {
  userText: string;
  assistantText: string;
}

export function buildLastExchangePreview(
  messages: AgentMessage[],
): PiSessionExchangePreview | undefined {
  let currentUserText: string | undefined;
  let currentAssistantParts: string[] = [];
  let latestCompleted: PiSessionExchangePreview | undefined;

  const finishCurrent = (): void => {
    if (!currentUserText || currentAssistantParts.length === 0) return;
    latestCompleted = {
      userText: truncateUserText(currentUserText),
      assistantText: truncateAssistantText(currentAssistantParts.join("\n\n")),
    };
  };

  for (const message of messages) {
    if (message.role === "user") {
      finishCurrent();
      currentUserText = extractUserText(message.content);
      currentAssistantParts = [];
      continue;
    }

    if (message.role !== "assistant" || currentUserText === undefined) continue;
    const text = extractAssistantText(message.content);
    if (text) currentAssistantParts.push(text);
  }

  finishCurrent();
  return latestCompleted;
}
```

Also import `AssistantMessage` and `UserMessage` from `@earendil-works/pi-ai` and implement these focused private functions:

```typescript
function extractUserText(content: UserMessage["content"]): string {
  if (typeof content === "string") return content.trim();
  return content
    .map((block) => block.type === "text" ? block.text.trim() : "[image]")
    .filter(Boolean)
    .join("\n");
}

function extractAssistantText(content: AssistantMessage["content"]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
}

function truncateUserText(text: string): string {
  if (text.length <= USER_PREVIEW_LIMIT) return text;
  return `${text.slice(0, USER_PREVIEW_LIMIT - 1)}…`;
}

function truncateAssistantText(text: string): string {
  if (text.length <= ASSISTANT_PREVIEW_LIMIT) return text;
  const separator = `\n\n${SHORTENED_RESPONSE_MARKER}\n\n`;
  const available = ASSISTANT_PREVIEW_LIMIT - separator.length;
  const headLength = Math.ceil(available * 0.6);
  const tailLength = available - headLength;
  return `${text.slice(0, headLength)}${separator}${text.slice(-tailLength)}`;
}
```

For user arrays, this emits `[image]` for each image block and never reads its data.

`truncateUserText()` must return exactly 1,000 characters when shortened by retaining a prefix and ending with `…`. `truncateAssistantText()` must return exactly 2,000 characters by allocating the remaining space around `\n\n${SHORTENED_RESPONSE_MARKER}\n\n` at a 60/40 head/tail split.

- [ ] **Step 4: Run extractor tests and verify GREEN**

Run:

```bash
npm test -- test/session-exchange-preview.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write a failing service delegation test**

In `test/pi-session.test.ts`, set the current mocked session manager's `buildSessionContext` result to one user and two assistant messages, then assert:

```typescript
expect(service.getLastExchangePreview()).toEqual({
  userText: "Resume this work",
  assistantText: "First part\n\nSecond part",
});
expect(currentSession.sessionManager.buildSessionContext).toHaveBeenCalled();
```

- [ ] **Step 6: Run the service test and verify RED**

Run the named test with:

```bash
npm test -- test/pi-session.test.ts -t "returns the latest completed exchange preview"
```

Expected: FAIL because `getLastExchangePreview` is undefined.

- [ ] **Step 7: Add the service method**

In `src/pi-session.ts`, import `buildLastExchangePreview` and `PiSessionExchangePreview`, then add:

```typescript
getLastExchangePreview(): PiSessionExchangePreview | undefined {
  const messages = this.getSession().sessionManager.buildSessionContext().messages;
  return buildLastExchangePreview(messages);
}
```

Place it immediately before `getContextUsage()` with the other read-only getters. Export `PiSessionExchangePreview` from `src/session-exchange-preview.ts` for bot rendering.

- [ ] **Step 8: Run focused tests and commit**

Run:

```bash
npm test -- test/session-exchange-preview.test.ts test/pi-session.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/session-exchange-preview.ts src/pi-session.ts test/session-exchange-preview.test.ts test/pi-session.test.ts
git commit -m "feat: extract resumed session exchange preview"
```

---

### Task 2: Render and deliver the preview safely

**Files:**
- Modify: `src/bot/message-rendering.ts`
- Create: `src/bot/session-exchange-preview.ts`
- Modify: `test/bot/message-rendering.test.ts`
- Create: `test/bot/session-exchange-preview.test.ts`

**Interfaces:**
- Consumes: `PiSessionExchangePreview` and `PiSessionService.getLastExchangePreview()` from Task 1.
- Produces: `renderSessionExchangePreview(preview): RenderedText` and `deliverSessionExchangePreview(piSession, send): Promise<void>`.

- [ ] **Step 1: Write failing renderer tests**

In `test/bot/message-rendering.test.ts`, import `renderSessionExchangePreview` and add:

```typescript
it("renders an escaped resumed-session exchange preview", () => {
  const rendered = renderSessionExchangePreview({
    userText: "Use <auth> & tests",
    assistantText: "Done <success>",
  });

  expect(rendered.fallbackText).toBe([
    "↩️ Recent context",
    "",
    "You",
    "Use <auth> & tests",
    "",
    "Pi",
    "Done <success>",
  ].join("\n"));
  expect(rendered.text).toContain("<b>↩️ Recent context</b>");
  expect(rendered.text).toContain("<b>You</b>");
  expect(rendered.text).toContain("Use &lt;auth&gt; &amp; tests");
  expect(rendered.text).toContain("<b>Pi</b>");
});
```

- [ ] **Step 2: Run the renderer test and verify RED**

Run:

```bash
npm test -- test/bot/message-rendering.test.ts -t "renders an escaped resumed-session exchange preview"
```

Expected: FAIL because the renderer is undefined.

- [ ] **Step 3: Implement the renderer**

Add this exported function to `src/bot/message-rendering.ts`:

```typescript
export function renderSessionExchangePreview(
  preview: PiSessionExchangePreview,
): RenderedText {
  const fallbackText = [
    "↩️ Recent context",
    "",
    "You",
    preview.userText,
    "",
    "Pi",
    preview.assistantText,
  ].join("\n");

  return {
    text: [
      "<b>↩️ Recent context</b>",
      "",
      "<b>You</b>",
      escapeHTML(preview.userText),
      "",
      "<b>Pi</b>",
      escapeHTML(preview.assistantText),
    ].join("\n"),
    fallbackText,
    parseMode: "HTML",
  };
}
```

Import `PiSessionExchangePreview` as a type from `../session-exchange-preview.js`.

- [ ] **Step 4: Write failing delivery-helper tests**

Create `test/bot/session-exchange-preview.test.ts`:

```typescript
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
```

- [ ] **Step 5: Run delivery tests and verify RED**

Run:

```bash
npm test -- test/bot/session-exchange-preview.test.ts
```

Expected: FAIL because the delivery module does not exist.

- [ ] **Step 6: Implement best-effort delivery**

Create `src/bot/session-exchange-preview.ts`:

```typescript
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
```

The `try` block intentionally covers both extraction and Telegram delivery.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
npm test -- test/bot/message-rendering.test.ts test/bot/session-exchange-preview.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/bot/message-rendering.ts src/bot/session-exchange-preview.ts test/bot/message-rendering.test.ts test/bot/session-exchange-preview.test.ts
git commit -m "feat: render resumed session exchange preview"
```

---

### Task 3: Show the preview after both saved-session switch flows

**Files:**
- Modify: `src/bot/commands/sessions.ts` in the direct-reference success path
- Modify: `src/bot.ts` in the `switch_(\d+)` callback success path
- Modify: `test/bot.test.ts` in the session-switch tests and mock service

**Interfaces:**
- Consumes: `deliverSessionExchangePreview(piSession, send)` from Task 2.
- Produces: a separate Telegram preview message after direct and inline-button session switches.

- [ ] **Step 1: Extend the default bot mock and write failing direct-switch tests**

In `createMockPiSession()` in `test/bot.test.ts`, add a default method that preserves existing test call counts:

```typescript
getLastExchangePreview: vi.fn().mockReturnValue(undefined),
```

Add a direct-switch test with an override:

```typescript
it("shows recent context after a direct saved-session switch", async () => {
  const { bot, api } = setupBot({
    piSessionOverrides: {
      getLastExchangePreview: vi.fn().mockReturnValue({
        userText: "What changed?",
        assistantText: "Updated A.\n\nVerified B.",
      }),
    },
  });

  await bot.handleUpdate(createTestUpdate({
    message: { text: "/sessions /saved/session.jsonl" },
  }));

  expect(api.sendMessage.mock.calls[0]?.[1]).toContain("Switched session");
  expect(api.sendMessage.mock.calls[1]?.[1]).toContain("Recent context");
  expect(api.sendMessage.mock.calls[1]?.[1]).toContain("What changed?");
  expect(api.sendMessage.mock.calls[1]?.[1]).toContain("Updated A.");
  expect(api.sendMessage.mock.calls[1]?.[1]).toContain("Verified B.");
});
```

Extend the existing cancelled and failed switch assertions to verify `getLastExchangePreview` was not called.

- [ ] **Step 2: Run the direct-switch test and verify RED**

Run:

```bash
npm test -- test/bot.test.ts -t "shows recent context after a direct saved-session switch"
```

Expected: FAIL because only the switch confirmation is sent.

- [ ] **Step 3: Integrate direct-reference switching**

Import `deliverSessionExchangePreview` in `src/bot/commands/sessions.ts`. Immediately after the successful switch confirmation, before startup diagnostics, add:

```typescript
await deliverSessionExchangePreview(piSession, async (preview) => {
  await safeReply(ctx, preview.text, {
    fallbackText: preview.fallbackText,
    parseMode: preview.parseMode,
  }, target);
});
```

Keep this after the `info.cancelled` early return so cancelled switches never preview.

- [ ] **Step 4: Run the direct-switch tests and verify GREEN**

Run:

```bash
npm test -- test/bot.test.ts -t "direct saved-session switch|switches directly via"
```

Expected: PASS.

- [ ] **Step 5: Write a failing inline-button switch test**

Add:

```typescript
it("shows recent context after an inline saved-session switch", async () => {
  const { bot, api } = setupBot({
    piSessionOverrides: {
      getLastExchangePreview: vi.fn().mockReturnValue({
        userText: "Previous question",
        assistantText: "Previous answer",
      }),
    },
  });

  await bot.handleUpdate(createTestUpdate({ message: { text: "/sessions" } }));
  await bot.handleUpdate(createCallbackUpdate("switch_0"));

  expect(api.editMessageText.mock.calls.at(-1)?.[2]).toContain("Switched!");
  expect(api.sendMessage.mock.calls.at(-1)?.[1]).toContain("Recent context");
  expect(api.sendMessage.mock.calls.at(-1)?.[1]).toContain("Previous answer");
});
```

- [ ] **Step 6: Run the callback test and verify RED**

Run:

```bash
npm test -- test/bot.test.ts -t "shows recent context after an inline saved-session switch"
```

Expected: FAIL because no preview message follows the edited picker.

- [ ] **Step 7: Integrate inline-button switching**

Import `deliverSessionExchangePreview` in `src/bot.ts`. After sending or editing the successful `Switched!` confirmation and before startup diagnostics, add:

```typescript
await deliverSessionExchangePreview(piSession, async (preview) => {
  await safeReply(ctx, preview.text, {
    fallbackText: preview.fallbackText,
    parseMode: preview.parseMode,
  }, target);
});
```

The helper suppresses extraction and delivery failures, so the surrounding switch `try` block cannot misreport a completed switch.

- [ ] **Step 8: Run all session-switch tests**

Run:

```bash
npm test -- test/bot.test.ts -t "session switch|switches directly|session picker"
```

Expected: PASS, including cancelled and error paths.

- [ ] **Step 9: Run complete verification**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: all Vitest tests pass, TypeScript builds without errors, and `git diff --check` prints nothing.

- [ ] **Step 10: Commit the integration**

```bash
git add src/bot/commands/sessions.ts src/bot.ts test/bot.test.ts
git commit -m "feat: show context after session resume"
```
