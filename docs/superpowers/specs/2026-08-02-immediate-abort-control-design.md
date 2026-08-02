# Immediate Telegram Abort Control Design

**Date:** 2026-08-02
**Status:** Approved

## Goal

Show an inline Abort control as soon as a TelePi prompt can be cancelled, including while the provider is thinking or a tool has not produced visible output. Preserve the compact chronological stream without leaving a separate routine `Working…` or `Done` message.

## Root cause

TelePi previously sent `⏳ Working…` with an Abort keyboard before starting the Pi prompt. Commit `47691bf` removed that status message to reduce Telegram clutter. The current prompt handler attaches Abort only when it sends the first activity or assistant segment.

This leaves no inline control between prompt activation and first visible output. The gap can cover an entire long-running tool when activity is disabled with `TOOL_VERBOSITY=none`, `summary`, or `errors-only`. `/abort` still works, but the UI does not expose that recovery path.

## User-visible behavior

After TelePi activates the session, it sends:

```text
⏳ Working…                       [⏹ Abort]
```

The message is temporary:

- The first activity or assistant chunk replaces `Working…` in the same Telegram message and keeps the Abort keyboard.
- Later chunks and segments use the existing chronological delivery and attach-before-detach Abort migration.
- A silent successful prompt deletes the temporary message.
- A prompt that fails before output edits the temporary message to the existing failure or aborted status and removes its keyboard.
- If the temporary message cannot be sent, TelePi logs the transport error and falls back to the current behavior: typing continues, `/abort` remains available, and the first visible output receives the inline Abort control.

## Architecture

### Prompt activation

`runPromptFlow()` continues to start Telegram typing before session activation. Once `ensureActiveSession()` returns a session and command synchronization starts, the handler sends the temporary working message before binding extensions and calling `piSession.prompt()`.

The temporary message becomes the initial Abort owner and is registered with `trackCallbackMessage()` for forum-topic callback routing.

### First output adoption

The segment delivery worker remains the sole activity and assistant output pipeline. When it delivers the first rendered chunk and the temporary working message still exists, it edits that message instead of sending a new one. It then assigns the message ID to the stream chunk.

This preserves chronological ordering and avoids an extra Telegram message. Because the message already owns Abort, no keyboard migration is needed for the adopted chunk.

If the first rendered segment needs more than one chunk, the first chunk adopts the temporary message and remaining chunks are sent normally. Existing migration moves Abort to the newest chunk.

### Finalization

Success finalization drains all pending output first. If no output adopted the temporary message, TelePi deletes it. If output adopted it, the message remains as ordinary stream content. Finalization then removes every tracked Abort keyboard and stops typing.

Failure finalization also drains pending output. If the temporary message still contains `Working…`, TelePi edits it to the existing failure status. If output already adopted the message, TelePi keeps the current standalone failure notice. Both paths clean all Abort owners and stop typing.

## Error handling and races

- The working-message send is best effort. Its failure must not prevent the Pi prompt from starting.
- The handler stores one promise for working-message creation so concurrent paths cannot send duplicates.
- First-output adoption occurs only after working-message creation settles, preventing an output send from racing ahead and leaving a stale status message.
- If adoption fails, the normal delivery failure path reports the failure; TelePi does not silently discard model output.
- Abort migration retains attach-before-detach ordering.
- Deleting a silent-success status is best effort. Cleanup still removes its keyboard if deletion fails.
- Finalization continues to drain the authoritative delivery queue before changing or removing controls.

## Scope

Change only:

- `src/bot/prompt-handler.ts`
- focused prompt-handler tests and any bot-level regression needed for callback routing
- `README.md` and `docs/architecture.md`

Do not change Pi SDK cancellation, tool implementations, steering, activity rendering, tool verbosity semantics, Telegram command registration, or callback routing.

## Testing

Add regression coverage for:

1. A long-running prompt with no output immediately receives `Working…` with Abort.
2. The first Agent activity chunk replaces the working message and keeps Abort.
3. The first assistant chunk replaces the working message when activity is disabled.
4. Multi-chunk first output adopts the status for chunk one and migrates Abort to the newest chunk.
5. Silent success deletes the temporary message and leaves no Abort keyboard.
6. Early failure or abort edits the temporary message to the terminal status and clears Abort.
7. Working-message send failure falls back to first-output Abort ownership.
8. Existing kind-switch, rollover, delivery-drain, typing-lifetime, and forum-topic callback tests continue to pass.

## Acceptance criteria

- An active cancellable prompt always has a visible inline Abort control after session activation.
- Provider thinking and long-running Agent tools remain interruptible from the visible Telegram UI.
- Normal successful output contains no separate persistent Working or Done message.
- Exactly one Abort owner is intended at a time, with existing safe migration and cleanup behavior.
- `/abort` remains available as a command-level fallback.
