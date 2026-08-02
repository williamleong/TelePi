# Telegram `ask_user` Dialog UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telegram `ask_user` prompts persistent, faithful to structured option details, and complete in one tap unless the user chooses a custom response.

**Architecture:** Change `pi-ask-user`'s generic dialog fallback to pass descriptive display labels while mapping selections back to stable option titles, and remove its automatic comment input after structured selections. Change TelePi's dialog manager to render all option labels and create timers only for explicit positive finite timeouts.

**Tech Stack:** TypeScript, Bun tests in `pi-ask-user`, Vitest and grammY in TelePi.

## Global Constraints

- Native `ask_user` TUI behavior remains unchanged.
- Telegram callback payloads retain the indexed `ui_sel_<dialogId>_<index>` format.
- Omitted, zero, negative, and non-finite timeout values create no timer.
- Explicit positive finite timeouts retain current timeout behavior.
- No new runtime dependencies.

---

### Task 1: Make dialog fallback selections descriptive and single-step

**Files:**
- Modify: `/home/tsllwl/pi_ws/.worktrees/pi-ask-user-telepi-ux/index.ts:1983-2043`
- Test: `/home/tsllwl/pi_ws/.worktrees/pi-ask-user-telepi-ux/index.test.ts` dialog fallback suite

**Interfaces:**
- Consumes: `QuestionOption { title: string; description?: string }`, `ui.select(title, labels, options)`, and `ui.input(...)`.
- Produces: structured responses containing original option titles and freeform responses from `✏️ Type custom response...`.

- [ ] **Step 1: Replace the optional-comment regression with failing dialog tests**

Add tests that capture the `select()` labels and `input()` call count:

```ts
expect(selectOptions).toEqual([
   "Red — Stop deployment",
   "Blue — Continue deployment",
   "✏️ Type custom response...",
]);
expect(result.details.response).toEqual({ kind: "selection", selections: ["Blue"] });
expect(inputCalls).toBe(0);
```

Add a separate custom-response test whose `select()` returns `✏️ Type custom response...`, whose `input()` returns `Blue — use the canary first`, and whose expected response is:

```ts
{ kind: "freeform", text: "Blue — use the canary first" }
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
cd /home/tsllwl/pi_ws/.worktrees/pi-ask-user-telepi-ux
npx --yes bun test index.test.ts
```

Expected: the description-label assertion fails and the existing fallback invokes `input()` after a structured selection.

- [ ] **Step 3: Add label mapping and remove automatic comment input**

Add a small formatter next to `formatOptionsForMessage`:

```ts
function formatDialogOption(option: QuestionOption): string {
   return option.description ? `${option.title} — ${option.description}` : option.title;
}
```

In the single-select branch, build a `Map<string, string>` from display label to original title, append `FREEFORM_SENTINEL` only when `allowFreeform` is true, keep the existing custom-response input branch, and return `createSelectionResponse([mappedTitle])` immediately for a structured selection. Do not call `buildCommentPrompt()` in the single-select fallback.

- [ ] **Step 4: Run the package tests and packaging check**

Run:

```bash
cd /home/tsllwl/pi_ws/.worktrees/pi-ask-user-telepi-ux
npx --yes bun test
npm run check
```

Expected: all Bun tests pass and the dry-run package check succeeds.

- [ ] **Step 5: Commit the fallback change**

```bash
cd /home/tsllwl/pi_ws/.worktrees/pi-ask-user-telepi-ux
git add index.ts index.test.ts
git commit -m "fix: streamline dialog fallback selections"
```

---

### Task 2: Keep TelePi dialogs pending and render their option details

**Files:**
- Modify: `src/bot/extension-dialogs.ts:86-175,215-260`
- Modify: `src/bot.ts:70-80,347-353`
- Test: `test/bot/extension-dialogs.test.ts`
- Test: `test/bot.test.ts`

**Interfaces:**
- Consumes: `openSelect(target, title, options, dialogOptions?)` and other extension-dialog methods.
- Produces: no implicit timers; explicit positive finite timeout handling; select panels containing full option labels.

