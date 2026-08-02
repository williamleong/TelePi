# Immediate Telegram Abort Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every active TelePi prompt an immediate inline Abort control without leaving a separate routine Working or Done message.

**Architecture:** Send one temporary `Working…` message with Abort after session activation. Let the chronological segment worker adopt that message ID by editing it into the first real output chunk; retain existing Abort migration for later chunks. Delete an unused status on silent success and edit it to the existing terminal status on early failure.

**Tech Stack:** TypeScript 5.7, Node.js 22.19+, Grammy 1.44, Vitest 3.2

## Global Constraints

- Keep the chronological segment worker as the sole activity and assistant output pipeline.
- Keep exactly one intended Abort owner and preserve attach-before-detach migration.
- Keep `/abort`, steering, activity rendering, tool verbosity semantics, callback routing, and Pi SDK cancellation unchanged.
- A working-message transport failure must not prevent the Pi prompt from starting.
- Normal successful output must not leave a separate `Working…` or `Done` message.
- Use strict TypeScript, ESM `.js` imports, 2-space indentation, double quotes, and semicolons.
- Add no dependency.

---

### Task 1: Adopt a temporary working message into prompt output

**Files:**
- Modify: `src/bot/prompt-handler.ts:127-286, 459-507`
- Modify: `test/bot/prompt-handler.test.ts:5-229, 414-1361`
- Modify if required by integration mocks: `test/bot.test.ts:450-530`

**Interfaces:**
- Consumes: `sendTextMessage()`, `safeEditMessage()`, `renderPromptFailure()`, `trackCallbackMessage()`, `streamSegments.setChunkMessageId()`, and the existing Abort owner set.
- Produces: prompt lifecycle behavior only; no new exported API.

- [ ] **Step 1: Extend the focused harness and write failing lifecycle tests**

Add deletion to the recorded operation union and fake Telegram API:

```ts
type TelegramOperation =
  | { kind: "send"; messageId: number; text: string; hasAbort: boolean; delivery: "plain" | "rich" }
  | { kind: "edit"; messageId: number; text: string; hasAbort: boolean; delivery: "plain" | "rich" }
  | { kind: "markup"; messageId: number; hasAbort: boolean }
  | { kind: "delete"; messageId: number }
  | { kind: "typing" };
```

```ts
async deleteMessage(_chatId: number, messageId: number) {
  record({ kind: "delete", messageId });
  return true;
},
```

Write focused tests with deferred prompt settlement:

```ts
it("shows Abort while a prompt has no visible output", async () => {
  const promptRelease = deferred();
  const promptStarted = deferred();
  const harness = createPromptHarness({
    onPrompt: async () => {
      promptStarted.resolve();
      await promptRelease.promise;
    },
  });

  const result = harness.run();
  await promptStarted.promise;

  expect(harness.operations).toContainEqual(expect.objectContaining({
    kind: "send",
    messageId: 1,
    text: expect.stringMatching(/Working/i),
    hasAbort: true,
  }));

  promptRelease.resolve();
  await expect(result).resolves.toBe(true);
});
```

```ts
it("edits the working message into the first Agent activity", async () => {
  let harness!: ReturnType<typeof createPromptHarness>;
  harness = createPromptHarness({
    onPrompt: async (callbacks) => {
      callbacks.onToolStart("Agent", "agent-1", { description: "Inspect code" });
      await harness.waitForOperation(
        (operation) => operation.kind === "edit"
          && operation.messageId === 1
          && operation.text.includes("Agent"),
      );
    },
  });

  await expect(harness.run()).resolves.toBe(true);
  expect(harness.operations).toContainEqual(expect.objectContaining({
    kind: "edit",
    messageId: 1,
    hasAbort: true,
  }));
  expect(harness.operations.filter((operation) => operation.kind === "send")).toHaveLength(1);
});
```

Add the remaining focused cases:

```ts
it("edits the working message into the first assistant output when activity is disabled", async () => {
  const harness = createPromptHarness({
    activityEnabled: false,
    onPrompt: (callbacks) => callbacks.onTextDelta("answer"),
  });

  await expect(harness.run()).resolves.toBe(true);
  expect(harness.operations).toContainEqual(expect.objectContaining({
    kind: "edit",
    messageId: 1,
    text: expect.stringContaining("answer"),
    hasAbort: true,
  }));
});
```

```ts
it("adopts the working message for the first chunk and migrates Abort on rollover", async () => {
  const harness = createPromptHarness({
    onPrompt: (callbacks) => callbacks.onThinkingDelta({ blockKey: "1", delta: "x".repeat(4_100) }),
  });

  await expect(harness.run()).resolves.toBe(true);
  expect(harness.operations).toContainEqual(expect.objectContaining({ kind: "edit", messageId: 1, hasAbort: true }));
  expect(harness.operations).toContainEqual(expect.objectContaining({ kind: "send", messageId: 2 }));
  expect(harness.operations).toContainEqual(expect.objectContaining({ kind: "markup", messageId: 2, hasAbort: true }));
  expect(harness.operations).toContainEqual(expect.objectContaining({ kind: "markup", messageId: 1, hasAbort: false }));
});
```

