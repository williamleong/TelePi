# Telegram Activity Transcript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a default-on, per-chat/topic Telegram activity transcript that interleaves provider-supplied thinking text with compact tool rows while keeping the final assistant answer separate.

**Architecture:** Extend the Pi session event bridge with thinking deltas and tool arguments, then feed those events into a pure activity transcript model/renderer. `prompt-handler.ts` owns a per-prompt activity stream and Telegram delivery lifecycle. Existing chat state and command wiring provide an in-memory `/activity on|off` switch.

**Tech Stack:** TypeScript, Pi SDK 0.83.0 event APIs, grammY, Telegram HTML messages, Vitest.

## Global Constraints

- Activity defaults to `on` for every unseen `(chatId, messageThreadId)` context.
- `/activity on|off` changes only the current chat/topic and is not persisted.
- Bare `/activity` reports the current state and usage.
- Display `thinking_delta` content verbatim; do not call an LLM, paraphrase, or summarize it.
- Format tool rows deterministically from an allowlist of built-in argument fields; never dump arbitrary tool arguments or results.
- Keep activity and final assistant output in separate Telegram messages.
- Preserve thinking/tool event order and update tool completion in place.
- Roll activity into additional messages without discarding thinking text.
- Activity delivery failures must not fail or abort the Pi prompt.
- When activity is on, suppress legacy tool messages and the final tool-count summary.
- When activity is off, preserve existing `TOOL_VERBOSITY` behavior exactly.
- Add no dependencies, environment variables, persistence files, or configuration schema.

---

### Task 1: Add per-context state and `/activity`

**Files:**
- Modify: `src/bot/chat-state.ts`
- Modify: `src/bot/commands/basic.ts`
- Modify: `src/bot/slash-command.ts`
- Modify: `src/bot/message-rendering.ts`
- Modify: `src/bot.ts`
- Modify: `test/bot/chat-state.test.ts`
- Modify: `test/bot/slash-command.test.ts`
- Modify: `test/bot/message-rendering.test.ts`
- Modify: `test/bot.test.ts`

**Interfaces:**
- Consumes: `getPiSessionContextKey(target)` and existing command wiring.
- Produces: `BotChatState.isActivityEnabled(target): boolean`, `BotChatState.setActivityEnabled(target, enabled): void`, and `handleActivityCommand(ctx, target)`.

- [ ] **Step 1: Write failing chat-state tests**

Extend `test/bot/chat-state.test.ts` with:

```typescript
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

  state.setActivityEnabled(topicA, true);
  expect(state.isActivityEnabled(topicA)).toBe(true);
});
```

Also assert that `clearPromptMemory(topicA)` does not reset the activity override.

- [ ] **Step 2: Run the chat-state test and verify RED**

Run:

```bash
npm test -- test/bot/chat-state.test.ts
```

Expected: FAIL because the activity methods do not exist.

- [ ] **Step 3: Implement the activity override state**

Add these members to `BotChatState`:

```typescript
readonly isActivityEnabled: (target: PiSessionContext) => boolean;
readonly setActivityEnabled: (target: PiSessionContext, enabled: boolean) => void;
```

In `createBotChatState()`, use a set of disabled contexts so absence naturally means on:

```typescript
const activityDisabledContexts = new Set<ContextKey>();

const isActivityEnabled = (target: PiSessionContext): boolean =>
  !activityDisabledContexts.has(getPiSessionContextKey(target));

const setActivityEnabled = (target: PiSessionContext, enabled: boolean): void => {
  const key = getPiSessionContextKey(target);
  if (enabled) {
    activityDisabledContexts.delete(key);
    return;
  }
  activityDisabledContexts.add(key);
};
```

Return both methods without adding them to `clearPromptMemory()`.

- [ ] **Step 4: Run the chat-state test and verify GREEN**

Run:

