# Telegram `ask_user` Single-Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove TelePi’s redundant `ask_user` tool-activity message and Abort button while preserving the structured dialog’s Cancel control and normal post-dialog streaming.

**Architecture:** Classify the exact `ask_user` tool name as dialog-backed at the prompt-handler boundary. Track its call IDs and ignore their start, update, and end events before activity and verbosity handling; leave the extension-dialog manager unchanged.

**Tech Stack:** TypeScript, Node.js, grammY, Vitest

## Global Constraints

- The extension dialog remains the only visible representation of an active `ask_user` call.
- `/abort` continues to stop the entire Pi operation.
- All non-`ask_user` tools retain existing activity, verbosity, summary, and Abort behavior.
- Prompt failures remain visible through the existing failure path.
- Do not change the `ask_user` API, callback payloads, extension-dialog rendering, or Pi’s native TUI.

---

## File Map

- Modify `src/bot/prompt-handler.ts`: classify dialog-backed tools and suppress their stream events.
- Modify `test/bot/prompt-handler.test.ts`: cover suppression across output modes and normal delivery after the dialog call.

### Task 1: Suppress dialog-backed tool activity

**Files:**
- Modify: `src/bot/prompt-handler.ts:35-45,125-140,582-675`
- Test: `test/bot/prompt-handler.test.ts`

**Interfaces:**
- Consumes: Pi callback events `onToolStart(toolName, toolCallId, args)`, `onToolUpdate(toolCallId, partialResult)`, and `onToolEnd(toolCallId, isError)`.
- Produces: `isDialogBackedTool(toolName: string): boolean`; prompt-local `Set<string>` state for suppressed call IDs.

- [ ] **Step 1: Add failing output-mode regression tests**

Add these tests near the existing tool-delivery tests in `test/bot/prompt-handler.test.ts`:

```ts
it.each([
  [true, "all"],
  [false, "all"],
  [false, "summary"],
  [false, "errors-only"],
] as const)(
  "does not render ask_user as tool activity with activity=%s and verbosity=%s",
  async (activityEnabled, toolVerbosity) => {
    const harness = createPromptHarness({
      activityEnabled,
      toolVerbosity,
      onPrompt: (callbacks) => {
        callbacks.onToolStart("ask_user", "question-1", { question: "Choose one" });
        callbacks.onToolUpdate("question-1", "waiting for input");
        callbacks.onToolEnd("question-1", true);
      },
    });

    await expect(harness.run()).resolves.toBe(true);
    expect(harness.operations.filter(
      (operation) => operation.kind === "send"
        || operation.kind === "edit"
        || operation.kind === "markup",
    )).toEqual([]);
    expect(harness.trackCallbackMessages).toEqual([]);
  },
);
```

This deliberately ends the call as an error so the `errors-only` branch would render it without suppression.

- [ ] **Step 2: Add a failing delivery-resumption regression test**

Add this test beside Step 1’s table:

```ts
it("resumes normal delivery and Abort ownership after ask_user resolves", async () => {
  const harness = createPromptHarness({
    activityEnabled: true,
    toolVerbosity: "all",
    onPrompt: (callbacks) => {
      callbacks.onToolStart("ask_user", "question-1", { question: "Choose one" });
      callbacks.onToolUpdate("question-1", "waiting for input");
      callbacks.onToolEnd("question-1", false);
      callbacks.onTextDelta("Answer accepted");
    },
  });

  await expect(harness.run()).resolves.toBe(true);
  const sends = harness.operations.filter(
    (operation): operation is Extract<TelegramOperation, { kind: "send" }> => operation.kind === "send",
  );
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ text: expect.stringContaining("Answer accepted"), hasAbort: true });
  expect(sends[0].text).not.toMatch(/ask[ _]user/i);
  expect(harness.trackCallbackMessages).toEqual([sends[0].messageId]);
});
```

- [ ] **Step 3: Run the focused tests and verify the new assertions fail**

Run:

```bash
npm test -- test/bot/prompt-handler.test.ts -t "ask_user"
```

Expected: the output-mode table fails because current code renders `ask_user`; the delivery-resumption test fails because it sends both activity and assistant output.

- [ ] **Step 4: Add the narrow tool classifier and prompt-local state**

In `src/bot/prompt-handler.ts`, add the classifier after `stringifyToolUpdate`:

```ts
function isDialogBackedTool(toolName: string): boolean {
  return toolName === "ask_user";
}
```

In `runPromptFlow`, beside `toolStates` and `toolCounts`, add:

```ts
const dialogBackedToolCallIds = new Set<string>();
```

- [ ] **Step 5: Filter all three tool callback phases**

At the start of `onToolStart`, before the activity and verbosity branches, add:

```ts
if (isDialogBackedTool(toolName)) {
  dialogBackedToolCallIds.add(toolCallId);
  return;
}
```

At the start of `onToolUpdate`, add:

```ts
if (dialogBackedToolCallIds.has(toolCallId)) {
  return;
}
```

At the start of `onToolEnd`, add:

```ts
if (dialogBackedToolCallIds.delete(toolCallId)) {
  return;
}
```

Deleting on completion prevents prompt-local tracking from retaining finished call IDs during long runs.

- [ ] **Step 6: Run focused tests and verify they pass**

Run:

```bash
npm test -- test/bot/prompt-handler.test.ts -t "ask_user"
```

Expected: PASS for all new `ask_user` tests.

- [ ] **Step 7: Run the complete verification suite**

Run:

```bash
npm test
npx tsc --noEmit
npm run build
```

Expected: all tests pass, TypeScript reports no errors, and the production build succeeds.

- [ ] **Step 8: Commit the implementation**

```bash
git add src/bot/prompt-handler.ts test/bot/prompt-handler.test.ts docs/superpowers/plans/2026-08-02-telegram-ask-user-single-control.md
git commit -m "fix: hide redundant ask-user tool activity"
```