```ts
it("deletes an unused working message after silent success", async () => {
  const harness = createPromptHarness({ onPrompt: () => {} });

  await expect(harness.run()).resolves.toBe(true);
  expect(harness.operations).toContainEqual({ kind: "delete", messageId: 1 });
  expect(harness.operations.filter((operation) => operation.kind === "edit")).toEqual([]);
});
```

```ts
it.each([
  ["failure", new Error("prompt failed")],
  ["abort", new Error("Abort requested by user")],
])("edits an unused working message for early %s", async (_name, promptError) => {
  const harness = createPromptHarness({ promptError });

  await expect(harness.run()).resolves.toBe(false);
  expect(harness.operations).toContainEqual(expect.objectContaining({
    kind: "edit",
    messageId: 1,
    text: expect.stringMatching(/failed|aborted/i),
  }));
  expect(harness.operations.filter((operation) => operation.kind === "send")).toHaveLength(1);
});
```

```ts
it("falls back to first-output Abort ownership when the working message fails", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  let sendCount = 0;
  const harness = createPromptHarness({
    onSend: () => {
      sendCount += 1;
      if (sendCount === 1) {
        throw new Error("working send failed");
      }
    },
    onPrompt: (callbacks) => callbacks.onTextDelta("answer"),
  });

  try {
    await expect(harness.run()).resolves.toBe(true);
    expect(harness.operations).toContainEqual(expect.objectContaining({
      kind: "send",
      messageId: 2,
      text: expect.stringContaining("answer"),
      hasAbort: true,
    }));
  } finally {
    consoleError.mockRestore();
  }
});
```

