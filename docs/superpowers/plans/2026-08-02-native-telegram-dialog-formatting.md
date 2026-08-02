# Native Telegram Dialog Formatting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace TelePi's code-styled, box-drawn extension dialogs with readable native Telegram HTML.

**Architecture:** Keep the existing `renderDialogPanel(title, bodyLines, titleIcon)` interface and replace only its terminal-panel implementation. The shared renderer will format the first title line as a bold heading, retain multiline context and body sections as escaped prose, and produce an equivalent undecorated plain-text fallback; extension dialog lifecycle and keyboards remain unchanged.

**Tech Stack:** TypeScript, grammY Telegram HTML messages, Vitest

## Global Constraints

- Apply native formatting to every extension dialog, not only `ask_user`.
- Preserve inline keyboards, callback payloads, timeout behavior, and the 4,000-character dialog guard.
- Escape all title and body content before inserting it into Telegram HTML.
- Keep the current `renderDialogPanel(title: string, bodyLines: string[], titleIcon?: string): RenderedText` contract.
- Do not add runtime dependencies or alter Pi's native TUI.
- Do not use `<pre>`, `<code>`, Markdown, or box-drawing characters in extension dialogs.

---

### Task 1: Replace the terminal panel with native Telegram HTML

**Files:**
- Modify: `src/bot/message-rendering.ts:382-393,838-904`
- Test: `test/bot/message-rendering.test.ts:93-104`

**Interfaces:**
- Consumes: `renderDialogPanel(title: string, bodyLines: string[], titleIcon?: string)` and the existing `escapeHTML(text: string)` helper.
- Produces: the unchanged `RenderedText` shape `{ text: string; fallbackText: string; parseMode: "HTML" }`, with native HTML and undecorated plain text.

- [x] **Step 1: Replace the box-rendering assertion with a failing native-format regression**

Replace the current `dialogPanel` assertions in `test/bot/message-rendering.test.ts` with an exact multiline test:

```ts
const dialogPanel = renderDialogPanel(
  "Choose deployment <mode>\n\nContext:\nProduction traffic is live.",
  ["1. Stop — safest", "2. Continue <fast>", "Use the buttons below."],
  "🧭",
);
expect(dialogPanel).toEqual({
  text: [
    "<b>🧭 Choose deployment &lt;mode&gt;</b>",
    "",
    "Context:\nProduction traffic is live.",
    "",
    "1. Stop — safest\n2. Continue &lt;fast&gt;\nUse the buttons below.",
  ].join("\n"),
  fallbackText: [
    "🧭 Choose deployment <mode>",
    "",
    "Context:\nProduction traffic is live.",
    "",
    "1. Stop — safest\n2. Continue <fast>\nUse the buttons below.",
  ].join("\n"),
  parseMode: "HTML",
});
expect(dialogPanel.text).not.toMatch(/<pre>|<code>/);
expect(dialogPanel.fallbackText).not.toMatch(/[┌┐└┘├┤│─]/u);
```

- [x] **Step 2: Run the focused test and verify the old renderer fails**

Run:

```bash
npx vitest run test/bot/message-rendering.test.ts
```

Expected: the exact `dialogPanel` assertion fails because the current output starts with `<pre>┌...` and its fallback contains box-drawing characters.

- [x] **Step 3: Implement the minimal native renderer**

Delete `DIALOG_PANEL_MIN_WIDTH`, `DIALOG_PANEL_MAX_WIDTH`, `buildDialogPanelText()`, `frameDialogPanelLine()`, and `wrapDialogPanelLine()`. Add these focused helpers near `renderDialogPanel()`:

```ts
function normalizeDialogLines(lines: string[]): string[] {
  const normalized = lines
    .flatMap((line) => line.replace(/\r\n?/g, "\n").split("\n"))
    .map((line) => line.trim());

  while (normalized[0] === "") normalized.shift();
  while (normalized.at(-1) === "") normalized.pop();
  return normalized;
}

function renderDialogSection(lines: string[], html: boolean): string {
  return lines.map((line) => html ? escapeHTML(line) : line).join("\n");
}
```

Replace `renderDialogPanel()` with:

```ts
export function renderDialogPanel(title: string, bodyLines: string[], titleIcon?: string): RenderedText {
  const titleLines = normalizeDialogLines([title]);
  const headingText = [titleIcon, titleLines.shift() ?? ""].filter(Boolean).join(" ");
  const remainingTitleLines = normalizeDialogLines(titleLines);
  const normalizedBodyLines = normalizeDialogLines(bodyLines);

  const htmlSections = [
    `<b>${escapeHTML(headingText)}</b>`,
    remainingTitleLines.length > 0 ? renderDialogSection(remainingTitleLines, true) : undefined,
    normalizedBodyLines.length > 0 ? renderDialogSection(normalizedBodyLines, true) : undefined,
  ].filter((section): section is string => section !== undefined);
  const plainSections = [
    headingText,
    remainingTitleLines.length > 0 ? renderDialogSection(remainingTitleLines, false) : undefined,
    normalizedBodyLines.length > 0 ? renderDialogSection(normalizedBodyLines, false) : undefined,
  ].filter((section): section is string => section !== undefined);

  return {
    text: htmlSections.join("\n\n"),
    fallbackText: plainSections.join("\n\n"),
    parseMode: "HTML",
  };
}
```

This retains internal blank lines, removes leading and trailing blank lines, escapes each HTML line, and groups the heading, title remainder, and caller body into readable sections.

- [x] **Step 4: Run the focused renderer test and verify it passes**

Run:

```bash
npx vitest run test/bot/message-rendering.test.ts
```

Expected: all tests in `test/bot/message-rendering.test.ts` pass.

- [x] **Step 5: Commit the renderer and regression test**

```bash
git add src/bot/message-rendering.ts test/bot/message-rendering.test.ts
git commit -m "fix: render Telegram dialogs as native text"
```

---

### Task 2: Verify extension-dialog integration and package health

**Files:**
- Verify: `src/bot/extension-dialogs.ts`
- Verify: `test/bot/extension-dialogs.test.ts`
- Verify: `test/bot/telegram-transport.test.ts`

**Interfaces:**
- Consumes: the revised `renderDialogPanel()` output through existing select, confirm, input, timeout, cancellation, and completion paths.
- Produces: evidence that native rendering preserves extension-dialog behavior, Telegram HTML fallback, and TypeScript compatibility.

- [x] **Step 1: Run focused integration tests**

Run:

```bash
npx vitest run test/bot/extension-dialogs.test.ts test/bot/telegram-transport.test.ts
```

Expected: all tests pass without changes to callback routing, timeout handling, message editing, or transport fallback.

- [x] **Step 2: Run the complete test suite**

Run:

```bash
npm test
```

Expected: Vitest reports zero failed tests.

- [x] **Step 3: Run the TypeScript build**

Run:

```bash
npm run build
```

Expected: `tsc` exits successfully with no diagnostics.

- [x] **Step 4: Check the final diff**

Run:

```bash
git status --short
git diff --check
git diff HEAD^ -- src/bot/message-rendering.ts test/bot/message-rendering.test.ts
```

Expected: only the intended plan file is uncommitted, `git diff --check` prints nothing, and the source diff contains no dialog callback or lifecycle changes.

- [x] **Step 5: Commit the implementation plan progress**

Mark completed checkboxes in this plan, then commit it separately:

```bash
git add docs/superpowers/plans/2026-08-02-native-telegram-dialog-formatting.md
git commit -m "docs: record native dialog implementation"
```
