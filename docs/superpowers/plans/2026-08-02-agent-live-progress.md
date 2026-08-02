# Agent Live Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit TelePi's foreground Agent activity row with the subagent's current structured activity and a terminal Done/Error detail.

**Architecture:** Preserve structured Pi tool updates through the session callback, then let the activity transcript validate and own Agent-specific display state. The chronological segment model marks the owning segment dirty, and the existing serialized Telegram worker edits the delivered activity message.

**Tech Stack:** TypeScript, Pi SDK 0.83.0 events, grammY, Telegram HTML, Vitest.

## Global Constraints

- Apply live progress only to the exact foreground tool name `Agent`.
- Read only the structured `partialResult.details.activity` string; never parse JSON text or expose arbitrary tool output.
- Keep background Agent behavior, other tools, Telegram commands, and configuration unchanged.
- Reuse the existing chronological delivery worker and Telegram size/HTML safeguards.

---

### Task 1: Preserve and model structured Agent updates

**Files:**
- Modify: `src/pi-session.ts:60-66,580-589,1535-1548`
- Modify: `src/bot/activity-rendering.ts:5-67,150-235`
- Test: `test/pi-session.test.ts:2000-2060`
- Test: `test/bot/activity-rendering.test.ts`

**Interfaces:**
- Produces: `PiSessionCallbacks.onToolUpdate(toolCallId: string, partialResult: unknown): void`
- Produces: `ActivityTranscript.updateTool(toolCallId: string, partialResult: unknown): boolean`
- Produces: Agent tool entries with optional `detail?: string`
- Consumes: Agent partial results shaped as `{ details: { activity: string } }`

- [x] **Step 1: Write failing session-bridge and activity tests**

Change the session assertion to require the original object:

```ts
const partialResult = { details: { activity: "running command…" } };
emit?.({ type: "tool_execution_update", toolCallId: "tool-1", partialResult });
expect(onToolUpdate).toHaveBeenCalledWith("tool-1", partialResult);
```

Add activity tests covering the exact accepted shape, duplicate updates, malformed values, non-Agent tools, invocation descriptions, and completion:

```ts
it("updates only Agent activity from structured partial results", () => {
  const transcript = createActivityTranscript();
  transcript.startTool("agent-1", "Agent", { description: "Find relevant code" });

  expect(transcript.updateTool("agent-1", {
    details: { activity: "running command…" },
  })).toBe(true);
  expect(transcript.updateTool("agent-1", {
    details: { activity: "running command…" },
  })).toBe(false);
  expect(transcript.updateTool("missing", {
    details: { activity: "reading…" },
  })).toBe(false);

  expect(renderActivityTranscript(transcript)[0]?.fallbackText).toContain(
    "• Agent — Find relevant code\nrunning command…",
  );

  transcript.finishTool("agent-1", false);
  expect(renderActivityTranscript(transcript)[0]?.fallbackText).toContain(
    "✓ Agent — Find relevant code\nDone",
  );
});

it.each([null, [], {}, { details: null }, { details: { activity: " " } }])(
  "ignores malformed Agent update %j",
  (partialResult) => {
    const transcript = createActivityTranscript();
    transcript.startTool("agent-1", "Agent", {});
    expect(transcript.updateTool("agent-1", partialResult)).toBe(false);
  },
);

it("ignores structured updates for other tools", () => {
  const transcript = createActivityTranscript();
  transcript.startTool("bash-1", "bash", { command: "npm test" });
  expect(transcript.updateTool("bash-1", {
    details: { activity: "must not appear" },
  })).toBe(false);
});
```

Add a matching error assertion for `✗ Agent — Find relevant code\nError`.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- test/pi-session.test.ts test/bot/activity-rendering.test.ts
```

Expected: FAIL because the session bridge stringifies the partial result and `updateTool()` does not exist.

- [x] **Step 3: Forward structured partial results**

Change the callback type and subscription:

```ts
onToolUpdate: (toolCallId: string, partialResult: unknown) => void;
```

```ts
case "tool_execution_update":
  callbacks.onToolUpdate(event.toolCallId, event.partialResult);
  break;
```

Remove `stringifyToolData()` if no references remain.

- [x] **Step 4: Add Agent-specific transcript state**

Extend the tool entry and interface:

```ts
| {
    kind: "tool";
    toolCallId: string;
    toolName: string;
    args: unknown;
    status: ActivityToolStatus;
    detail?: string;
  };

