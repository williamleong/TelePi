# Telegram Activity Block Spacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render one empty line between every adjacent Telegram activity block.

**Architecture:** Change the pure activity renderer's block separator from one newline to two. Keep trailing-thinking normalization and all block-internal markup unchanged, and prove exact output plus chunk-limit behavior with focused tests.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- Adjacent activity blocks use exactly `\n\n` in HTML and fallback output.
- Provider trailing whitespace must not create additional blank lines.
- Thinking headings remain plain; tool headings/code formatting remain unchanged.
- Telegram chunk accounting includes the separator and produces no leading/trailing blank lines.
- Do not change delivery, typing, Abort, steering, labels, or assistant rendering.

---

### Task 1: Render and document activity block spacing

**Files:**
- Modify: `src/bot/activity-rendering.ts`
- Modify: `test/bot/activity-rendering.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes and preserves: `renderActivityTranscript(transcript): RenderedChunk[]`.
- Produces: exact two-newline separators between adjacent blocks within a chunk.

- [ ] **Step 1: Write exact failing tests**

Update the thinking-to-tool exact-output test to expect:

```ts
expect(chunk.text).toBe(
  "🧠 Thinking\nInspecting state\n\n<b>• ⌨️ Bash</b>\n<code>npm test</code>",
);
```

Add a tool-to-tool test that expects exactly `\n\n` between the first tool's detail and the second tool's heading in both `text` and `fallbackText`. Include thinking input ending in `\n\n` and assert it does not produce three or more newline characters at the boundary.

Add a near-limit regression where the second block moves to a new chunk because the two-character separator no longer fits. Assert neither chunk starts nor ends with `\n`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- test/bot/activity-rendering.test.ts
```

Expected: exact spacing tests fail because the renderer currently uses one newline.

- [ ] **Step 3: Implement the separator**

In `renderActivityTranscript()` change only:

```ts
const separator = current ? "\n\n" : "";
```

Retain the existing normalize-once thinking behavior and `fits(next)` check.

- [ ] **Step 4: Update the README example**

Make the current activity example show an empty line between thinking and tool blocks. Do not change steering, typing, or status documentation.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
npm test -- test/bot/activity-rendering.test.ts test/bot/stream-segments.test.ts test/bot/prompt-handler.test.ts
npm test
npm run build
npm run test:coverage
git diff --check
```

Expected: all tests and build pass, coverage remains above repository thresholds, and no whitespace errors appear.

- [ ] **Step 6: Commit**

```bash
git add src/bot/activity-rendering.ts test/bot/activity-rendering.test.ts README.md
git commit -m "fix: separate Telegram activity blocks"
```
