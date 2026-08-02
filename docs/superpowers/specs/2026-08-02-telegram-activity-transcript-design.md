# Telegram Activity Transcript Design

**Date:** 2026-08-02
**Status:** Approved

## Goal

Give Telegram users a compact, terminal-like view of Pi activity while a response runs. The transcript interleaves model-provided thinking blocks and deterministic tool summaries. It does not call another model or summarize the thinking text.

## User interface

TelePi adds one local command:

- `/activity on` enables the activity transcript for the current chat or forum topic.
- `/activity off` disables it for the current chat or forum topic.
- `/activity` reports the current state and shows the accepted arguments.

Activity defaults to `on`. The choice is held in memory under TelePi's existing `(chatId, messageThreadId)` context key. A direct chat and each forum topic therefore have independent choices. Restarting TelePi clears overrides, so every context returns to `on`.

The command appears in TelePi's command picker, Telegram's native command list, and `/help` output.

## Transcript behavior

Each prompt gets a separate activity transcript and final assistant response. TelePi builds the transcript from Pi session events in their original order:

```text
🧠 Thinking
Inspect the session event handling.

🔍 Read
src/pi-session.ts

🧠 Thinking
The callback currently ignores thinking deltas.

⌨️ Bash
npm test
```

Thinking content comes directly from `thinking_delta` events. TelePi concatenates streaming deltas for each thinking block and preserves the resulting text. It performs only transport formatting: Telegram HTML escaping, message-size handling, and line wrapping where required. It does not paraphrase, summarize, or send the content to another model.

Tool rows come from tool execution events. TelePi formats common built-in tools with concise labels and selected arguments, for example:

- `Read` with its path
- `Bash` with its command
- `Edit` or `Write` with its target path
- `Grep` with its pattern and optional search path
- `Find` with its pattern and optional search path
- `LS` with its path

Unknown or extension-provided tools fall back to a humanized tool name without serializing arbitrary arguments. This keeps the default view compact and avoids leaking large or sensitive payloads.

A started tool appears immediately. Completion updates its marker to success or failure without adding another row. Thinking and tool events remain interleaved in event order. The final assistant response stays in its existing, separate Telegram message.

## Telegram delivery

TelePi sends an initial activity message when the first displayable activity event arrives. It edits the message on the same debounce schedule used for streamed assistant output. This avoids one Telegram notification per event.

Telegram messages have finite size limits. When the current activity message reaches the safe rendering limit, TelePi finalizes it and starts a continuation message. It never truncate-summarizes thinking text. Existing Telegram retry and plain-text fallback behavior applies to activity messages.

If no thinking or tool activity occurs, TelePi sends no activity message.

## Interaction with tool verbosity

When activity is enabled, the unified transcript replaces the legacy per-tool status messages and final tool-count summary. This prevents duplicate tool reporting.

When activity is disabled, the existing `TOOL_VERBOSITY` behavior remains unchanged. This preserves compatibility for users who turn the transcript off.

## Architecture

### `src/bot/chat-state.ts`

Store the optional per-context activity override and expose operations to read or update it. Reading an unset override returns `true`.

### `src/pi-session.ts`

Extend `PiSessionCallbacks` to forward:

- thinking stream events, including enough block identity to distinguish adjacent blocks;
- tool start events with tool arguments;
- existing tool completion events.

The session layer remains transport-neutral and does not format Telegram output.

### `src/bot/activity-rendering.ts`

Add a focused, pure rendering module for:

- activity transcript event/state types;
- built-in tool summary formatting;
- thinking-block assembly;
- completion markers;
- safe conversion to Telegram-renderable chunks.

This module must not perform network calls or mutate chat state.

### `src/bot/prompt-handler.ts`

Own per-prompt transcript state and Telegram delivery. It subscribes to thinking and tool events only when activity is enabled, maintains event order, debounces edits, rolls over full messages, and finalizes the transcript before completing prompt cleanup.

### Command wiring

`src/bot/commands/basic.ts` handles `/activity`. `src/bot/slash-command.ts` publishes it in command catalogs. `src/bot.ts` registers and dispatches it. Existing help renderers document the command.

## Error handling

Activity delivery is secondary to the agent response. A failed activity send or edit is logged and disables further activity updates for that prompt; it must not fail or abort the Pi prompt. Final assistant delivery continues normally.

Invalid command arguments return the current state and usage: `Usage: /activity on|off`. The command does not create a Pi session.

Thinking availability depends on the selected model and provider. TelePi shows no thinking rows when Pi emits none; tool activity still works.

## Security and privacy

The feature exposes provider-supplied thinking text to the allowlisted Telegram destination. Because this can reveal intermediate reasoning and working context, `/activity off` must take effect before the next prompt starts.

TelePi escapes model and tool text before sending HTML. Tool formatters use a small allowlist of display fields instead of dumping arbitrary argument objects or tool results. Existing Telegram allowlist and chat/topic isolation remain unchanged.

## Testing

Add focused unit tests for:

- default-on state and independent chat/topic overrides;
- `/activity`, `/activity on`, `/activity off`, and invalid arguments;
- command picker, native command list, and help registration;
- verbatim thinking-delta assembly across multiple deltas and blocks;
- deterministic summaries for each built-in tool and the unknown-tool fallback;
- interleaved thinking/tool event order;
- success and error marker updates;
- Telegram escaping and multi-message rollover;
- no activity message when no displayable events occur;
- activity delivery failures not affecting final responses;
- suppression of legacy tool messages and summaries while activity is on;
- unchanged `TOOL_VERBOSITY` behavior while activity is off.

Update integration tests around the prompt lifecycle to verify that the activity transcript and final answer are delivered as separate messages.

## Out of scope

The first version does not persist activity choices, add a configuration environment variable, summarize thinking, provide separate tool/thinking toggles, expose tool output, or reproduce Pi's expandable terminal rendering.