updateTool(toolCallId: string, partialResult: unknown): boolean;
```

Implement strict extraction and no-op detection:

```ts
updateTool(toolCallId, partialResult) {
  const entry = entries.find(
    (candidate): candidate is Extract<ActivityEntry, { kind: "tool" }> =>
      candidate.kind === "tool" && candidate.toolCallId === toolCallId,
  );
  if (!entry || entry.toolName !== "Agent") return false;

  const activity = readNestedActivity(partialResult);
  if (!activity || activity === entry.detail) return false;
  entry.detail = activity;
  return true;
}
```

`readNestedActivity()` must reject arrays, require object-valued `details`, trim the activity string, and reject an empty result. In `finishTool()`, set Agent detail to `Error` or `Done` after setting status.

Render Agent summaries from allowlisted fields only:

```ts
if (entry.toolName === "Agent") {
  const description = readString(entry.args, "description")?.trim();
  return {
    label: description ? `Agent — ${description}` : "Agent",
    detail: entry.detail,
  };
}
```

Keep existing `summarizeTool(toolName, args)` behavior for every other tool.

- [x] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npm test -- test/pi-session.test.ts test/bot/activity-rendering.test.ts
```

Expected: both suites PASS.

- [x] **Step 6: Commit the structured update model**

```bash
git add src/pi-session.ts src/bot/activity-rendering.ts test/pi-session.test.ts test/bot/activity-rendering.test.ts
git commit -m "feat: model Agent live activity"
```

---

### Task 2: Deliver Agent updates by editing the owning Telegram segment

**Files:**
- Modify: `src/bot/stream-segments.ts:27-35,88-120`
- Modify: `src/bot/prompt-handler.ts:635-648`
- Test: `test/bot/stream-segments.test.ts`
- Test: `test/bot/prompt-handler.test.ts`

**Interfaces:**
- Consumes: `ActivityTranscript.updateTool(toolCallId: string, partialResult: unknown): boolean`
- Produces: `StreamSegments.updateTool(toolCallId: string, partialResult: unknown): StreamSegment | undefined`
- Consumes: structured `PiSessionCallbacks.onToolUpdate` values

- [x] **Step 1: Write failing stream-segment tests**

Add tests proving the owning segment changes in place and invalid updates do not change its revision:

```ts
it("updates an Agent in its owning activity segment", () => {
  const stream = createStreamSegments();
  const activity = stream.startTool("Agent", "agent-1", {
    description: "Find relevant code",
  });
  stream.appendAssistantText("Waiting");
  const revision = activity.revision;

  expect(stream.updateTool("agent-1", {
    details: { activity: "reading…" },
  })).toBe(activity);
  expect(activity.revision).toBe(revision + 1);
  expect(activity.activity?.entries[0]).toMatchObject({ detail: "reading…" });
  expect(stream.getSegments().map((segment) => segment.kind)).toEqual([
    "activity",
    "assistant",
  ]);
});

it("does not dirty a segment for unusable Agent updates", () => {
  const stream = createStreamSegments();
  const activity = stream.startTool("Agent", "agent-1", {});
  const revision = activity.revision;

  expect(stream.updateTool("agent-1", { details: { activity: " " } })).toBeUndefined();
  expect(activity.revision).toBe(revision);
});
```

- [x] **Step 2: Write a failing prompt-delivery test**

Use `createPromptHarness()` with activity enabled. Start Agent, wait for message 2, emit one structured update, wait for the edit, then finish:

```ts
it("edits the Agent activity message with live progress", async () => {
  let harness!: ReturnType<typeof createPromptHarness>;
  harness = createPromptHarness({
    onPrompt: async (callbacks) => {
      callbacks.onToolStart("Agent", "agent-1", { description: "Find relevant code" });
      await harness.waitForOperation(
        (operation) => operation.kind === "send" && operation.messageId === 2,
      );
      callbacks.onToolUpdate("agent-1", {
        details: { activity: "running command…" },
      });
      await harness.waitForOperation(
        (operation) => operation.kind === "edit"
          && operation.messageId === 2
          && operation.text.includes("running command"),
      );
      callbacks.onToolEnd("agent-1", false);
    },
  });

  await expect(harness.run()).resolves.toBe(true);
  expect(harness.operations).toContainEqual(expect.objectContaining({
    kind: "edit",
    messageId: 2,
    text: expect.stringContaining("Done"),
  }));
  expect(harness.operations.filter(
    (operation) => operation.kind === "send" && operation.messageId > 1,
  )).toHaveLength(1);
});
```

