# Upstream Fork Note Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the README's opening fork note with the approved Pi-philosophy sentence and current upstream-difference summary.

**Architecture:** This is a documentation-only replacement at the top of `README.md`. Preserve the callout structure and all content after the note.

**Tech Stack:** Markdown

## Global Constraints

- Use the exact approved copy from `docs/superpowers/specs/2026-08-02-upstream-fork-note-design.md`.
- Keep the upstream repository link unchanged.
- Do not modify source code, tests, package metadata, or other README sections.
- Preserve valid Markdown callout formatting and readable line lengths.

---

### Task 1: Replace the upstream fork note

**Files:**
- Modify: `README.md:1-15`
- Reference: `docs/superpowers/specs/2026-08-02-upstream-fork-note-design.md`

**Interfaces:**
- Consumes: the approved replacement copy in the design spec.
- Produces: an accurate opening note for README readers.

- [ ] **Step 1: Replace the current callout**

Replace the existing `[!NOTE]` block with the exact Markdown block under the design spec's `## Copy` heading. Do not alter the following product tagline.

- [ ] **Step 2: Verify the rendered source structure**

Run:

```bash
node - <<'NODE'
const fs = require("node:fs");
const text = fs.readFileSync("README.md", "utf8");
const required = [
  "developed\n> in Pi’s spirit: adapt the tool to your workflow, not your workflow to the tool.",
  "Compared with upstream TelePi, this fork:",
  "persists\n>   their mappings across restarts",
  "run-scoped Abort",
  "`ask_user` custom-UI fallbacks",
  "Unicode chunking",
];
for (const phrase of required) {
  if (!text.includes(phrase)) throw new Error(`Missing approved copy: ${phrase}`);
}
if (!text.includes("**Run your Pi coding agent from Telegram")) {
  throw new Error("Product tagline was removed");
}
console.log("README fork note verified");
NODE

git diff --check
```

Expected: `README fork note verified` and no whitespace errors.

- [ ] **Step 3: Run repository verification**

Run:

```bash
npm test
npm run build
```

Expected: all tests pass and TypeScript exits 0.

- [ ] **Step 4: Commit the README update**

```bash
git add README.md
git commit -m "docs: refresh upstream fork note"
```
