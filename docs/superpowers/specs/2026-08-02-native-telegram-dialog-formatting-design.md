# Native Telegram Dialog Formatting Design

## Problem

TelePi renders extension dialogs as fixed-width terminal panels. `renderDialogPanel()` builds a box from Unicode line-drawing characters and wraps it in an HTML `<pre>` element. Telegram therefore displays `ask_user` questions, option descriptions, confirmation prompts, input prompts, and final states as code inside an ASCII-style frame.

This presentation suits a terminal but not Telegram. It makes questions harder to scan, wastes horizontal space on mobile screens, and gives ordinary prose the visual weight of source code.

## Approved Behavior

TelePi will render every extension dialog with native Telegram HTML rather than a terminal panel:

1. The dialog title appears as a bold heading prefixed by its existing state icon.
2. Question and context text appear as normal readable prose, not code.
3. Select options remain numbered in the message body so descriptions stay visible when Telegram trims button labels.
4. Inline keyboards, callback payloads, and dialog behavior remain unchanged.
5. Completed, cancelled, aborted, and expired dialogs use concise native status messages.
6. Plain-text fallback contains the same information without box-drawing characters.
7. User-provided content remains HTML-escaped.

## Architecture

The change stays within TelePi's shared dialog-rendering boundary.

### Dialog renderer

Replace the terminal-oriented implementation of `renderDialogPanel()` in `src/bot/message-rendering.ts` with a native Telegram renderer. The function retains its current signature and `RenderedText` return type so callers do not change.

The renderer treats the supplied title as multiline content because `pi-ask-user` currently combines its question and optional context into the `ui.select()` title. It will:

- normalize line endings;
- use the first non-empty line as the bold heading;
- preserve the remaining title lines, including deliberate internal blank lines, as escaped body text;
- append the caller-provided body lines below the title content;
- separate title content from caller-provided body lines with one blank line;
- produce equivalent plain text without HTML or decorative borders.

The renderer must not parse `ask_user`-specific labels such as `Context:` or split option descriptions on an em dash. Such parsing would couple TelePi to one extension's copy and would fail for generic extension dialogs. Native formatting should improve the shared UI without changing extension contracts.

### Extension dialog manager

`src/bot/extension-dialogs.ts` continues to provide dialog content and keyboards. Existing icons, numbered option lines, button trimming, timeout handling, cancellation, and message editing remain intact.

Final states continue to edit the original Telegram message and remove its keyboard. They inherit the new native rendering through the shared renderer.

## Rendering Rules

For a pending select dialog, the HTML shape is:

```html
<b>🧭 Question text</b>

Context:
Decision-critical context.

1. First option — Description
2. Second option — Description
Use the buttons below.
```

The plain-text fallback contains the same lines without tags.

A completed dialog uses the same heading and a short result body, for example:

```html
<b>✅ Question text</b>

Selected: First option
```

The implementation will escape the title and every body line before inserting them into Telegram HTML. It will preserve deliberate blank lines but collapse redundant leading and trailing whitespace. It will not use `<pre>`, `<code>`, box-drawing characters, Markdown, or new Telegram-specific dependencies.

## Data Flow

1. An extension calls `ui.select()`, `ui.confirm()`, or `ui.input()`.
2. TelePi's extension dialog manager supplies the title, body lines, state icon, and inline keyboard.
3. `renderDialogPanel()` produces native HTML and plain text.
4. The Telegram transport sends the HTML with its existing safe fallback behavior.
5. A callback, input reply, abort, cancellation, or timeout resolves the dialog.
6. The manager edits the original message with the final native rendering and removes the keyboard.

## Error Handling and Compatibility

The change preserves Telegram's 4,000-character dialog guard and transport fallback behavior. Escaping prevents malformed HTML and markup injection. Existing callback data stays in the indexed `ui_sel_<dialogId>_<index>` and confirmation/cancellation formats.

The change does not alter Pi's native TUI, `pi-ask-user`, timeout semantics, pending-dialog storage, session routing, or process-restart behavior. It adds no dependency and changes no public TypeScript interface.

## Testing

Update renderer tests to verify:

- HTML uses a bold title and contains no `<pre>` or `<code>` wrapper;
- HTML and fallback text contain no box-drawing frame;
- multiline question/context content remains readable;
- title and body content are HTML-escaped;
- blank-line section separation is stable.

Keep extension-dialog tests focused on behavior while updating their rendering expectations through `renderDialogPanel()`. Existing tests must continue to cover selections, confirmations, input, cancellation, aborts, explicit timeouts, missing timeouts, message editing failures, and callback routing.

Run the focused renderer and extension-dialog tests, then the complete test suite and TypeScript build.

## Scope

This task changes only extension-dialog presentation in TelePi. It does not redesign ordinary assistant messages, tool activity messages, command output, native Pi dialogs, inline-keyboard layout, or `ask_user` response semantics.