Update the harness callback type, if locally declared, so `onToolUpdate` accepts `unknown`.

- [x] **Step 3: Run focused tests and verify RED**

Run:

```bash
npm test -- test/bot/stream-segments.test.ts test/bot/prompt-handler.test.ts
```

Expected: FAIL because `StreamSegments.updateTool()` does not exist and activity mode discards tool updates.

- [x] **Step 4: Implement segment update ownership**

Add the interface method and implementation:

```ts
updateTool(toolCallId, partialResult) {
  const segmentId = toolSegmentIds.get(toolCallId);
  if (segmentId === undefined) return undefined;
  const segment = findSegment(segmentId);
  if (!segment?.activity?.updateTool(toolCallId, partialResult)) return undefined;
  segment.revision += 1;
  return segment;
},
```

Do not create a new segment and do not alter `toolSegmentIds`; completion still owns cleanup.

- [x] **Step 5: Route updates through chronological delivery**

Change activity-mode handling in `prompt-handler.ts`:

```ts
onToolUpdate: (toolCallId, partialResult) => {
  if (activityEnabled) {
    if (streamSegments.updateTool(toolCallId, partialResult)) {
      void requestDelivery();
    }
    return;
  }
  // existing legacy handling remains below
},
```

For legacy activity-off modes, convert structured tool updates to preview text at that boundary:

```ts
function stringifyToolUpdate(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
```

Call `stringifyToolUpdate(partialResult)` before the existing `appendWithCap()` call. Preserve current summary/none/all/errors-only behavior.

- [x] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
npm test -- test/bot/stream-segments.test.ts test/bot/prompt-handler.test.ts test/pi-session.test.ts test/bot/activity-rendering.test.ts
```

Expected: all focused suites PASS.

- [x] **Step 7: Commit Telegram delivery integration**

```bash
git add src/bot/stream-segments.ts src/bot/prompt-handler.ts test/bot/stream-segments.test.ts test/bot/prompt-handler.test.ts
git commit -m "feat: stream Agent progress to Telegram"
```

---

### Task 3: Document and verify the finished behavior

**Files:**
- Modify: `README.md:236-240`
- Modify: `docs/architecture.md:84-94`

**Interfaces:**
- Consumes: completed Agent live-progress behavior from Tasks 1 and 2
- Produces: user and maintainer documentation for the Agent-specific update path

- [x] **Step 1: Update user documentation**

Add one sentence to the activity section:

```md
Foreground Agent rows also edit in place with the subagent's compact current activity, such as `reading…` or `running command…`, and settle to `Done` or `Error`.
```

- [x] **Step 2: Update architecture documentation**

Document that activity segments route structured Agent partial results back to the owning tool entry and increment its revision only when the visible activity changes.

- [x] **Step 3: Run formatting and type checks**

Run:

```bash
git diff --check
npm run build
```

Expected: no whitespace errors and TypeScript compilation succeeds.

- [x] **Step 4: Run the complete test suite**

Run:

```bash
npm test
```

Expected: all test files and tests PASS.

- [x] **Step 5: Commit documentation**

```bash
git add README.md docs/architecture.md
git commit -m "docs: explain Agent live progress"
```

- [x] **Step 6: Inspect final branch state**

Run:

```bash
git status --short --branch
git log --oneline --decorate -5
```

Expected: clean `feat/agent-live-progress` worktree with the design, implementation, tests, and documentation committed.

---

### Task 4: Address code-review edge cases

**Files:**
- Modify: `src/bot/activity-rendering.ts`
- Modify: `docs/architecture.md`
- Test: `test/bot/activity-rendering.test.ts`
- Test: `test/bot/prompt-handler.test.ts`

**Interfaces:**
- Preserves: `ActivityTranscript.updateTool(toolCallId: string, partialResult: unknown): boolean`
- Produces: one dedicated, bounded Telegram chunk for each Agent activity entry

- [x] **Step 1: Reproduce delivered-chunk shrinkage, oversized descriptions, and throwing accessors**

- [x] **Step 2: Verify the new tests fail for the reported reasons**

- [x] **Step 3: Isolate Agent entries into dedicated chunks and bound descriptions to 512 characters**

- [x] **Step 4: Ignore partial-result property access that throws**

- [x] **Step 5: Cover structured updates in activity-off errors-only mode**

- [x] **Step 6: Run focused activity and prompt-handler tests**