```bash
npm test -- test/bot/chat-state.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing catalog and help tests**

In `test/bot/slash-command.test.ts`, assert that `buildCommandPickerEntries([])` includes:

```typescript
expect(entries).toContainEqual(expect.objectContaining({
  kind: "telepi",
  command: "activity",
  commandText: "/activity",
}));
```

Assert `buildChatScopedCommands([])` includes `activity`, and `TELEPI_LOCAL_COMMAND_NAMES` contains it.

In `test/bot/message-rendering.test.ts`, assert both `renderHelpPlain()` and `renderHelpHTML()` mention `/activity on|off` and explain that bare `/activity` reports state.

- [ ] **Step 6: Run catalog/help tests and verify RED**

Run:

```bash
npm test -- test/bot/slash-command.test.ts test/bot/message-rendering.test.ts
```

Expected: FAIL because activity is absent from the command catalog and help.

- [ ] **Step 7: Add activity to command catalogs and help**

Add this entry to `TELEPI_BOT_COMMANDS` in `src/bot/slash-command.ts`:

```typescript
{ command: "activity", description: "Toggle activity details (/activity on|off)" },
```

Update both help renderers in `src/bot/message-rendering.ts` with equivalent plain and HTML lines:

```text
/activity on|off — Show or hide thinking and tool activity; bare /activity reports the current state
```

Adding the catalog entry must remain the single source for picker and native Telegram command registration.

- [ ] **Step 8: Write failing command integration tests**

In `test/bot.test.ts`, add tests that send updates through the existing bot harness:

```typescript
it("reports and changes activity for the current topic", async () => {
  // Send bare /activity in topic 7 and assert the reply reports "on".
  // Send /activity off in topic 7 and assert the reply reports "off".
  // Send bare /activity in topic 8 and assert it still reports "on".
  // Send /activity on in topic 7 and assert it reports "on" again.
});

it("rejects invalid activity arguments without creating a Pi session", async () => {
  // Send /activity maybe.
  // Assert the reply contains "Usage: /activity on|off".
  // Assert the session registry create/get path was not called.
});
```

Use the suite's existing topic update helpers and mock call conventions rather than bypassing grammY.

- [ ] **Step 9: Run command tests and verify RED**

Run:

```bash
npm test -- test/bot.test.ts -t "activity"
```

Expected: FAIL because no activity handler is registered.

- [ ] **Step 10: Implement and wire `handleActivityCommand`**

Extend `createBasicCommandHandlers()` dependencies with:

```typescript
isActivityEnabled: (target: PiSessionContext) => boolean;
setActivityEnabled: (target: PiSessionContext, enabled: boolean) => void;
```

Implement the handler without creating a Pi session:

```typescript
const handleActivityCommand = async (
  ctx: Context,
  target: PiSessionContext,
): Promise<void> => {
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
```

Return the handler. In `src/bot.ts`:

1. Pass `chatState.isActivityEnabled` and `chatState.setActivityEnabled` into `createBasicCommandHandlers()`.
2. Destructure `handleActivityCommand`.
3. Register `bot.command("activity", ...)` with the same target/logging pattern as `/help` and `/session`.
4. Add `activity` to `runTelePiPickerCommand()` so picker selection runs the bare status form.
5. Update existing exact command-list expectations in `test/bot.test.ts` to include `activity`; do not create a second command catalog.

- [ ] **Step 11: Run Task 1 tests and commit**

Run:

```bash
npm test -- test/bot/chat-state.test.ts test/bot/slash-command.test.ts test/bot/message-rendering.test.ts test/bot.test.ts -t "activity|command|help|chat state"
```

Expected: PASS.

Commit:

```bash
git add src/bot/chat-state.ts src/bot/commands/basic.ts src/bot/slash-command.ts src/bot/message-rendering.ts src/bot.ts test/bot/chat-state.test.ts test/bot/slash-command.test.ts test/bot/message-rendering.test.ts test/bot.test.ts
git commit -m "feat: add per-chat activity toggle"
```

---

### Task 2: Forward thinking deltas and tool arguments

**Files:**
- Modify: `src/pi-session.ts`
- Modify: `test/pi-session.test.ts`

**Interfaces:**
- Consumes: Pi SDK `message_update` and `tool_execution_start` events.
- Produces: `PiThinkingDelta`, `PiSessionCallbacks.onThinkingDelta(event)`, and the third `args` parameter on `onToolStart`.

- [ ] **Step 1: Write a failing event-forwarding test**

Extend the existing `subscribeToSession()` forwarding test in `test/pi-session.test.ts`. Emit:

```typescript
emit?.({
  type: "message_update",
  message: {
    role: "assistant",
    content: [{ type: "thinking", thinking: "Inspect" }],
    timestamp: 123,
  },
  assistantMessageEvent: {
    type: "thinking_delta",
    contentIndex: 0,
    delta: "Inspect",
    partial: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Inspect" }],
      timestamp: 123,
    },
  },
} as never);

