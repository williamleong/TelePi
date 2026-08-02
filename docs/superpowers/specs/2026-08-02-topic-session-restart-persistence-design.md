# Telegram Topic Session Restart Persistence Design

**Date:** 2026-08-02
**Status:** Approved

## Goal

Preserve each Telegram chat or forum topic's active Pi session across TelePi process restarts. After restart, the next message in a previously used context must resume that context's last active session instead of creating an unrelated session.

## Root cause

`PiSessionRegistry` keys active services by `chatId::messageThreadId`, but stores those associations only in memory. A process restart creates an empty registry. Pi's JSONL session files remain on disk, but they contain no Telegram context identifier, so `getOrCreate()` cannot reconnect a topic to its previous session and calls `SessionManager.create()`.

The one-shot `PI_SESSION_PATH` bootstrap does not provide durable per-topic recovery. The first context used after startup consumes it, regardless of which topic previously owned that session.

## Persisted state

Add a small versioned JSON state file containing context-to-session records:

```json
{
  "version": 1,
  "topics": {
    "123::77": {
      "sessionFile": "/home/user/.pi/agent/sessions/...jsonl",
      "workspace": "/home/user/project"
    }
  }
}
```

Use the platform state directory rather than the configuration file:

- Linux and other Unix platforms: `${XDG_STATE_HOME:-~/.local/state}/telepi/topic-sessions.json`
- macOS: `~/Library/Application Support/TelePi/topic-sessions.json`

Create directories and files with user-only permissions where the platform supports them. Write updates through a temporary file followed by an atomic rename.

## Architecture

### `src/topic-session-store.ts`

Add a focused persistence component that:

- loads and validates the versioned state file;
- returns a saved record by Telegram context key;
- upserts a record after the active session changes;
- deletes a record after intentional context removal;
- writes state atomically;
- treats a missing file as empty state;
- logs malformed or inaccessible state and continues with empty or last-known in-memory state.

The store must not persist bot tokens or message contents.

### `src/pi-session.ts`

Construct `PiSessionRegistry` with the topic-session store. `getOrCreate()` chooses its initial session in this order:

1. the one-shot explicit bootstrap session, when present;
2. a valid persisted session for the requested context;
3. a new Pi session.

The explicit bootstrap retains its current semantics and overrides a saved association because it represents an intentional handoff. Once claimed, it replaces that context's saved association.

After service creation, persist its session file and workspace. Add a narrow session-change callback so successful `/new`, `/switch`, and fork operations update the same record immediately. A successful handback or registry `remove()` deletes the record. Ordinary `dispose()` retains records because shutdown must not erase restart state.

If a saved session file no longer exists, delete the stale record, log a warning, and create a new session. Do not pass a missing path to Pi because Pi may initialize a new history at that path and make the failed recovery look successful.

### `src/paths.ts`

Add helpers for the default TelePi state directory and topic-session state path. Keep path policy separate from persistence behavior so platform handling can be tested independently.

## Data flow

1. A topic first contacts TelePi.
2. The registry checks for an explicit bootstrap, then a persisted record for the topic key.
3. TelePi opens the saved Pi JSONL session when the record and file are valid.
4. The registry stores the active session path and workspace after creation or any later session replacement.
5. A process restart reconstructs an empty in-memory service map but reloads the persisted associations.
6. The topic's next message lazily opens its saved session and continues the existing Pi history.

Lazy restoration avoids starting every saved Pi runtime during TelePi startup.

## Error handling

Persistence is best-effort and must not make TelePi unavailable. Read, validation, directory creation, and write failures produce concise warnings without exposing message contents or credentials. A malformed file is ignored rather than partially trusted. Atomic replacement prevents interrupted writes from leaving truncated JSON.

A stale or deleted Pi session file removes only its own context record. Other topic mappings remain intact.

## Testing

Add tests that prove:

- a recreated registry opens the same saved session for the same topic;
- root chats and forum topics remain isolated;
- a different topic does not claim another topic's saved session;
- `/new`, `/switch`, and fork replacements update persistence;
- `remove()` and handback delete persistence;
- ordinary `dispose()` retains persistence;
- a missing session file removes the stale record and creates a new session;
- malformed state degrades to empty state;
- state writes use the expected versioned shape;
- platform path helpers choose the documented locations.

Run the full test suite and TypeScript build after implementation.

## Documentation

Update the README's per-topic session section to state that TelePi restores topic-to-session associations across process restarts and falls back to a new session when a saved session file is gone.

## Out of scope

This change does not infer old mappings that predate the state file, synchronize mappings across machines, restore deleted Pi session files, change Telegram topic naming, or redesign how `PI_SESSION_PATH` chooses the first context after handoff.
