# Ask User Custom UI Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow dialog-based extensions such as `pi-ask-user` to fall back from unsupported rich custom UI to TelePi's Telegram `select()` and `input()` dialogs.

**Architecture:** Keep TelePi's existing Telegram dialog adapter unchanged except for the unsupported `custom()` contract. Match Pi RPC's degraded-UI behavior by resolving `undefined`, which signals extensions to use supported dialog methods.

**Tech Stack:** TypeScript, Pi SDK 0.83, Vitest

## Global Constraints

- Do not modify `pi-ask-user`.
- Do not add dependencies.
- Preserve existing behavior for `select`, `confirm`, `input`, and all no-op UI methods.
- Keep the production change limited to `createTelegramUIContext().custom()`.

---

### Task 1: Degrade unsupported custom UI to dialogs

**Files:**
- Modify: `src/telegram-ui-context.ts:98-100`
- Test: `test/telegram-ui-context.test.ts`

**Interfaces:**
- Consumes: Pi's `ExtensionUIContext.custom()` contract, where degraded remote UIs may resolve `undefined`.
- Produces: A TelePi UI context whose `custom()` promise resolves `undefined`, allowing extension fallback logic to call `select()` or `input()`.

- [ ] **Step 1: Write the failing regression test**

Add this test to `test/telegram-ui-context.test.ts`:

```ts
it("degrades unsupported custom UI to dialog fallbacks", async () => {
  const ui = createTelegramUIContext({ notify: vi.fn() });

  await expect(ui.custom(vi.fn()))
    .resolves.toBeUndefined();
});
```

The test exercises the real adapter and proves the custom component factory is not needed in Telegram mode.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- test/telegram-ui-context.test.ts
```

Expected: the new test fails because `custom()` rejects with `TelePi does not yet support extension UI method 'custom'.`

- [ ] **Step 3: Implement the minimal compatibility change**

Change `custom()` in `src/telegram-ui-context.ts` to resolve without invoking the supplied factory:

```ts
async custom() {
  return undefined;
},
```

- [ ] **Step 4: Verify GREEN and regression safety**

Run:

```bash
npm test -- test/telegram-ui-context.test.ts
npm run build
npm test
```

Expected: the focused test, TypeScript build, and all tests pass.

- [ ] **Step 5: Commit the implementation**

```bash
git add src/telegram-ui-context.ts test/telegram-ui-context.test.ts docs/superpowers/plans/2026-08-02-ask-user-custom-fallback.md
git commit -m "fix: support ask-user dialog fallback"
```