emit?.({
  type: "tool_execution_start",
  toolName: "read",
  toolCallId: "tool-1",
  args: { path: "src/pi-session.ts" },
} as never);
```

Assert:

```typescript
expect(callbacks.onThinkingDelta).toHaveBeenCalledWith({
  blockKey: "123:0",
  delta: "Inspect",
});
expect(callbacks.onToolStart).toHaveBeenCalledWith(
  "read",
  "tool-1",
  { path: "src/pi-session.ts" },
);
```

Keep the existing text, update, end, agent-end, and session-name assertions.

- [ ] **Step 2: Run the forwarding test and verify RED**

Run:

```bash
npm test -- test/pi-session.test.ts -t "forwards session events"
```

Expected: FAIL because thinking is ignored and tool arguments are not forwarded.

- [ ] **Step 3: Extend the callback interfaces**

Add:

```typescript
export interface PiThinkingDelta {
  blockKey: string;
  delta: string;
}
```

Update `PiSessionCallbacks`:

```typescript
onTextDelta: (delta: string) => void;
onThinkingDelta: (event: PiThinkingDelta) => void;
onToolStart: (toolName: string, toolCallId: string, args: unknown) => void;
```

In `subscribeToSession()`:

```typescript
case "message_update": {
  const update = event.assistantMessageEvent;
  if (update.type === "text_delta") {
    callbacks.onTextDelta(update.delta);
  } else if (update.type === "thinking_delta") {
    callbacks.onThinkingDelta({
      blockKey: `${event.message.timestamp}:${update.contentIndex}`,
      delta: update.delta,
    });
  }
  break;
}
case "tool_execution_start":
  callbacks.onToolStart(event.toolName, event.toolCallId, event.args);
  break;
```

Do not format, truncate, or log the thinking text in this layer.

- [ ] **Step 4: Update existing callback fixtures**

Every `PiSessionCallbacks` object in tests and production must provide `onThinkingDelta`. Use `vi.fn()` in tests that do not care about it. Update `onToolStart` expectations to accept the third argument where the emitted event has arguments.

- [ ] **Step 5: Run Pi session tests and commit**

Run:

```bash
npm test -- test/pi-session.test.ts
npm run build
```

Expected: PASS with no TypeScript errors.

Commit:

```bash
git add src/pi-session.ts test/pi-session.test.ts
git commit -m "feat: forward Pi thinking activity"
```

---

### Task 3: Build the pure activity transcript renderer

**Files:**
- Create: `src/bot/activity-rendering.ts`
- Create: `test/bot/activity-rendering.test.ts`

**Interfaces:**
- Consumes: `PiThinkingDelta`, tool start/end data, and `escapeHTML()`.
- Produces: `ActivityTranscript`, `createActivityTranscript()`, and `renderActivityTranscript(transcript): RenderedChunk[]`.

- [ ] **Step 1: Write failing transcript-state tests**

Create `test/bot/activity-rendering.test.ts` with tests for exact state transitions:

```typescript
import {
  createActivityTranscript,
  renderActivityTranscript,
} from "../../src/bot/activity-rendering.js";

describe("activity transcript", () => {
  it("assembles thinking blocks verbatim and preserves event order", () => {
    const transcript = createActivityTranscript();
    transcript.appendThinking({ blockKey: "1:0", delta: "Inspect <src>" });
    transcript.appendThinking({ blockKey: "1:0", delta: " & tests" });
    transcript.startTool("tool-1", "read", { path: "src/a.ts" });
    transcript.appendThinking({ blockKey: "2:0", delta: "Run tests" });

    expect(transcript.entries).toEqual([
      { kind: "thinking", blockKey: "1:0", text: "Inspect <src> & tests" },
      {
        kind: "tool",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "src/a.ts" },
        status: "running",
      },
      { kind: "thinking", blockKey: "2:0", text: "Run tests" },
    ]);
  });

  it("updates tool completion in place", () => {
    const transcript = createActivityTranscript();
    transcript.startTool("tool-1", "bash", { command: "npm test" });
    transcript.finishTool("tool-1", false);
    expect(transcript.entries[0]).toMatchObject({ status: "success" });
    transcript.finishTool("tool-1", true);
    expect(transcript.entries[0]).toMatchObject({ status: "error" });
  });
});
```

- [ ] **Step 2: Write failing tool-formatting tests**

Use a table to assert the visible plain text for every built-in:

```typescript
it.each([
  ["read", { path: "src/a.ts" }, "🔍 Read\nsrc/a.ts"],
  ["bash", { command: "npm test" }, "⌨️ Bash\nnpm test"],
  ["edit", { path: "src/a.ts", edits: [] }, "✏️ Edit\nsrc/a.ts"],
  ["write", { path: "src/new.ts", content: "secret" }, "📝 Write\nsrc/new.ts"],
  ["grep", { pattern: "needle", path: "src" }, "🔎 Grep\nneedle in src"],
  ["find", { pattern: "*.ts", path: "src" }, "📁 Find\n*.ts in src"],
  ["ls", {}, "📂 LS\n."],
])("formats %s from allowlisted fields", (toolName, args, expected) => {
  const transcript = createActivityTranscript();
  transcript.startTool("tool-1", toolName, args);
  const [chunk] = renderActivityTranscript(transcript);
  expect(chunk.fallbackText).toContain(expected);
});
```

Add an unknown-tool test:

```typescript
transcript.startTool("tool-1", "deploy_secret", { token: "must-not-appear" });
const [chunk] = renderActivityTranscript(transcript);
expect(chunk.fallbackText).toContain("Deploy Secret");
expect(chunk.fallbackText).not.toContain("must-not-appear");
```

- [ ] **Step 3: Write failing escaping and rollover tests**

Assert:

```typescript
it("escapes HTML while preserving plain thinking text", () => {
  const transcript = createActivityTranscript();
  transcript.appendThinking({ blockKey: "1:0", delta: "Check <tag> & value" });
  const [chunk] = renderActivityTranscript(transcript);
  expect(chunk.text).toContain("Check &lt;tag&gt; &amp; value");
  expect(chunk.fallbackText).toContain("Check <tag> & value");
  expect(chunk.parseMode).toBe("HTML");
});

