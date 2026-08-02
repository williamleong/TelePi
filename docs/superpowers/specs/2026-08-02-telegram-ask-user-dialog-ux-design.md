# Telegram `ask_user` Dialog UX Design

## Problem

TelePi maps Pi extension UI calls to Telegram messages and inline keyboards. The `pi-ask-user` dialog fallback currently creates two dialogs for a normal selection: one for the options and another for an optional comment. TelePi also applies a 60-second timeout when the caller did not request one. A user who selects an option can therefore see a second dialog later report `Dialog timed out.`

The fallback also passes option titles to `ui.select()` without their descriptions. Telegram users do not see the same decision details as users of the native `ask_user` interface.

## Approved Behavior

Telegram `ask_user` interactions will follow these rules:

1. A dialog has no implicit timeout. It remains pending until the user answers, cancels it, aborts the session, or the caller supplies an explicit timeout.
2. Telegram shows every structured option title and description supplied to `ask_user`.
3. Telegram provides one button for each structured option.
4. Selecting a structured option completes the question immediately.
5. When `allowFreeform` is enabled, Telegram adds a final `✏️ Custom response...` button. Selecting it opens a text-input dialog.
6. The dialog fallback does not open an automatic optional-comment prompt after a structured selection. Users who need additional context can choose the custom-response option.

## Architecture

The change spans two repositories because each owns a different boundary.

### `pi-ask-user`

The dialog fallback will build display labels from each option's title and optional description. It will keep a mapping from each display label to the original title so the structured response remains stable.

The fallback will return immediately after a structured selection. It will retain the existing freeform sentinel and input flow. Native TUI behavior remains unchanged, including its optional-comment support.

### TelePi

The extension dialog manager will create a timeout only when `dialogOptions.timeout` is a positive finite value. TelePi will remove its implicit 60-second extension-dialog timeout.

A select dialog's message body will list the supplied options so full labels remain readable even when Telegram button labels must be trimmed. Buttons will preserve the existing callback-index protocol.

## Data Flow

1. `ask_user` receives structured options.
2. Its dialog fallback formats title and description into a display label and calls `ui.select()`.
3. TelePi renders the display labels in the message and creates indexed inline buttons.
4. A button callback resolves the selected display label.
5. `pi-ask-user` maps that label back to the original structured title and returns a selection response.
6. If the user chooses `✏️ Custom response...`, `pi-ask-user` calls `ui.input()` and returns a freeform response.

## Timeout and Cancellation

An omitted timeout creates no timer. Explicit positive finite timeouts retain the existing timeout rendering and promise resolution. Session aborts and Telegram cancel buttons retain their current behavior. Invalid, zero, negative, or non-finite timeout values create no timer.

## Testing

### `pi-ask-user`

Add regression tests that verify:

- descriptions appear in dialog-mode selection labels;
- selecting a structured option returns its original title;
- a structured selection does not call `ui.input()` for an optional comment;
- the custom-response sentinel still opens `ui.input()` and returns freeform text.

### TelePi

Add regression tests that verify:

- dialogs without an explicit timeout remain pending beyond the former default;
- explicit timeouts still finalize dialogs;
- select messages list full option labels while buttons remain indexed and trimmed;
- selecting an option resolves the existing callback flow without opening another dialog.

Run each repository's complete test suite and build checks before integration.

## Scope

This change does not add a Telegram-specific API to Pi, alter native TUI rendering, change callback payload formats, or add persistent dialog storage. A TelePi process restart can still cancel an in-memory pending dialog.
