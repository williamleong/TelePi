# Two-Way Telegram Topic and Session Name Sync Design

**Date:** 2026-08-02
**Status:** Approved

## Goal

Keep the active Pi session name and its Telegram forum-topic name synchronized in both directions. TelePi already copies Pi session names to Telegram topics; this change adds Telegram topic name to Pi session synchronization.

## Behavior

When an allowed Telegram user renames a forum topic, TelePi renames the Pi session currently mapped to that `(chatId, messageThreadId)` context.

TelePi does not create or resume a session in response to a topic edit. It ignores the edit when no active in-memory session is mapped to the topic. This avoids creating an unexpected fresh session after startup, before first use, or after `/handback`.

TelePi also ignores:

- edits from users outside the configured allowlist;
- edits without a message thread ID;
- icon-only topic edits that contain no name;
- empty topic names;
- edits whose name already matches the active session name;
- all other Telegram forum-topic service messages, as it does today.

## Architecture

### `src/pi-session.ts`

Add `PiSessionService.setSessionName(name)`, a narrow transport-neutral wrapper around the active Pi `AgentSession.setSessionName()` API. The existing Pi event bridge remains responsible for forwarding later `session_info_changed` events.

### `src/bot.ts`

Handle `forum_topic_edited` before the generic forum-service-message early return. The handler derives the topic context, validates the editor against `telegramAllowedUserIdSet`, reads the session with `sessionRegistry.get()`, compares its current name, and calls `setSessionName()` only when synchronization is required.

The inbound path must never call `getOrCreate()`. The existing outbound `renameForumTopicToSessionName()` path remains unchanged.

## Data flow

1. Telegram sends a `forum_topic_edited` service message containing a new name.
2. TelePi verifies the editor is allowlisted and the update identifies a forum topic.
3. TelePi looks up the existing topic-scoped session.
4. If the session exists and has a different name, TelePi writes the Telegram name through Pi's session API.
5. Pi persists the session-info entry and emits its normal session-name event.

A same-name check prevents redundant writes. Bot-generated outbound topic edits are not treated as authorized user edits, which also prevents feedback loops.

## Error handling

Session rename errors are logged with the topic context and do not produce a Telegram reply. A service-message failure must not create a session, interrupt normal bot processing, or expose internal errors in chat.

## Testing

Add integration coverage through the grammY bot harness for:

- an allowlisted topic rename updating the mapped active session;
- no session being created when no mapping exists;
- same-name edits producing no write;
- unauthorized edits producing no write or chat reply;
- icon-only edits producing no write;
- existing non-edit forum service messages remaining ignored.

Add Pi-session coverage proving `PiSessionService.setSessionName()` delegates to the active AgentSession API.

## Documentation

Update the README's per-topic session description to state that active session names and Telegram topic names synchronize in both directions, while topic edits without an active mapping are ignored.

## Out of scope

This change does not persist topic-to-session mappings across TelePi restarts, create sessions from topic edits, resume prior sessions by topic name, synchronize topic icons, or broaden the Telegram user allowlist.