it("rolls over without dropping long thinking text", () => {
  const source = `start-${"x".repeat(9000)}-end`;
  const transcript = createActivityTranscript();
  transcript.appendThinking({ blockKey: "1:0", delta: source });
  const chunks = renderActivityTranscript(transcript);

  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks.every((chunk) => chunk.text.length <= 4000)).toBe(true);
  const reconstructed = chunks
    .map((chunk) => chunk.fallbackText)
    .join("\n")
    .replaceAll("🧠 Thinking\n", "")
    .replaceAll("🧠 Thinking (continued)\n", "");
  expect(reconstructed.replaceAll("\n", "")).toBe(source);
});
```

- [ ] **Step 4: Run renderer tests and verify RED**

Run:

```bash
npm test -- test/bot/activity-rendering.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 5: Implement transcript state**

Create `src/bot/activity-rendering.ts` with these public types:

```typescript
import type { PiThinkingDelta } from "../pi-session.js";
import type { RenderedChunk } from "./message-rendering.js";

export type ActivityToolStatus = "running" | "success" | "error";

export type ActivityEntry =
  | { kind: "thinking"; blockKey: string; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      args: unknown;
      status: ActivityToolStatus;
    };

export interface ActivityTranscript {
  readonly entries: ActivityEntry[];
  appendThinking(event: PiThinkingDelta): void;
  startTool(toolCallId: string, toolName: string, args: unknown): void;
  finishTool(toolCallId: string, isError: boolean): void;
}
```

`appendThinking()` appends to the last entry only when it is a thinking entry with the same `blockKey`; otherwise it adds a new entry. `finishTool()` finds the matching tool entry and changes only its status. Unknown tool IDs are ignored.

- [ ] **Step 6: Implement allowlisted tool summaries**

Use structural string extraction rather than casts that assume valid arguments:

```typescript
const readString = (value: unknown, key: string): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
};
```

Map only these fields:

```typescript
read  -> path
bash  -> command
edit  -> path
write -> path
grep  -> pattern + optional path
find  -> pattern + optional path
ls    -> optional path, default "."
```

Humanize unknown names with spaces and title casing, but return no argument detail.

- [ ] **Step 7: Implement safe HTML/plain chunk rendering**

Export:

```typescript
export const ACTIVITY_MESSAGE_LIMIT = 4_000;
export function renderActivityTranscript(
  transcript: ActivityTranscript,
): RenderedChunk[];
```

Render each entry as a block. Use equal-length status symbols (`•`, `✓`, `✗`) so completion does not alter JavaScript string-length chunk boundaries. Thinking headers use `🧠 Thinking`; split continuation blocks use `🧠 Thinking (continued)`. Tool blocks use the status plus the deterministic label.

Pack complete blocks while both HTML and fallback text remain within 4,000 characters. For an oversized thinking block, binary-search the largest raw-text prefix whose escaped, headed HTML and fallback text fit. Repeat until every character has been emitted. Never slice an HTML-escaped string because that can split entities such as `&amp;`.