Update existing output assertions to accept the first chunk as an edit of message 1 while retaining exact chronology, owner migration, and cleanup assertions.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- --run test/bot/prompt-handler.test.ts
```

Expected: new tests fail because no `Working…` message is sent, no status is adopted, and silent success has nothing to delete.

- [ ] **Step 3: Add temporary status state and best-effort creation**

In `runPromptFlow()`, add private state beside the existing Abort owner state:

```ts
let workingMessageId: number | undefined;
let workingMessagePromise: Promise<void> | undefined;
let workingMessageAdopted = false;
```

Add an idempotent creator after `migrateAbortOwner()`:

```ts
const ensureWorkingMessage = async (): Promise<void> => {
  if (workingMessageId !== undefined) {
    return;
  }
  if (workingMessagePromise) {
    return workingMessagePromise;
  }

  workingMessagePromise = (async () => {
    const message = await sendTextMessage(bot.api, target, "<i>⏳ Working…</i>", {
      fallbackText: "⏳ Working…",
      replyMarkup: abortKeyboard,
    });
    workingMessageId = message.message_id;
    abortOwnerMessageId = message.message_id;
    abortOwnerMessageIds.add(message.message_id);
    trackCallbackMessage?.(target, message.message_id);
    sendTyping();
  })();

  try {
    await workingMessagePromise;
  } catch (error) {
    console.error("Failed to send Telegram working message", error);
  } finally {
    workingMessagePromise = undefined;
  }
};
```

Call `await ensureWorkingMessage()` after session activation and command synchronization setup, before extension binding and `piSession.prompt()`.

- [ ] **Step 4: Make the segment worker adopt the status as its first chunk**

In `deliverSegment()`, before the existing `sendTextMessage()` branch for a chunk without a message ID, adopt the working message when available:

```ts
if (
  current.messageId === undefined
  && workingMessageId !== undefined
  && !workingMessageAdopted
) {
  await safeEditMessage(bot, target, workingMessageId, rendered.text, {
    parseMode: rendered.parseMode,
    fallbackText: rendered.fallbackText,
    delivery: rendered.delivery,
    replyMarkup: abortKeyboard,
  });
  streamSegments.setChunkMessageId(segment.id, index, workingMessageId);
  workingMessageAdopted = true;
  changed = true;
  sendTyping();
  continue;
}
```

Keep the normal send branch unchanged as the fallback when no working message exists. Keep `migrateAbortOwner()` unchanged so later messages still attach Abort before detaching the previous owner.

- [ ] **Step 5: Finalize unused status messages without persistent clutter**

Add a best-effort silent-success cleanup:

```ts
const deleteUnusedWorkingMessage = async (): Promise<void> => {
  if (workingMessageId === undefined || workingMessageAdopted) {
    return;
  }

  try {
    await bot.api.deleteMessage(target.chatId, workingMessageId);
    abortOwnerMessageIds.delete(workingMessageId);
    if (abortOwnerMessageId === workingMessageId) {
      abortOwnerMessageId = undefined;
    }
  } catch (error) {
    console.error("Failed to delete Telegram working message", error);
  }
};
```

After `drainDelivery()` in success finalization, call `deleteUnusedWorkingMessage()` before `cleanupAbortOwners()`.

For failure finalization, replace the unconditional standalone reply with:

```ts
const status = renderPromptFailure("", error);
try {
  if (workingMessageId !== undefined && !workingMessageAdopted) {
    await safeEditMessage(bot, target, workingMessageId, status, {
      fallbackText: status,
      replyMarkup: abortKeyboard,
    });
  } else {
    await safeReply(ctx, status, { fallbackText: status }, target);
  }
} catch (telegramError) {
  console.error("Failed to send Telegram prompt failure status", telegramError);
}
```

Then retain `cleanupAbortOwners()`, delivery finalization, and typing shutdown.

- [ ] **Step 6: Run focused tests and make them GREEN**

Run:

```bash
npm test -- --run test/bot/prompt-handler.test.ts
```

Expected: all prompt-handler tests pass, including immediate Abort, first-output adoption, fallback, silent success, failure, migration, delivery drain, and typing lifecycle.

- [ ] **Step 7: Run bot integration tests and add only required mock support**

Run:

```bash
npm test -- --run test/bot.test.ts
```

If the shared Grammy mock lacks `deleteMessage`, add `deleteMessage: vi.fn().mockResolvedValue(true)` beside `sendMessage` and `editMessageText`. Update expectations only where the first prompt output is now an edit of message 1 or where silent success deletes the temporary status. Do not loosen unrelated assertions.

Expected: all bot integration tests pass.

- [ ] **Step 8: Run TypeScript build and full suite**

Run:

```bash
npm run build
npm test
```

Expected: TypeScript compilation succeeds and all tests pass.

- [ ] **Step 9: Commit the behavior change**

```bash
git add src/bot/prompt-handler.ts test/bot/prompt-handler.test.ts test/bot.test.ts
git commit -m "fix: keep Telegram abort control visible"
```

### Task 2: Document the immediate Abort lifecycle

**Files:**
- Modify: `README.md:232-240`
- Modify: `docs/architecture.md:88-99`

**Interfaces:**
- Consumes: the Task 1 prompt lifecycle.
- Produces: user and maintainer documentation only.

- [ ] **Step 1: Update README behavior**

Replace the statement that typing is the only pre-output signal and `/abort` is required before output with concise text that states:

```text
After session activation, TelePi sends a temporary `⏳ Working…` message with `⏹ Abort`. The first activity or assistant segment replaces that message in place, so normal output does not gain a separate status row. A silent success removes the temporary message, while an early abort or failure turns it into the terminal status. The Abort button then follows newer output messages until the run settles; `/abort` remains available as a fallback.
```

Keep the existing chronology, typing interval, activity formatting, and steering description.

- [ ] **Step 2: Update architecture lifecycle**

In `docs/architecture.md`, document that `prompt-handler.ts`:

- creates a temporary initial Abort owner after session activation;
- lets the first stream chunk adopt that message ID;
- retains attach-before-detach migration for later output;
- deletes an unused status on silent success or edits it on early failure;
- drains delivery before cleanup and stops typing only after settlement.

Remove the sentence that says there is no success-path Working status message and that `/abort` is the only pre-output path.

- [ ] **Step 3: Check documentation consistency**

Run:

```bash
rg -n "Working|Done|first output|before output|Abort" README.md docs/architecture.md docs/superpowers/specs/2026-08-02-immediate-abort-control-design.md
```

Expected: current README and architecture text describe the temporary adopted status; historical design documents may retain their dated rationale.

- [ ] **Step 4: Run formatting and regression checks**

Run:

```bash
git diff --check
npm test -- --run test/bot/prompt-handler.test.ts test/bot.test.ts
```

Expected: no whitespace errors and all relevant tests pass.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/architecture.md
git commit -m "docs: explain immediate Telegram abort control"
```

### Task 3: Final verification

**Files:**
- Verify only; do not modify files unless a verification failure exposes a defect in this plan's changes.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: release-ready local branch evidence.

- [ ] **Step 1: Run clean build and full test suite**

```bash
npm run build:clean
npm test
```

Expected: build succeeds and all test files pass.

- [ ] **Step 2: Check final branch scope**

```bash
git diff --check
git status --short
git diff --stat main...HEAD
git log --oneline main..HEAD
```

Expected: only the design, plan, prompt lifecycle, focused test support, README, and architecture documentation changed; the worktree is clean.
