# Thinking Bold Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert whole-line `**…**` markers in provider thinking text into safe Telegram HTML bold.

**Architecture:** Parse normalized thinking text into display characters carrying a `bold` flag. Render candidate character ranges by escaping text and wrapping contiguous bold runs in balanced `<b>` tags, so existing binary-search chunking remains size-aware and never slices HTML tags.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- Only one balanced outer `**…**` pair wrapping a line's full non-whitespace content is recognized.
- The `🧠 Thinking` heading remains plain.
- Recognized marker content is HTML-escaped and bold; fallback/source text removes the markers.
- Inline, unbalanced, single-star, and ambiguous multi-run Markdown remains literal.
- Long bold lines retain valid bold formatting across Telegram continuation chunks.
- Preserve activity spacing, trailing-entry normalization, tool rendering, delivery, steering, typing, and Abort behavior.
- Add no dependency or general Markdown parser.

---

### Task 1: Parse and render whole-line thinking bold

**Files:**
- Modify: `src/bot/activity-rendering.ts`
- Modify: `test/bot/activity-rendering.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes and preserves: `renderActivityTranscript(transcript): RenderedChunk[]`.
- Produces internally: parsed thinking characters shaped as `{ value: string; bold: boolean }` and size-safe range rendering.

- [ ] **Step 1: Add failing exact rendering tests**

Add a focused test:

```ts
transcript.appendThinking({
  text: "**Inspect <state>**\nChecking **inline** text\n**unfinished",
});

expect(renderActivityTranscript(transcript)[0]).toMatchObject({
  text: "🧠 Thinking\n<b>Inspect &lt;state&gt;</b>\nChecking **inline** text\n**unfinished",
  fallbackText: "🧠 Thinking\nInspect <state>\nChecking **inline** text\n**unfinished",
});
```

Add cases for:

- whitespace outside markers: `  **Bold line**  `;
- single stars and `**first** and **second**` remaining literal;
- empty `****` remaining literal;
- multiple lines with mixed bold/plain content;
- bold content containing HTML metacharacters.

- [ ] **Step 2: Add a failing long-line chunk test**

Render `**${"x".repeat(9_000)}**` and assert:

```ts
expect(chunks.length).toBeGreaterThan(1);
for (const chunk of chunks) {
  expect(chunk.text.length).toBeLessThanOrEqual(4_000);
  expect(chunk.text).not.toContain("**");
  expect(count(chunk.text, "<b>")).toBe(count(chunk.text, "</b>"));
}
expect(chunks.map((chunk) => stripHeadingAndTags(chunk.fallbackText)).join(""))
  .toBe("x".repeat(9_000));
```

Keep the existing continuation-heading and whitespace-boundary reconstruction coverage.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
npm test -- test/bot/activity-rendering.test.ts
```

Expected: markers remain literal and the bold assertions fail.

- [ ] **Step 4: Parse normalized lines into styled characters**

Add a private type:

```ts
type ThinkingCharacter = {
  value: string;
  bold: boolean;
};
```

Implement a line parser that preserves newline characters and outside whitespace. A recognized line must match one outer pair around non-empty content after separating leading/trailing whitespace. It should produce leading/plain characters, inner/bold characters without markers, and trailing/plain characters. All other lines produce plain characters verbatim.

Parse only after the existing `text.trimEnd()` normalization in `appendThinking()`.

- [ ] **Step 5: Render styled ranges safely**

Change thinking-prefix fitting and block rendering to consume `ThinkingCharacter[]` ranges instead of raw string fragments. Build fallback with `value` concatenation. Build HTML by grouping adjacent characters with the same `bold` value:

```ts
const html = runs.map((run) => {
  const escaped = escapeHTML(run.text);
  return run.bold ? `<b>${escaped}</b>` : escaped;
}).join("");
```

`renderThinkingBlock()` still prepends the plain heading and newline. Candidate `fits()` checks include generated tags. Every fragment independently opens and closes bold tags.

For empty normalized thinking, retain the heading-only block behavior.

- [ ] **Step 6: Run focused and related tests**

Run:

```bash
npm test -- test/bot/activity-rendering.test.ts test/bot/stream-segments.test.ts test/bot/prompt-handler.test.ts
npm run build
```

Expected: all focused tests pass and every chunk stays within Telegram limits.

- [ ] **Step 7: Update README example**

Show one bold provider line under the plain Thinking heading and explain that complete `**…**` lines render as bold while inline Markdown remains literal. Preserve the one-empty-line activity-block example.

- [ ] **Step 8: Run full verification**

Run:

```bash
npm test
npm run build
npm run test:coverage
git diff --check
```

Expected: all tests and build pass, coverage remains above repository thresholds, and no whitespace errors appear.

- [ ] **Step 9: Commit**

```bash
git add src/bot/activity-rendering.ts test/bot/activity-rendering.test.ts README.md
git commit -m "fix: render bold thinking Markdown"
```