Return `[]` for an empty transcript. Each chunk must have:

```typescript
{
  text: html,
  fallbackText: plain,
  parseMode: "HTML",
}
```

- [ ] **Step 8: Run renderer tests and commit**

Run:

```bash
npm test -- test/bot/activity-rendering.test.ts
npm run build
```

Expected: PASS.

Commit:

```bash
git add src/bot/activity-rendering.ts test/bot/activity-rendering.test.ts
git commit -m "feat: render Telegram activity transcripts"
```

---

### Task 4: Stream activity separately from the final answer

**Files:**
- Modify: `src/bot/prompt-handler.ts`
- Modify: `src/bot.ts`
- Modify: `test/bot/prompt-handler.test.ts`
- Modify: `test/bot.test.ts`

**Interfaces:**
- Consumes: `isActivityEnabled(target)`, `createActivityTranscript()`, `renderActivityTranscript()`, and the extended `PiSessionCallbacks`.
- Produces: one or more best-effort activity messages per prompt and an unchanged separate final response.

- [ ] **Step 1: Extend the prompt-handler test harness**

In `test/bot/prompt-handler.test.ts`, update the fake session callback type for `onThinkingDelta` and tool-start arguments. Add `isActivityEnabled: () => true` to the default `CreatePromptHandlerOptions` fixture. Capture each callback object passed to `subscribe()` so tests can emit thinking/tool events before resolving the prompt.

- [ ] **Step 2: Write a failing separate-message integration test**

Add a test that emits events in this order:

```typescript
callbacks.onThinkingDelta({ blockKey: "1:0", delta: "Inspect files" });
callbacks.onToolStart("read", "tool-1", { path: "src/a.ts" });
callbacks.onToolEnd("tool-1", false);
callbacks.onTextDelta("Final answer");
callbacks.onAgentEnd();
```

After awaiting the prompt task and fake timers, assert:

- the activity send/edit contains `Thinking`, `Inspect files`, `Read`, and `src/a.ts`;
- the tool marker becomes success;
- the final response message contains `Final answer`;
- activity and final response use different Telegram message IDs;
- the final response does not contain the legacy tool-count summary.

- [ ] **Step 3: Write failing off/empty/failure tests**

Add three tests:

1. `isActivityEnabled: () => false`: thinking produces no activity message, while `TOOL_VERBOSITY=summary` still adds the legacy tool-count line.
2. Activity on with only `onTextDelta`: no empty activity message is sent.
3. The first activity `sendMessage` rejects: the final response still sends and the prompt resolves successfully; later activity events do not retry endlessly.

Use separate mock results or message predicates so rejecting activity delivery does not also reject final response delivery.

- [ ] **Step 4: Write a failing rollover/update test**

Emit more than 4,000 characters of thinking, start a tool after the rollover, then complete a tool that appears in an earlier chunk. Assert:

- multiple activity messages are sent;
- each rendered HTML payload is at most 4,000 characters;
- the earlier message is edited from running to success;
- concatenated fallback content preserves the complete thinking text.

- [ ] **Step 5: Run prompt-handler tests and verify RED**

Run:

```bash
npm test -- test/bot/prompt-handler.test.ts -t "activity"
```

Expected: FAIL because the prompt handler ignores thinking and has no activity stream.

- [ ] **Step 6: Add the activity-enabled dependency and snapshot it**

Extend `CreatePromptHandlerOptions`:

```typescript
isActivityEnabled: (target: PiSessionContext) => boolean;
```

At the start of `runPromptFlow()`:

```typescript
const activityEnabled = deps.isActivityEnabled(target);
const activityTranscript = activityEnabled ? createActivityTranscript() : undefined;
```

Pass `chatState.isActivityEnabled` from `createBot()` in `src/bot.ts`. Snapshot once per prompt so changing `/activity` affects the next prompt rather than an in-flight response.

Do not change typing-indicator behavior; `/activity` controls transcript visibility, not Telegram chat actions.

- [ ] **Step 7: Implement independent activity delivery state**

Beside the existing response streaming state, add:

```typescript
let activityMessageIds: number[] = [];
let lastActivityChunks: RenderedChunk[] = [];
let activityFlushTimer: NodeJS.Timeout | undefined;
let activityDeliveryFailed = false;
let activityFlushInProgress = false;
let activityFlushPending = false;
```

Implement `flushActivity(force = false)` with these rules:

