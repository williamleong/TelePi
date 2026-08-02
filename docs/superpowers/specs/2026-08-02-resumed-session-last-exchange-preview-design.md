# Resumed Session Last-Exchange Preview

## Goal

After TelePi switches to a saved Pi session, show the most recent completed exchange in Telegram. This gives the user immediate conversational context without changing the restored Pi context.

## Scope

This change applies to successful saved-session switches initiated through TelePi's `/sessions` command, including direct references and inline session-picker buttons. New sessions, failed or cancelled switches, tree navigation, and handback behavior remain unchanged.

## User experience

TelePi sends the normal switch confirmation first. It then sends a separate preview:

```text
↩️ Recent context

You
Could you update the authentication tests?

Pi
I updated the tests, fixed the failing fixture, and verified that all 42 cases pass.
```

If the assistant response contains several model messages, TelePi combines their text in chronological order. The preview excludes reasoning, tool calls, tool results, custom messages, and session summaries.

The preview is display-only. TelePi does not append it to the session or send it to the model.

## Exchange definition

An exchange begins with a user message and includes every later assistant text block before the next user message.

TelePi selects the newest completed exchange. If the latest user message has no assistant text, it scans backward to the previous user turn that does. If no completed exchange exists, TelePi omits the preview.

Telegram may split one long response into several delivery chunks. Those chunks do not create additional Pi session messages and do not affect extraction.

## Context source

`PiSessionService` reads `session.sessionManager.buildSessionContext().messages`. This API resolves the active branch and honors compaction checkpoints. TelePi must not parse the JSONL file or inspect unrelated branches.

The service exposes a structured, read-only result:

```typescript
interface PiSessionExchangePreview {
  userText: string;
  assistantText: string;
}
```

`PiSessionService.getLastExchangePreview()` returns this value or `undefined`.

## Text extraction

For user and assistant messages, TelePi extracts visible text blocks in source order. It ignores assistant thinking and tool-call blocks. For each user image, TelePi inserts the compact placeholder `[image]`; image data never appears in the preview.

Assistant text from multiple messages is joined with a blank line so separate model responses remain readable.

## Length limits

The preview uses a fixed character budget rather than a new configuration option:

- user text: at most 1,000 characters;
- combined assistant text: at most 2,000 characters;
- formatting remains below Telegram's 4,000-character message limit.

When assistant text exceeds its budget, TelePi preserves useful context from both ends and inserts `… recent response shortened …` between them. User text keeps its beginning because it usually contains the request and constraints.

## Rendering and delivery

A shared renderer creates plain-text and escaped Telegram HTML forms. Both direct `/sessions <reference>` switching and inline-button switching call the same renderer and delivery helper after the switch confirmation.

Preview delivery is best-effort. A formatting or Telegram delivery failure must not roll back or report the already-successful session switch as failed. TelePi should log the preview failure and leave the active session intact.

## Testing

Unit tests will cover:

- one user message followed by one assistant message;
- several assistant messages in one exchange;
- assistant messages containing text, thinking, and tool calls;
- tool-result and custom-message exclusion;
- an unanswered latest user message falling back to the previous completed exchange;
- active-branch and compacted context behavior through `buildSessionContext()`;
- user and assistant truncation;
- empty sessions and sessions without a completed exchange;
- preview delivery after direct and inline-button switches;
- no preview after failed or cancelled switches;
- preview-delivery failure leaving the successful switch intact.

## Non-goals

This change does not generate summaries, replay the full transcript, expose tool output, add a preview setting, or alter the model's restored context.
