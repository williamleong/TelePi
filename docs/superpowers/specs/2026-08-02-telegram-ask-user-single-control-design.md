# Telegram `ask_user` Single-Control Design

**Date:** 2026-08-02

## Goal

Show one visible cancellation control while TelePi waits for an `ask_user` response.

## Problem

TelePi currently presents the same interaction twice when activity or verbose tool output is enabled:

1. the prompt stream renders `ask_user` as an “Ask User” tool activity and assigns that message the run-level **Abort** button;
2. the extension UI renders the structured question with its own **Cancel** button.

The buttons have different scopes, but they appear redundant. **Cancel** resolves the question without necessarily ending the agent run. **Abort** ends the active Pi operation and also cancels any pending extension dialog.

## Approved Behavior

TelePi will treat `ask_user` as interactive UI rather than ordinary tool activity.

- The extension dialog remains the only visible representation of an active `ask_user` call.
- The dialog keeps its existing **Cancel** button and selection behavior.
- TelePi does not render an “Ask User” activity row, verbose tool-start message, tool error row, or summary count for `ask_user`.
- `/abort` remains available while the dialog is pending and still stops the entire Pi operation.
- Other tools retain their current activity, verbosity, summary, and Abort behavior.
- After the dialog resolves, later assistant or tool output receives the normal Abort control while the run remains active.

## Architecture

Add one narrow tool-classification helper at the prompt-handler boundary. It identifies tool calls whose user-facing interface already represents the operation. The initial classification contains only the exact SDK tool name `ask_user`.

The prompt handler records suppressed tool-call IDs when it receives `onToolStart`. It ignores subsequent updates and completion events for those IDs. This applies before activity-mode and verbosity-mode branches so every output mode follows the same rule.

The extension dialog manager remains unchanged. It continues to own question rendering, callbacks, input, timeouts, cancellation, and signal-abort cleanup.

## Data Flow

1. Pi emits `onToolStart("ask_user", toolCallId, args)`.
2. TelePi marks the call as dialog-backed and emits no stream segment or legacy tool message.
3. The extension calls `ui.select`, `ui.confirm`, or `ui.input` through TelePi’s existing UI context.
4. TelePi sends the structured dialog with its existing buttons.
5. The user selects an answer or cancels the dialog. `/abort` remains the full-run escape hatch.
6. Pi receives the tool result and continues. Any later non-dialog output follows the normal stream and Abort lifecycle.

## Error Handling

If `ask_user` fails before or after opening its dialog, the existing prompt-failure path remains authoritative. TelePi still sends the standard failure notice. Suppressing the tool activity must not suppress prompt failure reporting.

Unknown tools and future dialog-capable tools remain visible until they are explicitly classified. This avoids hiding output based on naming patterns or extension-specific assumptions.

## Testing

Add prompt-handler regressions that exercise `ask_user` in these configurations:

- activity enabled;
- activity disabled with `all` verbosity;
- activity disabled with `summary` verbosity;
- activity disabled with `errors-only` verbosity.

Each test verifies that `ask_user` produces no stream or legacy tool message and no Abort owner. At least one test emits later assistant text and verifies that normal delivery and Abort ownership resume. Existing extension-dialog tests continue to cover the visible Cancel button and cancellation semantics.

Run the focused prompt-handler tests, the complete test suite, TypeScript checks, and the production build.

## Scope

This change does not alter the `ask_user` API, Telegram callback data, extension-dialog rendering, Pi’s native TUI, ordinary tool formatting, or `/abort` semantics. It does not create a general extension metadata protocol; that would add complexity without serving the current issue.
