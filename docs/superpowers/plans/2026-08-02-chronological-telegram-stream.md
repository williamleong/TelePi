# Chronological Telegram Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Append thinking, tool activity, and assistant text to Telegram in Pi event order while keeping a status-only message, one movable Abort control, and continuous native typing.

**Architecture:** A pure `stream-segments.ts` module owns chronological segment boundaries, revisions, tool ownership, and delivered chunk metadata. `prompt-handler.ts` replaces its independent response/activity flushers with one serialized worker that renders and delivers dirty segments in order, migrates the Abort keyboard attach-before-detach, and finalizes only after every pending revision settles.

**Tech Stack:** TypeScript, Pi SDK 0.83.0 events, grammY, Telegram Bot API, Vitest.

## Global Constraints

- The initial status message never contains assistant output.
- Adjacent events of one kind extend the open segment; switching between activity and assistant seals it and appends a new Telegram message.
- Sealed segments never receive new content, except a tool completion updating the tool row in its owning activity segment.
- TelePi may edit only messages belonging to the currently open segment or a tool's owning segment.
- Exactly one Abort keyboard should be visible; migration attaches the new owner before detaching the previous owner.
- Final cleanup attempts to remove the keyboard from every message that owned it.
- Telegram native typing starts immediately, refreshes every 4.5 seconds, and stops only after success, failure, abort, or activation failure settles.
- One authoritative delivery worker serializes sends/edits and drains every newer revision before finalization returns.
- Activity delivery failures remain best-effort; assistant delivery failures follow the existing prompt failure path.
- `/activity off` and all existing `TOOL_VERBOSITY` modes retain their current behavior.
- Preserve prompt-time `onSessionInfoChanged` forum-topic synchronization.
- Add no dependencies, persistence, configurable typing interval, message deletion, per-token messages, or LLM calls.

---

### Task 1: Model chronological segments and render assistant segments

**Files:**
- Create: `src/bot/stream-segments.ts`
- Modify: `src/bot/message-rendering.ts`
- Create: `test/bot/stream-segments.test.ts`
- Modify: `test/bot/message-rendering.test.ts`

**Interfaces:**
- Consumes: `PiThinkingDelta`, `ActivityTranscript`, `createActivityTranscript()`, `renderActivityTranscript()`, and existing Markdown/Telegram chunk helpers.
- Produces: `StreamSegments`, `StreamSegment`, `createStreamSegments()`, and `renderAssistantSegment(text): RenderedChunk[]`.

- [ ] **Step 1: Write failing segment-boundary tests**

Create `test/bot/stream-segments.test.ts` and cover the exact sequence:

```typescript
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
```

Add tests proving adjacent assistant deltas share one segment, adjacent thinking/tool events share one activity segment, revisions increase on each mutation, and appending a new kind never changes the sealed segment's content.

- [ ] **Step 2: Write failing late-tool and chunk-metadata tests**

Start a tool, switch to assistant text, then finish the tool. Assert `finishTool()` returns and increments the original activity segment without changing segment order or assistant content. Add tests for `setChunkMessageId()`, `setRenderedChunks()`, `markDelivered()`, and per-segment delivery failure.

- [ ] **Step 3: Run segment tests and verify RED**

Run:

```bash
npm test -- test/bot/stream-segments.test.ts
```

Expected: FAIL because `stream-segments.ts` does not exist.

- [ ] **Step 4: Implement the Telegram-free segment state**

Create these public shapes:

```typescript
export type StreamSegmentKind = "activity" | "assistant";

export interface SegmentChunkState {
  messageId?: number;
  rendered?: RenderedChunk;
}

export interface StreamSegment {
  id: number;
  kind: StreamSegmentKind;
  sealed: boolean;
  revision: number;
  deliveredRevision: number;
  deliveryFailed: boolean;
  assistantText: string;
  activity?: ActivityTranscript;
  chunks: SegmentChunkState[];
}

export interface StreamSegments {
  appendAssistantText(delta: string): StreamSegment;
  appendThinking(event: PiThinkingDelta): StreamSegment;
  startTool(toolName: string, toolCallId: string, args: unknown): StreamSegment;
  finishTool(toolCallId: string, isError: boolean): StreamSegment | undefined;
  getSegments(): readonly StreamSegment[];
  getDirtySegments(): readonly StreamSegment[];
  setRenderedChunks(segmentId: number, chunks: RenderedChunk[]): void;
  setChunkMessageId(segmentId: number, chunkIndex: number, messageId: number): void;
  markDelivered(segmentId: number, revision: number): void;
  markDeliveryFailed(segmentId: number): void;
}
```

Keep a `Map<string, number>` from tool call ID to owning segment ID. A kind switch seals the previous segment. `getDirtySegments()` returns segments with `revision > deliveredRevision` and `deliveryFailed === false`, in creation order.

- [ ] **Step 5: Write failing assistant-renderer tests**

In `test/bot/message-rendering.test.ts`, add tests that:

