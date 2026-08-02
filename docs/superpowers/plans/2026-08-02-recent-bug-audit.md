# Recent Bug Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix confirmed regressions found while reviewing the 105 commits between `origin/main` and `main`, with a failing regression test for every behavior change.

**Architecture:** Keep each fix inside its existing subsystem: chronological stream state, assistant chunk rendering, topic-session restoration, Telegram Abort ownership, extension-dialog bounds, and dependency metadata. Preserve current public behavior except where the current behavior loses/corrupts data, targets the wrong run, or sends an invalid Telegram request.

**Tech Stack:** TypeScript 5.7, Node.js 22.19+, grammY, Pi SDK 0.83.0, Vitest 3.2.x

## Global Constraints

- Follow strict TypeScript, ESM imports with `.js` suffixes, two-space indentation, double quotes, and semicolons.
- Use test-driven development: run each new regression test before production edits and confirm it fails for the stated bug.
- Keep all Telegram text and fallback text at or below `TELEGRAM_MESSAGE_LIMIT` (4,000 UTF-16 code units in TelePi's conservative transport policy).
- Preserve chronological segment order; never edit a sealed stream segment.
- Preserve attach-before-detach Abort migration and `/abort` command behavior.
- A stale Abort callback may never cancel a different prompt run.
- Persistence remains best effort and must not make TelePi unavailable.
- Do not change the intentional degraded `ExtensionUIContext.custom()` contract; resolving `undefined` is required for `pi-ask-user` fallback.
- Do not add inter-process locking: TelePi's supported service model is one polling process per bot token. Record concurrent store instances as a residual limitation rather than introducing a lock protocol.
- Do not change the intentionally extended internal `PiSessionCallbacks` contract in this audit.
- Do not upgrade the coordinated Pi SDK packages beyond 0.83.0; no newer compatible package exists.
- Keep commits single-purpose and use Conventional Commit messages.

---

### Task 1: Preserve chronological summaries and Unicode chunks

**Files:**
- Modify: `src/bot/prompt-handler.ts:635-660`
- Modify: `src/bot/message-rendering.ts:528-589`
- Test: `test/bot/prompt-handler.test.ts`
- Test: `test/bot/message-rendering.test.ts`

**Interfaces:**
- Consumes: `StreamSegment.sealed`, `StreamSegments.appendAssistantText()`, `renderAssistantSegment()`.
- Produces: summaries appended only to the current unsealed assistant segment; assistant chunks whose boundaries never split a UTF-16 surrogate pair.

- [ ] **Step 1: Add the failing summary-order test**

Add a focused prompt-handler test using the existing activity-disabled/summary harness pattern:

```ts
it("emits a tool summary after a sealed assistant segment", async () => {
  const harness = createHarness({ activityEnabled: false, toolVerbosity: "summary" });

  await harness.run({
    onPrompt: (callbacks) => {
      callbacks.onTextDelta("I'll inspect first.");
      callbacks.onToolStart("read", "tool-1", { path: "src/index.ts" });
      callbacks.onToolEnd("tool-1", false);
    },
  });

  const assistantOperations = harness.operations.filter(
    (operation) => (operation.kind === "send" || operation.kind === "edit")
      && operation.text.includes("Assistant"),
  );
  expect(assistantOperations.map((operation) => operation.text)).toEqual([
    expect.stringContaining("I'll inspect first."),
    expect.stringContaining("read ×1"),
  ]);
});
```

Use the harness's actual summary copy from `formatToolSummaryLine()` if it differs from `read ×1`; assert that the summary appears in a later Telegram operation and that the earlier assistant operation is not edited after the tool segment.

- [ ] **Step 2: Verify the summary test is RED**

Run:

```bash
npx vitest run test/bot/prompt-handler.test.ts -t "emits a tool summary after a sealed assistant segment"
```

Expected: FAIL because `appendToolSummary()` mutates the last assistant segment even when `sealed === true`.

- [ ] **Step 3: Fix summary placement minimally**

In `appendToolSummary()`, reuse the previous assistant segment only when it is unsealed:

```ts
const lastAssistant = [...streamSegments.getSegments()].reverse().find(
  (segment) => segment.kind === "assistant",
);
if (!lastAssistant || lastAssistant.sealed) {
  streamSegments.appendAssistantText(summary);
  return;
}
```

Keep the existing text join and revision increment for an active unsealed assistant segment.

- [ ] **Step 4: Verify the summary test is GREEN**

Run the same focused command. Expected: PASS.

- [ ] **Step 5: Add failing surrogate-boundary tests**

Add tests for both delivery modes:

```ts
it.each(["plain", "rich"] as const)(
  "does not split emoji surrogate pairs in %s assistant chunks",
  (mode) => {
    const text = `a${"😀".repeat(20_000)}`;
    const chunks = renderAssistantSegment(
      text,
      mode === "plain" ? "plain" : "rich-markdown",
    );

    for (const chunk of chunks) {
      const first = chunk.sourceText.charCodeAt(0);
      const last = chunk.sourceText.charCodeAt(chunk.sourceText.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    expect(chunks.map((chunk) => chunk.sourceText).join("")).toBe(text);
  },
);
```

Use the actual `AssistantSegmentDelivery` literals (`"plain"` and `"rich-markdown"`).

- [ ] **Step 6: Verify the surrogate test is RED**

Run:

```bash
npx vitest run test/bot/message-rendering.test.ts -t "does not split emoji surrogate pairs"
```

Expected: at least one case FAILS because the current binary search can choose a boundary between a high and low surrogate.

- [ ] **Step 7: Fit chunks only at code-point endpoints**

Add a private helper in `message-rendering.ts`:

```ts
function getCodePointEndIndexes(text: string): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    indexes.push(index);
  }
  return indexes;
}
```

Before slicing at `initialCut`, reduce a cut that falls between a high and low surrogate by one code unit. In `fitAssistantChunk()`, binary-search `getCodePointEndIndexes(candidate)` rather than raw code-unit positions, and slice at `endIndexes[middle]`. Keep `.length` size checks because TelePi intentionally applies a conservative UTF-16-unit limit.

- [ ] **Step 8: Verify Task 1**

Run:

```bash
npx vitest run test/bot/prompt-handler.test.ts test/bot/message-rendering.test.ts
npm run build
```

Expected: both suites and TypeScript build pass.

- [ ] **Step 9: Commit Task 1**

```bash
git add src/bot/prompt-handler.ts src/bot/message-rendering.ts test/bot/prompt-handler.test.ts test/bot/message-rendering.test.ts
git commit -m "fix: preserve stream order and unicode chunks"
```

---

### Task 2: Recover from invalid persisted sessions

**Files:**
- Modify: `src/pi-session.ts:1303-1490`
- Test: `test/pi-session.test.ts`

**Interfaces:**
- Consumes: `TopicSessionStore.get/delete`, `PiSessionService.create()`, Pi SDK's `Session file is not a valid pi session:` error, Node filesystem errors for non-regular saved paths.
- Produces: one retry with a fresh session only when a persisted saved path itself is invalid; unrelated startup/configuration errors still propagate.

- [ ] **Step 1: Add failing invalid-record recovery tests**

Add one table-driven registry test for a directory and a malformed non-empty JSONL. Configure the mocked `SessionManager.open` to throw the same errors as Pi SDK 0.83.0 for those paths, then assert:

```ts
it.each([
  ["directory", Object.assign(new Error("EISDIR: illegal operation on a directory"), { code: "EISDIR" })],
  ["malformed file", new Error("Session file is not a valid pi session: /tmp/bad.jsonl")],
])("replaces an invalid saved %s with a new session", async (_label, restoreError) => {
  const store = TopicSessionStore.memory();
  store.set("1::99", { sessionFile: savedPath, workspace: tempDir });
  mockState.SessionManager.open.mockImplementationOnce(() => { throw restoreError; });

  const registry = await PiSessionRegistry.create(createConfig(), store);
  const service = await registry.getOrCreate({ chatId: 1, messageThreadId: 99 });

  expect(service).toBe(registry.get({ chatId: 1, messageThreadId: 99 }));
  expect(mockState.SessionManager.create).toHaveBeenCalledWith("/workspace/base");
  expect(store.get("1::99")).toEqual({
    sessionFile: "/tmp/session-1.jsonl",
    workspace: "/workspace/base",
  });
});
```

Also add a control test where `PiSessionService.create()` fails with `new Error("provider unavailable")`; assert it rejects and does not delete the persisted record.

- [ ] **Step 2: Verify invalid-record tests are RED**

Run:

```bash
npx vitest run test/pi-session.test.ts -t "invalid saved|provider unavailable"
```

Expected: invalid saved records reject instead of creating a fresh session; the control already rejects.

- [ ] **Step 3: Classify only saved-path failures**

Add a private helper near the registry:

```ts
function isInvalidSavedSessionError(error: unknown, sessionFile: string): boolean {
  if (error instanceof Error && error.message.startsWith("Session file is not a valid pi session:")) {
    return true;
  }
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EISDIR" || code === "ENOTDIR" || code === "EACCES";
}
```

Retain `sessionFile` in the signature so the implementation can require the SDK error to name the restored path rather than accepting an unrelated invalid-session error.

- [ ] **Step 4: Retry once without the invalid mapping**

Extend `createServiceConfig()` to return the restored saved path when it selects persisted state. In `getOrCreate()`, catch only `isInvalidSavedSessionError(error, restoredSessionFile)`, delete that key best-effort, warn, and call `PiSessionService.create()` once with `piSessionPath: undefined` and the configured workspace. Keep the existing generation and in-flight logic around the final service promise; do not recurse through `getOrCreate()`.

- [ ] **Step 5: Verify Task 2**

Run:

```bash
npx vitest run test/pi-session.test.ts
npm run build
```

Expected: all Pi session tests and build pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/pi-session.ts test/pi-session.test.ts
git commit -m "fix: recover invalid persisted topic sessions"
```

---

### Task 3: Bind Abort callbacks to the active run

**Files:**
- Modify: `src/bot/prompt-handler.ts:68-225, 260-430, 540-710`
- Modify: `src/bot.ts:165-180, 655-670, 1005-1013`
- Test: `test/bot.test.ts`
- Test: `test/bot/prompt-handler.test.ts`

**Interfaces:**
- Consumes: callback query `message_id`, `getPiSessionContextKey()`, current prompt's `abortOwnerMessageId`.
- Produces: `setActiveAbortMessage(target, messageId | undefined)` notifications and callback validation against one active message per context.

- [ ] **Step 1: Add a failing stale-callback integration test**

Using the existing deferred-prompt setup in `test/bot.test.ts`:

1. Start run A and capture its Abort-owning `message_id`.
2. Resolve run A and wait for cleanup.
3. Start deferred run B in the same context and capture B's different Abort owner.
4. Deliver callback data `pi_abort` with A's old message ID.
5. Assert B's `service.abort` was not called and `answerCallbackQuery` receives `Abort control expired`.
6. Deliver B's callback and assert B aborts once.

- [ ] **Step 2: Verify the stale-callback test is RED**

Run:

```bash
npx vitest run test/bot.test.ts -t "stale Abort callback"
```

Expected: FAIL because A's old callback aborts run B.

- [ ] **Step 3: Publish current Abort ownership from the prompt flow**

Add to `CreatePromptHandlerOptions`:

```ts
setActiveAbortMessage?: (
  target: PiSessionContext,
  messageId: number | undefined,
) => void;
```

Inside `runPromptFlow()`, centralize owner assignment:

```ts
const setAbortOwner = (messageId: number | undefined): void => {
  abortOwnerMessageId = messageId;
  setActiveAbortMessage?.(target, messageId);
};
```

Replace direct assignments to `abortOwnerMessageId` with `setAbortOwner()`. Publish a new owner only after its keyboard attachment succeeds. Clear ownership during successful/failure cleanup and dialog-control handoff. Add focused harness assertions that initial ownership, migration, and final cleanup publish `[firstId, nextId, undefined]` in order.

- [ ] **Step 4: Reject callbacks that do not own the active run**

In `createBot()`, add:

```ts
const activeAbortMessages = new Map<ContextKey, number>();
const setActiveAbortMessage = (target: PiSessionContext, messageId: number | undefined): void => {
  const key = getContextKey(target);
  if (messageId === undefined) {
    activeAbortMessages.delete(key);
  } else {
    activeAbortMessages.set(key, messageId);
  }
};
```

Pass it to `createPromptHandler()`. In the `pi_abort` callback handler, recover `target` first, read `ctx.callbackQuery.message?.message_id`, and require exact equality with `activeAbortMessages.get(getContextKey(target))`. On mismatch or missing message, answer `Abort control expired` and return. On match, answer `Aborting...` and abort the existing session. Update the old generic callback test so a callback without a registered active message is expired rather than aborting.

- [ ] **Step 5: Verify Task 3**

Run:

```bash
npx vitest run test/bot.test.ts test/bot/prompt-handler.test.ts
npm run build
```

Expected: integration and prompt-flow tests plus build pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/bot.ts src/bot/prompt-handler.ts test/bot.test.ts test/bot/prompt-handler.test.ts
git commit -m "fix: expire stale Telegram abort controls"
```

---

### Task 4: Bound every extension dialog render

**Files:**
- Modify: `src/bot/extension-dialogs.ts:90-390`
- Test: `test/bot/extension-dialogs.test.ts`

**Interfaces:**
- Consumes: `renderDialogPanel()`, `TELEGRAM_MESSAGE_LIMIT`, `trimLine()`.
- Produces: preflight validation for select/confirm/input opening renders and a bounded terminal input render that always clears its keyboard.

- [ ] **Step 1: Add failing open-dialog bounds tests**

Extend the existing oversized-select test:

```ts
it.each([
  ["confirm", (manager: ExtensionDialogManager) => manager.openConfirm(target, "Confirm", "x".repeat(4_000))],
  ["input", (manager: ExtensionDialogManager) => manager.openInput(target, "Input", "x".repeat(4_000))],
] as const)("rejects oversized %s dialogs before transport", async (_kind, open) => {
  const { manager, sendTextMessage } = createManager();
  await expect(open(manager)).rejects.toThrow(/exceeds the 4000-character message limit/);
  expect(sendTextMessage).not.toHaveBeenCalled();
  expect(manager.hasPending(target)).toBe(false);
});
```

- [ ] **Step 2: Add a failing terminal-input bounds test**

Open an input dialog with a near-limit title that still fits, consume a near-limit user message, then inspect the final `editMessage` call:

```ts
expect(String(editMessage.mock.calls.at(-1)?.[2]).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
expect(String(editMessage.mock.calls.at(-1)?.[3]?.fallbackText).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
expect(editMessage.mock.calls.at(-1)?.[3]?.replyMarkup).toBeUndefined();
await expect(pendingInput).resolves.toBe(userText);
```

- [ ] **Step 3: Verify dialog tests are RED**

Run:

```bash
npx vitest run test/bot/extension-dialogs.test.ts -t "oversized|bounds"
```

Expected: confirm/input opening calls transport, and terminal input render exceeds the limit.

- [ ] **Step 4: Share opening-render validation**

Add:

```ts
const assertDialogWithinLimit = (
  kind: PendingExtensionDialog["kind"],
  rendered: { text: string; fallbackText: string },
): void => {
  if (rendered.text.length > TELEGRAM_MESSAGE_LIMIT
    || rendered.fallbackText.length > TELEGRAM_MESSAGE_LIMIT) {
    throw new Error(
      `Telegram ${kind} dialog exceeds the ${TELEGRAM_MESSAGE_LIMIT}-character message limit.`,
    );
  }
};
```

Call it before `sendTextMessage()` in `openSelect`, `openConfirm`, and `openInput`.

- [ ] **Step 5: Bound terminal input confirmation**

Render the existing `Received: ...` panel first. If it does not fit, replace it with:

```ts
renderDialogPanel(trimLine(pendingDialog.title, 256), ["Input received."], "✅")
```

Then call `finalizePending()` with the bounded render. Always resolve the extension promise with the complete original `userText`; truncation affects Telegram confirmation only.

- [ ] **Step 6: Verify Task 4**

Run:

```bash
npx vitest run test/bot/extension-dialogs.test.ts
npm run build
```

Expected: dialog tests and build pass.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/bot/extension-dialogs.ts test/bot/extension-dialogs.test.ts
git commit -m "fix: bound Telegram extension dialogs"
```

---

### Task 5: Raise secure test-tool dependency floors

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: npm's semver-compatible Vitest 3.2 line and transitive lock resolution.
- Produces: `vitest` and `@vitest/coverage-v8` floors at `^3.2.7`, with compatible patched Vite/PostCSS/Picomatch/esbuild/brace-expansion resolutions where npm permits.

- [ ] **Step 1: Record the current audit failure**

Run:

```bash
npm audit --json > /tmp/telepi-audit-before.json || true
node -e 'const a=require("/tmp/telepi-audit-before.json"); console.log(a.metadata.vulnerabilities)'
```

Expected: `{ low: 1, high: 4, critical: 2, total: 7 }` (plus zero-valued severities).

- [ ] **Step 2: Raise direct secure floors and refresh compatible locks**

Run:

```bash
npm install --save-dev vitest@^3.2.7 @vitest/coverage-v8@^3.2.7
npm audit fix --package-lock-only
```

Do not use `--force`. Inspect `git diff -- package.json package-lock.json` and keep only semver-compatible patched resolutions.

- [ ] **Step 3: Verify dependency remediation**

Run:

```bash
npm audit --json > /tmp/telepi-audit-after.json || true
npm audit --omit=dev --json > /tmp/telepi-audit-prod.json || true
node -e 'for (const p of ["/tmp/telepi-audit-after.json","/tmp/telepi-audit-prod.json"]) { const a=require(p); console.log(p, a.metadata.vulnerabilities); }'
npm ls vitest @vitest/coverage-v8 vite postcss picomatch esbuild brace-expansion --all
```

Expected: dev/test advisories are removed. One production high advisory may remain only under `@earendil-works/pi-coding-agent@0.83.0 -> minimatch@10.2.5 -> brace-expansion@5.0.7`, because Pi's published npm shrinkwrap pins it and no newer Pi SDK package is available.

- [ ] **Step 4: Verify Task 5**

Run:

```bash
npm test
npm run test:coverage
npm run build
```

Expected: all tests, coverage thresholds, and build pass.

- [ ] **Step 5: Commit Task 5 and the audit plan**

```bash
git add package.json package-lock.json docs/superpowers/plans/2026-08-02-recent-bug-audit.md
git commit -m "chore: update audited test dependencies"
```

---

## Final Verification

- [ ] Run `npm test` and confirm 0 failures.
- [ ] Run `npm run test:coverage` and confirm thresholds pass.
- [ ] Run `npm run build` and confirm TypeScript exits 0.
- [ ] Run `git diff --check origin/main...HEAD` and confirm no whitespace errors.
- [ ] Run `npm audit --omit=dev` and record the one unavoidable Pi-shrinkwrap advisory if it remains.
- [ ] Request an independent whole-branch code review before local integration.