- [x] **Step 1: Write failing persistence and rendering tests**

Update the test manager to remove `defaultTimeoutMs`. Add a fake-timer test:

```ts
vi.useFakeTimers();
const pending = manager.openSelect(target, "Pick one", ["Alpha", "Beta"]);
await Promise.resolve();
await vi.advanceTimersByTimeAsync(60_000);
expect(manager.hasPending(target)).toBe(true);
expect(editMessage).not.toHaveBeenCalled();
await manager.cancelPending(target);
await expect(pending).resolves.toBeUndefined();
vi.useRealTimers();
```

Change the open-select expectation so the rendered body contains numbered full labels, including a title and description separated by an em dash. Keep the existing explicit `{ timeout: 5 }` regression.

- [x] **Step 2: Run focused tests and verify failure**

Run:

```bash
cd /home/tsllwl/pi_ws/TelePi/.worktrees/telepi-ask-user-ux
npx vitest run test/bot/extension-dialogs.test.ts test/bot.test.ts
```

Expected: the no-timeout test observes finalization at the old default, and the select-panel expectation lacks option labels.

- [x] **Step 3: Remove the implicit timeout and list options**

Remove `EXTENSION_UI_TIMEOUT_MS` and `defaultTimeoutMs`. In `createDialogTimeout`, return `undefined` unless `timeoutMs` is finite and greater than zero:

```ts
if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  return undefined;
}
```

Use `timeoutMs` directly in `setTimeout`. Build the select panel lines from all supplied options:

```ts
const optionLines = options.map((option, index) => `${index + 1}. ${option}`);
const rendered = renderDialogPanel(title, [...optionLines, "Use the buttons below."], "🧭");
```

Keep `trimLine(option, 44)` for Telegram button labels and preserve the indexed callback values.

- [x] **Step 4: Run focused and complete verification**

Run:

```bash
cd /home/tsllwl/pi_ws/TelePi/.worktrees/telepi-ask-user-ux
npx vitest run test/bot/extension-dialogs.test.ts test/bot.test.ts
npm test
npm run build
```

Expected: 0 failures and a successful TypeScript build.

- [x] **Step 5: Commit the TelePi implementation**

```bash
cd /home/tsllwl/pi_ws/TelePi/.worktrees/telepi-ask-user-ux
git add src/bot.ts src/bot/extension-dialogs.ts test/bot/extension-dialogs.test.ts test/bot.test.ts docs/superpowers/plans/2026-08-02-telegram-ask-user-dialog-ux.md
git commit -m "fix: improve Telegram ask-user dialogs"
```

---

### Task 3: Cross-repository verification and integration

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: `pi-ask-user` dialog labels and TelePi's `ExtensionUIContext.select()` implementation.
- Produces: evidence that the combined interaction lists descriptions, waits indefinitely by default, completes structured choices in one tap, and routes custom responses through text input.

- [ ] **Step 1: Run both complete suites from clean worktrees**

```bash
cd /home/tsllwl/pi_ws/.worktrees/pi-ask-user-telepi-ux && npx --yes bun test && npm run check
cd /home/tsllwl/pi_ws/TelePi/.worktrees/telepi-ask-user-ux && npm test && npm run build
```

Expected: every command succeeds.

- [ ] **Step 2: Inspect both diffs**

```bash
cd /home/tsllwl/pi_ws/.worktrees/pi-ask-user-telepi-ux && git status --short && git diff main...HEAD --check
cd /home/tsllwl/pi_ws/TelePi/.worktrees/telepi-ask-user-ux && git status --short && git diff main...HEAD --check
```

Expected: clean worktrees and no whitespace errors.

- [ ] **Step 3: Request code review and address only verified findings**

Review the two branch diffs for behavioral regressions, timeout leaks, duplicate labels, and response-shape changes. Re-run the relevant focused test after each correction.

- [ ] **Step 4: Finish both branches**

Merge each task branch into its repository's confirmed `main` branch with `--no-ff`, rerun complete tests on each merged `main`, then remove both worktrees while retaining the feature branches.