1. Return when disabled, failed, empty, or still inside the debounce window unless forced.
2. Render all chunks from current transcript state.
3. For each chunk index:
   - send a new message when no message ID exists;
   - edit the existing message only when its rendered text differs.
4. Store each successful message ID and chunk snapshot.
5. Catch send/edit errors, log `Failed to update Telegram activity transcript`, mark `activityDeliveryFailed`, and clear the activity timer without throwing.
6. If an event arrives while flushing, set `activityFlushPending` and schedule one more flush.

Activity messages do not include the abort keyboard; the existing working/final response retains it.

- [ ] **Step 8: Connect thinking and tool callbacks**

Update the subscription callbacks:

```typescript
onThinkingDelta: (event) => {
  if (!activityTranscript) return;
  activityTranscript.appendThinking(event);
  scheduleActivityFlush();
},
onToolStart: (toolName, toolCallId, args) => {
  if (activityTranscript) {
    activityTranscript.startTool(toolCallId, toolName, args);
    scheduleActivityFlush();
    return;
  }
  // Existing TOOL_VERBOSITY logic remains unchanged below.
},
onToolEnd: (toolCallId, isError) => {
  if (activityTranscript) {
    activityTranscript.finishTool(toolCallId, isError);
    scheduleActivityFlush();
    return;
  }
  // Existing TOOL_VERBOSITY logic remains unchanged below.
},
```

Ignore tool partial-result updates when activity is on. Keep the current partial-result and per-tool message behavior unchanged when activity is off.

Change `buildFinalResponseText()` so it adds `formatToolSummaryLine()` only when `activityEnabled` is false.

- [ ] **Step 9: Finalize and clean up the activity stream**

Before final response delivery in both success and failure paths, force-flush the activity transcript without awaiting any pending debounce timer twice. In `finally`, clear the activity timer. `onAgentEnd()` may call finalization before `prompt()` resolves, so preserve the existing `finalized` guard and make activity finalization idempotent.

An activity failure must never set the prompt outcome to failed, replace assistant text with an error, or call `abort()`.

- [ ] **Step 10: Run focused prompt tests and verify GREEN**

Run:

```bash
npm test -- test/bot/prompt-handler.test.ts
```

Expected: PASS.

- [ ] **Step 11: Add end-to-end bot coverage**

In `test/bot.test.ts`, use the existing mock-session event emitters to verify:

- default-on prompts send activity and final answer separately;
- `/activity off` suppresses activity for the next prompt in that topic only;
- another topic remains default-on;
- `/activity on` restores the transcript;
- legacy `TOOL_VERBOSITY` tests explicitly disable activity before asserting old output.

Update mock tool-start emitters to accept arguments and add a thinking emitter using the new callback shape.

- [ ] **Step 12: Run bot integration tests and commit**

Run:

```bash
npm test -- test/bot/prompt-handler.test.ts test/bot.test.ts
npm run build
```

Expected: PASS.

Commit:

```bash
git add src/bot/prompt-handler.ts src/bot.ts test/bot/prompt-handler.test.ts test/bot.test.ts
git commit -m "feat: stream Telegram activity details"
```

---

### Task 5: Document and verify the feature

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: completed behavior from Tasks 1–4.
- Produces: user-facing command documentation and an updated module map.

- [ ] **Step 1: Update user documentation**

In `README.md`:

1. Add activity details to the feature list.
2. Add `/activity on|off` to the Telegram command table.
3. Explain that activity defaults on, is scoped per chat/topic, resets on restart, and includes verbatim provider thinking plus compact tool rows.
4. State that models/providers may emit no thinking.
5. State that `/activity off` restores the existing `TOOL_VERBOSITY` presentation.

Do not add an environment variable or suggest that the state persists.

- [ ] **Step 2: Update architecture documentation**

In `docs/architecture.md`, add `src/bot/activity-rendering.ts` to the bot module layout and note that `prompt-handler.ts` delivers the per-prompt transcript separately from final assistant output.

- [ ] **Step 3: Run documentation and source checks**

Run:

```bash
rg -n "/activity|activity details|thinking_delta" README.md docs/architecture.md src test
git diff --check
```

Expected: the command and behavior appear in docs/source/tests, and `git diff --check` prints nothing.

- [ ] **Step 4: Run complete verification**

Run:

```bash
npm test
npm run build
npm run test:coverage
git diff --check
```

Expected: all Vitest tests pass, TypeScript compiles, coverage meets repository thresholds, and no whitespace errors are reported.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/architecture.md
git commit -m "docs: explain Telegram activity details"
```
