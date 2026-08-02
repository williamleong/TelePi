# Agent Live Progress Design

## Goal

Show foreground subagent progress in TelePi by editing the existing Agent activity row as the subagent works. Match Pi's compact TUI behavior without exposing nested tool output or changing other tools.

## Current behavior

TelePi receives Pi's `tool_execution_update` events, but activity mode ignores them. The Agent extension already emits structured partial results with an `activity` field such as `thinking…`, `reading…`, or `running command…`. As a result, Telegram shows only `• Agent` until the tool finishes.

## User experience

An Agent activity entry shows its invocation description and current activity:

```text
• Agent — Find relevant code
running command…
```

Each structured Agent update replaces the detail in the same Telegram message. Completion changes the status and removes stale running activity:

```text
✓ Agent — Find relevant code
Done
```

Errors use `✗` and `Error`. Missing or malformed updates leave the current row unchanged.

## Architecture

### Session event bridge

Keep `tool_execution_update.partialResult` structured when forwarding it from `src/pi-session.ts`. TelePi must not stringify the value before consumers can inspect Agent metadata.

### Activity state

Extend Agent tool entries in `src/bot/activity-rendering.ts` with optional display metadata:

- the invocation description, read from the Agent call arguments;
- the latest activity string, read from structured Agent partial-result details.

Add an activity transcript operation that updates a tool entry by `toolCallId`. It accepts updates only for the exact `Agent` tool and only when `details.activity` is a non-empty string.

When the Agent finishes, replace any running activity with `Done` or `Error`. Other tool entries retain their existing behavior.

### Stream delivery

Extend `src/bot/stream-segments.ts` with an update operation that finds the Agent tool's owning activity segment, applies the structured update, and increments that segment's revision only when visible state changes.

In `src/bot/prompt-handler.ts`, activity mode forwards tool updates to this operation and requests delivery when it reports a change. The existing serialized delivery worker then edits the existing Telegram message and preserves chronological ordering, chunk ownership, and Abort-button movement.

### Rendering

Keep the existing status symbols. Render Agent entries as:

- label: `Agent — <description>` when a description exists, otherwise `Agent`;
- detail while running: the latest structured activity;
- detail after completion: `Done` or `Error`.

Continue escaping all HTML and enforcing Telegram's existing message-size limit.

## Error handling

Treat partial results as untrusted extension data. Ignore null values, arrays, non-object values, absent `details`, and non-string or blank `details.activity` fields. Do not parse arbitrary text as JSON and do not display arbitrary tool content.

A malformed update must not fail the prompt or mark a segment dirty.

## Testing

Add focused tests that prove:

1. the Pi session bridge forwards structured partial results unchanged;
2. Agent arguments render the invocation description;
3. valid Agent updates replace the current activity in place;
4. malformed updates and updates for other tools do nothing;
5. completion replaces stale running activity with `Done` or `Error`;
6. stream-segment revisions change only for visible Agent updates;
7. prompt handling edits the existing Telegram activity message rather than sending a duplicate.

Run the focused suites, the full Vitest suite, and the TypeScript build.

## Scope

This change applies only to the foreground `Agent` tool's inline activity row. Background Agent runs, the separate TUI widget, generic streaming tools, nested command text, configuration, and Telegram commands remain unchanged.
