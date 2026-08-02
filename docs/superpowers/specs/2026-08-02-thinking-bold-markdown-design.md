# Thinking Bold Markdown Design

**Date:** 2026-08-02

## Goal

Render provider-emitted whole-line Markdown bold markers in Telegram thinking activity instead of displaying literal `**` characters.

## Rendering rule

The `🧠 Thinking` heading remains plain. For each thinking-text line, TelePi recognizes bold only when the line's non-whitespace content is fully wrapped by one balanced `**…**` pair.

Input:

```text
**Inspecting the code**
Checking the tests
```

Telegram HTML:

```html
🧠 Thinking
<b>Inspecting the code</b>
Checking the tests
```

Plain fallback:

```text
🧠 Thinking
Inspecting the code
Checking the tests
```

Leading and trailing whitespace outside the markers is preserved. HTML inside the emphasized text is escaped before the `<b>` wrapper is added.

## Non-goals and safety

TelePi will not implement a general Markdown parser for thinking activity.

- Inline emphasis such as `Review **this** value` remains literal.
- Unbalanced markers such as `**unfinished` remain literal.
- Multiple emphasis runs on one line remain literal unless one outer pair wraps the complete non-whitespace line.
- Single-star emphasis remains unchanged.
- Code, tool details, assistant rendering, and the plain Thinking heading remain unchanged.

This narrow rule avoids corrupting literal asterisks and prevents provider text from injecting Telegram HTML.

## Chunking

Thinking text is parsed into display characters with bold metadata before Telegram-size splitting. Chunk fitting renders each candidate range with escaped text and balanced `<b>…</b>` tags. A long emphasized line may span continuation chunks; every chunk remains valid HTML and retains bold display without exposing `**` markers.

The fallback/source text contains the displayed content without recognized outer markers. Existing trailing-whitespace normalization, empty-line handling, activity-block spacing, and Telegram size limits remain intact.

## Scope

Change only the activity renderer, focused tests, and the current README activity example if useful. Do not add dependencies or alter chronological delivery, steering, typing, Abort behavior, tool rendering, or assistant Markdown handling.

## Acceptance criteria

1. A complete `**…**` thinking line renders as escaped Telegram HTML bold with markers removed from fallback text.
2. The Thinking heading remains plain.
3. Inline, unbalanced, single-star, and ambiguous multi-run Markdown remains literal and escaped.
4. Leading/trailing outside-marker whitespace is preserved except existing end-of-entry trimming.
5. Long bold lines split into valid, size-bounded continuation chunks with no literal markers.
6. Existing empty-line, block-spacing, and content-preservation tests continue to pass.
