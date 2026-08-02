# Telegram Stream UX and Steering Design

**Date:** 2026-08-02

## Goal

Reduce Telegram stream clutter and accept follow-on text as native Pi steering while an agent run is active.

## Scope

This change has three parts:

1. Remove routine `Working…` and `Done` status messages.
2. Compact activity formatting around thinking and tool rows.
3. Route ordinary text sent during an active run to Pi's steering queue.

It does not add a TelePi-managed prompt queue or change image, voice, slash-command, extension-dialog, or prompt-inbox behavior.

## Status and Abort lifecycle

TelePi will stop creating a status message for successful prompt runs.

- Native Telegram `typing` starts immediately and remains active until the prompt settles.
- Before the first output segment exists, users may cancel with `/abort`.
- When TelePi sends the first activity or assistant segment, it attaches the Abort keyboard to that message.
- Later segment delivery keeps the existing attach-before-detach Abort migration.
- Successful completion removes Abort keyboards and stops typing without sending or editing a `Done` message.
- A silent successful prompt produces no bot message.
- Abort, activation failure, binding failure, delivery failure, and prompt failure still produce an explicit failure or aborted message. When output already owns Abort, failure cleanup removes its keyboard before or while sending the failure notice.

This design deliberately trades an immediately visible inline Abort button for a clean stream. `/abort` remains available before first output.

## Activity formatting

Thinking blocks use plain heading text:

```text
🧠 Thinking
provider text
```

The heading and continuation heading are not bold. Rendering trims trailing whitespace from provider thinking text but preserves its other content. Adjacent activity blocks use one newline. A thinking block followed by Bash therefore renders compactly:

```text
🧠 Thinking
provider text
<b>• ⌨️ Bash</b>
<code>command</code>
```

Tool headings and code formatting remain unchanged. Chunk-size accounting continues to include headings and separators.

## Text steering

### Eligibility

An incoming Telegram message becomes steering only when all of these conditions hold:

- it is ordinary text, not a TelePi or Pi slash command;
- it targets the same chat or forum-topic session as the active run;
- that Pi session reports `isStreaming()`;
- TelePi is not locally switching sessions, transcribing media, or performing another local operation;
- the message was not consumed as an extension input response.

Images, documents, voice, audio, slash commands, prompt-inbox files, and extension dialog interactions keep their current busy behavior.

### Delivery

`PiSessionService` will expose a text-only `steer(text)` method backed by the SDK's `AgentSession.steer(text)`. The existing prompt handler will use it when its busy gate detects an eligible active stream. It will not start a second `runPromptFlow`, reserve a second `ChatTaskRunner` task, or create another Telegram delivery subscription.

The original prompt promise remains authoritative. Pi consumes steering after the current assistant turn and tool calls and before its next model call. Resulting thinking, tool, and assistant events continue through the original chronological segment worker.

Accepted steering receives no extra acknowledgement message; the user's Telegram message is the acknowledgement. If steering fails, TelePi sends a concise error. If the context is busy for a non-steerable reason, it retains the existing busy response.

The handler checks steering both before task reservation and after an atomic reservation race reports busy. This closes the window where streaming begins between the first busy check and `ChatTaskRunner.tryStartPrompt()`.

## Component changes

- `src/bot/prompt-handler.ts`
  - Remove successful-run status creation and final `Done` editing.
  - Attach Abort on first output instead of a status message.
  - Keep failure notices, keyboard cleanup, delivery draining, and typing cleanup.
  - Attempt eligible steering in both busy branches.
- `src/bot/activity-rendering.ts`
  - Render plain thinking headings.
  - Trim trailing thinking whitespace and use a single newline between activity blocks.
- `src/pi-session.ts`
  - Add a wrapped `steer(text)` service method.
- `src/bot.ts`
  - Provide a context-aware steering callback that distinguishes Pi streaming from local busy state.
- Tests and documentation
  - Replace Working/Done expectations with no-status behavior.
  - Add exact compact-format assertions.
  - Cover service steering, same-topic steering, topic isolation, dialog priority, command/media exclusions, steering races, failure reporting, and continued chronological output.

## Error handling and races

- Failure to attach an Abort keyboard does not fail content delivery; `/abort` remains available.
- Steering SDK errors are reported without disturbing the active prompt pipeline.
- A prompt that settles between eligibility and `steer()` may reject steering. TelePi reports the rejection rather than starting a concurrent prompt.
- Finalization still drains the single delivery worker before removing keyboards and stopping typing.
- Failure finalization sends one explicit status even though successful runs have no status message.

## Acceptance criteria

1. Successful runs never send `Working…` or `Done`.
2. Typing remains active for the full run.
3. The first output segment receives Abort; completion removes it.
4. `/abort` works before first output.
5. Failures and aborts remain visible.
6. Thinking headings are plain, trailing whitespace is removed, and the next tool row follows after one newline.
7. Ordinary text in the same streaming chat/topic calls Pi steering and does not show `Still working on previous message...`.
8. Steering output stays in the original chronological stream.
9. Different topics and non-text inputs preserve their existing isolation and busy behavior.
10. Existing activity toggles, tool verbosity modes, callback routing, topic-name synchronization, and prompt finalization behavior remain intact.