- render `💬 Assistant` above assistant text;
- escape HTML and preserve the raw fallback;
- split long assistant text into chunks of at most 4,000 characters;
- label continuation chunks `💬 Assistant (continued)`;
- preserve rich Markdown/fallback behavior without exceeding Telegram limits.

- [ ] **Step 6: Run renderer tests and verify RED**

Run:

```bash
npm test -- test/bot/message-rendering.test.ts -t "assistant segment"
```

Expected: FAIL because `renderAssistantSegment` is undefined.

- [ ] **Step 7: Implement assistant-segment rendering**

Export:

```typescript
export function renderAssistantSegment(text: string): RenderedChunk[];
```

Include the heading in size accounting. For normal Markdown, reuse existing Telegram formatting and split helpers, then wrap each chunk with an escaped HTML heading and corresponding plain fallback heading. For rich Markdown, preserve the existing rich delivery path and add a Markdown-safe heading. If wrapping makes a chunk exceed 4,000 characters, reduce the content budget before splitting rather than slicing formatted HTML.

- [ ] **Step 8: Run Task 1 tests and commit**

Run:

```bash
npm test -- test/bot/stream-segments.test.ts test/bot/message-rendering.test.ts
npm run build
```

Expected: PASS.

Commit:

```bash
git add src/bot/stream-segments.ts src/bot/message-rendering.ts test/bot/stream-segments.test.ts test/bot/message-rendering.test.ts
git commit -m "feat: model chronological Telegram segments"
```

---

### Task 2: Replace independent streams with one serialized delivery worker

**Files:**
- Modify: `src/bot/prompt-handler.ts`
- Modify: `test/bot/prompt-handler.test.ts`

**Interfaces:**
- Consumes: `createStreamSegments()`, `renderAssistantSegment()`, `renderActivityTranscript()`, existing Telegram transport helpers, and `PiSessionCallbacks`.
- Produces: chronological segment sends/edits, status-only lifecycle updates, continuous typing, and Abort ownership migration.

- [ ] **Step 1: Expand the prompt-handler harness**

Record ordered operations with message IDs and reply markup:

```typescript
type TelegramOperation =
  | { kind: "send"; messageId: number; text: string; hasAbort: boolean }
  | { kind: "edit"; messageId: number; text: string; hasAbort: boolean }
  | { kind: "markup"; messageId: number; hasAbort: boolean }
  | { kind: "typing" };
```

Expose deferred send/edit promises and `trackCallbackMessage` calls. Keep the existing `onSessionInfoChanged` fixture and assertions.

- [ ] **Step 2: Write failing chronology and status tests**

Emit thinking → assistant → thinking → assistant. Assert:

1. message 1 is `Working…` and never contains assistant text;
2. four output segment messages follow in event order;
3. adjacent text deltas edit only the newest assistant segment;
4. finalization changes message 1 to `Done` but leaves output segment contents in place;
5. no assistant text is copied into message 1.

Add a silent-run test asserting message 1 becomes `Done` without an output message.

- [ ] **Step 3: Write failing Abort migration tests**

Assert initial status owns Abort. After first output send, verify the new message receives Abort before the status markup is cleared. On kind switch and rollover, verify ownership moves to the newest message. Track every owner through `trackCallbackMessage`.

Add failures:

- new-owner attach rejects: old owner is not detached;
- old-owner detach rejects: both IDs remain cleanup candidates;
- finalization attempts to clear every historical owner.

- [ ] **Step 4: Write failing typing-lifetime tests**

With fake timers and an interval of 4,500 ms, assert typing occurs immediately, again after status/output sends, and every interval while the prompt remains open. Assert no further typing after success, prompt failure, activation failure, or abort settlement.

- [ ] **Step 5: Write a failing delivery/finalization race test**

Defer the first segment send, emit a later segment, fire the debounce timer, call `onAgentEnd()`, and resolve `prompt()`. Assert final status/keyboard cleanup does not occur until both segment revisions are delivered, and no timer operation occurs afterward.

- [ ] **Step 6: Run focused tests and verify RED**

Run:

```bash
npm test -- test/bot/prompt-handler.test.ts -t "chronological|Abort owner|typing lifetime|status-only|delivery worker"
```

Expected: FAIL against the separate response/activity implementation.

- [ ] **Step 7: Introduce status and segment state**

Replace `responseMessageId` with:

```typescript
let statusMessageId: number | undefined;
const streamSegments = createStreamSegments();
let abortOwnerMessageId: number | undefined;
const abortOwnerMessageIds = new Set<number>();
```

`ensureWorkingMessage()` sends only `Working…`, sets `statusMessageId`, records initial Abort ownership, and does not call `stopTyping()`.

- [ ] **Step 8: Implement one authoritative worker**

Replace independent response/activity timers and workers with:

```typescript
let deliveryTimer: NodeJS.Timeout | undefined;
let deliveryWorkerPromise: Promise<void> | undefined;
let deliveryPending = false;
let deliveryFinalizing = false;
let deliveryFinalized = false;
```

