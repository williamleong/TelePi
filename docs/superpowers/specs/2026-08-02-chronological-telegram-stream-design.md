# Chronological Telegram Stream Design

**Date:** 2026-08-02
**Status:** Approved

## Goal

Present TelePi output in the same order Pi produces it. Thinking, tools, assistant text, and later activity appear as chronological Telegram message segments. Keep one visible Abort control on the newest active segment and keep Telegram's native typing status active until the run settles.

## Current problems

TelePi sends a `Working…` message before a prompt, then edits that message with streamed assistant text and the final response. Activity messages are sent afterward. Telegram therefore displays assistant output above thinking and tool activity that occurred earlier.

The Abort button remains attached to the original working message. Once activity messages appear below it, the control is easy to miss. TelePi also stops the native typing indicator as soon as it sends the working message, so the indicator is absent during most agent work.

## User-visible behavior

A run begins with a status message:

```text
⏳ Working…                       [⏹ Abort]
```

TelePi never writes assistant content into this status message. As events arrive, it appends chronological segments:

```text
⏳ Working…

🧠 Thinking
Inspect the current implementation.

• 🔍 Read
src/bot/prompt-handler.ts

💬 Assistant
The current stream edits the status message.

🧠 Thinking
Change delivery to append chronological segments.

• ⌨️ Bash
npm test

💬 Assistant
Implemented chronological Telegram streaming.
```

The status message may change to `✅ Done`, `⏹ Aborted`, or the existing failure state when the run settles, but it never contains streamed assistant output.

## Segment rules

TelePi maintains an ordered list of segments. A segment is either:

- **Activity:** one or more adjacent thinking and tool events.
- **Assistant:** adjacent `text_delta` events from one uninterrupted assistant-text phase.

An event of the same kind extends the open segment. A switch between activity and assistant output seals the current segment and starts a new Telegram message. Sealed segments are never edited for new content.

TelePi may edit only the newest open segment while that segment streams. This avoids one Telegram message per token while preserving visible chronology. Message rollover caused by Telegram's size limit creates continuation messages within the same segment. Once another segment begins, all earlier continuation messages are sealed.

Tool completion may update the tool row in its owning activity segment. Pi completes tool execution before the next model turn, so this update normally occurs while that activity segment remains open. The implementation must retain message IDs for every chunk so late completion updates the correct chunk without changing segment order.

## Working status and final output

The initial working message is a control/status message only. The first assistant delta always creates a new assistant segment below it. Final assistant text remains in its chronological assistant segment; finalization does not copy the accumulated answer into the status message or rewrite an earlier segment.

If a run produces no thinking, tools, or assistant text, TelePi changes the status to `✅ Done`. If it produces output, finalization seals and flushes the last segment, updates the status message, and clears the Abort keyboard.

Existing Telegram markdown/HTML formatting and fallback behavior apply to assistant segments. Thinking remains verbatim except for transport escaping and message-size handling. Tool rows remain deterministic and expose only allowlisted fields.

## Abort control

Exactly one active Abort keyboard is visible during a run.

1. The status message owns the keyboard initially.
2. When TelePi sends the first output segment, it attaches the keyboard to that segment's newest message and removes it from the previous owner.
3. On rollover or a new segment, it moves the keyboard to the newest message.
4. Finalization removes the keyboard from its current owner.

TelePi tracks every message that temporarily owns the keyboard with the existing callback-message context mechanism. This preserves chat/topic routing for callback queries. If moving the keyboard fails, TelePi logs the error and keeps prompt processing alive; it must not intentionally remove the only known working Abort control before a new owner accepts it.

## Typing indicator

TelePi sends Telegram's native `typing` action immediately and refreshes it every 4.5 seconds for the whole prompt lifecycle. Sending the working message or an output segment does not stop the interval. TelePi stops typing only when the prompt completes, fails, is aborted, or session activation fails.

Typing-action failures remain best-effort and do not affect the prompt.

## Architecture

### `src/bot/stream-segments.ts`

Add a focused state module that owns chronological segment boundaries and message/chunk metadata. It accepts thinking, tool-start, tool-end, and assistant-text events and exposes dirty open segments for rendering. It does not call Telegram APIs.

The existing `activity-rendering.ts` continues to render activity content. Existing assistant rendering helpers continue to format assistant text. The segment layer coordinates them without duplicating their escaping or chunking logic.

### `src/bot/prompt-handler.ts`

Replace the independent accumulated-response and activity delivery paths with one serialized segment-delivery queue. The handler:

- creates and updates segments from Pi callbacks;
- sends or edits only the open segment;
- seals a segment when output kind changes;
- moves the Abort keyboard after successful sends;
- keeps typing active until settlement;
- waits for all queued delivery before final status cleanup.

The delivery queue must remain authoritative during debounce and finalization. Reentrant flushes await the same worker and process newer versions before finalization returns.

### Telegram transport

Use existing `sendTextMessage()`, `safeEditMessage()`, and `editMessageReplyMarkup()` behavior. No new Telegram dependency is required.

## Error handling

Activity delivery remains best-effort: failure disables later activity updates for that segment but does not suppress assistant delivery. Assistant-message delivery failures continue through the existing prompt failure path.

Keyboard migration follows attach-before-detach ordering. A failed attach leaves the prior owner unchanged. A failed detach can temporarily leave two Abort buttons, which is safer than leaving none; final cleanup attempts to remove every known owner.

Finalization waits for the active delivery worker and all pending versions before changing the status message or clearing controls. Timer callbacks must not send or edit messages after finalization.

## Testing

Add focused tests for:

- the initial status message never receiving assistant text;
- thinking → assistant → thinking → assistant producing four ordered segments;
- adjacent text deltas editing only the latest assistant segment;
- adjacent activity events editing only the latest activity segment;
- sealed segments never changing when later events arrive;
- rollover retaining order and updating the correct tool chunk;
- final output appearing below all earlier thinking and tool segments;
- one Abort owner at a time across first output, kind switches, and rollover;
- attach-before-detach behavior when keyboard migration succeeds or fails;
- final cleanup removing keyboards from all known owners;
- callback context registration for each Abort owner in forum topics;
- typing continuing after the working and activity messages;
- typing stopping on completion, failure, abort, and activation failure;
- debounce/finalization races with deferred Telegram sends;
- existing `/activity off` and `TOOL_VERBOSITY` behavior remaining unchanged.

Update bot-level integration tests to assert Telegram call order and message IDs, not only message contents.

## Out of scope

This change does not add message deletion, per-token Telegram messages, persistent activity settings, configurable typing intervals, or a second LLM pass. It does not alter which provider thinking text is available.
