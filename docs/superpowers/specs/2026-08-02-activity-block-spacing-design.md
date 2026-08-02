# Telegram Activity Block Spacing Design

**Date:** 2026-08-02

## Goal

Improve Telegram activity scanability by placing one empty line between adjacent thinking and tool blocks.

## Rendering rule

Every pair of adjacent activity blocks uses `\n\n` as its separator. This applies consistently to:

- thinking followed by a tool;
- tool followed by another tool;
- tool followed by thinking;
- separate thinking blocks that remain in the same Telegram chunk.

A block's internal layout remains unchanged:

```text
🧠 Thinking
Inspecting the code…

✓ ⌨️ Bash
npm test

✓ 🔍 Read
src/bot.ts
```

The thinking heading remains plain text. Tool headings retain their current bold HTML markup, and tool details retain code formatting. Provider trailing whitespace remains trimmed so the renderer produces exactly one empty line rather than accumulating provider-supplied blank lines.

## Chunking

Telegram size checks include the two-character separator. If adding the next block would exceed the message limit, the renderer starts a new chunk and does not add leading or trailing blank lines to either chunk.

## Scope

Change only the activity renderer, its focused tests, and current README example if needed. Do not alter chronological segment boundaries, Telegram message delivery, typing, Abort behavior, steering, tool labels, or assistant formatting.

## Acceptance criteria

1. Adjacent activity blocks in one chunk contain exactly `\n\n` between blocks.
2. Thinking text with trailing newlines still produces exactly one empty line before the next block.
3. Thinking and tool internal formatting remains unchanged.
4. Chunk limits and rollover behavior remain valid.
5. Focused tests assert exact HTML and fallback output for thinking-to-tool and tool-to-tool transitions.