The worker loops over `getDirtySegments()` in segment order. It renders assistant segments with `renderAssistantSegment()` and activity segments with `renderActivityTranscript()`, edits existing chunks whose rendered payload changed, sends missing chunks, records message IDs, and marks the exact captured revision delivered. Reentrant requests return the authoritative worker and set `deliveryPending`.

Activity-segment delivery errors call `markDeliveryFailed()` and continue. Assistant-segment errors escape the worker and enter the existing prompt failure path.

- [ ] **Step 9: Implement attach-before-detach Abort migration**

After a successful output send/edit identifies the newest chunk:

1. attach `abortKeyboard` to the new owner;
2. call `trackCallbackMessage(target, newOwner)`;
3. add it to `abortOwnerMessageIds`;
4. only then clear the previous owner's markup;
5. update `abortOwnerMessageId` after attach succeeds.

Do not clear the previous owner when attach fails. Final cleanup iterates every historical owner and catches/logs failures independently.

- [ ] **Step 10: Wire Pi callbacks into segments**

- `onTextDelta` calls `appendAssistantText(delta)` and requests delivery.
- With activity enabled, thinking/tool callbacks mutate activity segments and request delivery.
- With activity disabled, retain existing tool verbosity state/messages. Assistant text still uses chronological assistant segments. For summary mode, append the summary to the last assistant segment at finalization or create one when needed; never write it into status.
- Preserve `onSessionInfoChanged` exactly.

- [ ] **Step 11: Finalize status and typing safely**

Finalization sets the finalizing guard, clears the timer, awaits the authoritative worker until no dirty revisions remain, updates only `statusMessageId` to `Done` or the existing failure/abort state, clears all Abort owners, then stops typing. Timer callbacks return immediately after finalization begins.

Do not stop typing in working-message or segment-send paths.

- [ ] **Step 12: Run focused tests and commit**

Run:

```bash
npm test -- test/bot/prompt-handler.test.ts
npm run build
```

Expected: PASS.

Commit:

```bash
git add src/bot/prompt-handler.ts test/bot/prompt-handler.test.ts
git commit -m "feat: stream Telegram output chronologically"
```

---

### Task 3: Preserve bot-level topic, Abort, activity, and verbosity behavior

**Files:**
- Modify: `test/bot.test.ts`
- Modify: `src/bot/prompt-handler.ts` only if integration tests expose a production defect

**Interfaces:**
- Consumes: chronological delivery from Task 2 and existing callback-context routing in `bot.ts`.
- Produces: end-to-end regression coverage for forum topics and settings.

- [ ] **Step 1: Update obsolete message-order assertions**

Replace expectations that assistant text edits `Working…` with assertions that status remains separate and assistant output is sent later. Assert Telegram call order using message IDs.

- [ ] **Step 2: Add a forum-topic Abort regression test**

Start a prompt in a forum topic, emit output so Abort migrates to an output message, then deliver `pi_abort` from a callback update without `message_thread_id`. Assert callback-message context resolves the correct topic session and aborts it.

- [ ] **Step 3: Add topic-scoped activity regressions**

Disable activity in topic A and verify thinking is absent there while assistant segments remain chronological. Verify topic B still shows thinking, and re-enabling topic A restores activity.

- [ ] **Step 4: Preserve every TOOL_VERBOSITY mode**

With activity disabled, verify `summary`, `all`, `errors-only`, and `none` retain existing tool presentation. Assert summary text appears in an assistant segment below status, not in status.

- [ ] **Step 5: Preserve topic-name synchronization**

Keep the existing prompt-time session-name-change test passing without modifying its event path. Assert chronological delivery does not suppress or reorder `onSessionInfoChanged` handling.

- [ ] **Step 6: Run integration tests and commit**

Run:

```bash
npm test -- test/bot.test.ts
npm test -- test/bot/prompt-handler.test.ts test/bot.test.ts
npm run build
```

Expected: PASS.

Commit:

```bash
git add test/bot.test.ts src/bot/prompt-handler.ts
git commit -m "test: cover chronological Telegram integration"
```

---

### Task 4: Update documentation and verify the branch

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: completed chronological behavior.
- Produces: accurate user and architecture documentation.

- [ ] **Step 1: Update README behavior**

Document chronological activity/assistant segments, the status-only first message, one Abort button following the newest output, and native typing throughout the run. Remove wording that says activity and final assistant output are always separate final messages when that wording conflicts with chronological segments.

- [ ] **Step 2: Update architecture documentation**

Add `stream-segments.ts` to the bot module map and describe `prompt-handler.ts` as one serialized chronological delivery pipeline. Preserve the recently added topic-name synchronization documentation.

- [ ] **Step 3: Run source and documentation checks**

Run:

```bash
rg -n "chronological|Abort|typing|stream-segments" README.md docs/architecture.md src test
git diff --check
```

Expected: references exist and no whitespace errors appear.

- [ ] **Step 4: Run complete verification**

Run:

```bash
npm test
npm run build
npm run test:coverage
git diff --check
git status --short
```

Expected: all tests and build pass, coverage thresholds remain satisfied, and only intended documentation changes are uncommitted.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/architecture.md
git commit -m "docs: explain chronological Telegram streaming"
```
