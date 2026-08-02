# TelePi Architecture

This document describes the current runtime/module layout after the bot and install refactors.

## Top-level runtime flow

```text
Telegram
  ↓
Grammy bot (`src/bot.ts`)
  ├─ transport helpers (`src/bot/telegram-transport.ts`)
  ├─ rendering helpers (`src/bot/message-rendering.ts`)
  ├─ activity transcript rendering (`src/bot/activity-rendering.ts`)
  ├─ chronological segment state (`src/bot/stream-segments.ts`)
  ├─ prompt execution and serialized delivery (`src/bot/prompt-handler.ts`)
  ├─ chat-local state (`src/bot/chat-state.ts`)
  ├─ extension dialogs (`src/bot/extension-dialogs.ts`)
  └─ grouped command handlers (`src/bot/commands/*`)
        ↓
Pi session layer (`src/pi-session.ts`)
  ├─ AgentSession / SessionManager
  ├─ workspace + session switching
  ├─ model selection / scope handling
  └─ tree navigation + handback helpers
        ↓
Pi SDK + workspace-scoped tools
```

## Bot module layout

### `src/bot.ts`
The main assembly/orchestration file. It:
- creates the Grammy bot
- owns shared pending picker state
- wires commands, callbacks, text messages, and voice messages
- connects command handlers, prompt handling, and extension dialogs together

### `src/bot/message-rendering.ts`
Pure rendering helpers for:
- Telegram HTML/plain fallback text
- help/session/tool messages
- markdown chunking and streaming previews
- string truncation and formatting helpers

### `src/bot/activity-rendering.ts`
Activity transcript helpers for:
- preserving provider thinking text
- rendering deterministic compact tool rows
- splitting activity transcripts into Telegram-sized chunks

### `src/bot/telegram-transport.ts`
Telegram-specific transport helpers for:
- `safeReply`
- `safeEditMessage`
- `sendTextMessage`
- `sendChatAction`
- Telegram file download handling

### `src/bot/slash-command.ts`
Pure logic for:
- TelePi command catalog
- slash-command normalization
- command picker entries
- chat-scoped Telegram command syncing inputs

### `src/bot/keyboard.ts`
Pure keyboard helpers for:
- pagination
- appending buttons
- splitting tree nav vs filter buttons

### `src/bot/chat-state.ts`
Per-chat/topic transient state for:
- processing/switching/transcribing busy flags
- retry memory (`/retry`)
- per-chat/topic activity detail settings (`/activity on|off`), defaulting to on and resetting on restart

### `src/bot/extension-dialogs.ts`
Telegram-backed extension UI dialog lifecycle for:
- select dialogs
- confirm dialogs
- input dialogs
- timeout/cancel/finalization behavior

### `src/bot/stream-segments.ts`
Telegram-free state for the chronological prompt transcript. It groups adjacent thinking/tool events into activity segments and adjacent assistant deltas into assistant segments, seals segments when the output kind changes, tracks tool ownership and Telegram chunk metadata, and exposes dirty revisions for delivery. Structured Agent partial results update their owning tool entry and increment its segment revision only when the visible activity changes. Agent entries use dedicated, bounded chunks so progress-to-completion edits cannot discard an already delivered Telegram chunk.

### `src/bot/prompt-handler.ts`
Owns the prompt execution lifecycle and one serialized chronological segment worker:
- busy checks, session bootstrap, and extension binding
- Pi callback routing into activity and assistant segments
- debounced, ordered Telegram sends/edits for dirty segment revisions
- creates a temporary initial Abort owner after extension binding and callback subscription, immediately before prompting
- lets the first visible activity, assistant, or legacy tool output adopt that message ID
- retains attach-before-detach migration of the single Abort keyboard to later output messages
- native `typing` refreshes throughout the prompt, stopping only when the run settles
- deletes an unused status on silent success or edits it on early failure
- drains delivery before cleanup, then performs Abort cleanup and response/error finalization

The segment worker owns every activity/assistant send and edit plus Abort migration, so the first visible activity, assistant, or legacy tool output adopts the temporary Working message in place and normal output does not gain a separate status row. Activity and assistant segments remain chronological; adjacent events of one kind continue the open message, while a kind switch starts a new message. The Abort button follows newer output messages until the run settles, and `/abort` remains available as a fallback. On silent success the unused temporary status is deleted; on early abort or failure it is edited into the terminal status. The worker drains all pending revisions before controls are cleared, and typing stops only after settlement.

### `src/pi-session.ts`
`PiSessionService.steer()` forwards ordinary follow-on text to the active SDK `AgentSession.steer()` queue. Steering uses the active queue and does not create a second prompt handler or prompt flow.

### `src/bot.ts`
The bot decides whether a message can steer before handing it to the prompt handler: ordinary text is eligible only when local chat/topic busy state is clear and the mapped Pi session reports streaming; media and slash commands are excluded. Topic/session-name synchronization remains bidirectional and scoped to the active chat/topic mapping.

### `src/bot/commands/*`
Grouped command handlers split by concern:
- `basic.ts` — `/start`, `/help`, `/commands`, `/abort`, `/session`, `/retry`, `/activity`
- `sessions.ts` — `/sessions`, `/switch`, `/new`, `/handback`
- `model.ts` — `/model` and model picker rendering
- `tree.ts` — `/tree`, `/branch`, `/label`

## Install module layout

### `src/install.ts`
Public facade for install/setup/status APIs used by `src/cli.ts`.

### `src/install/config.ts`
Config-file setup helpers for:
- reading/updating `.env`-style config files
- placeholder handling
- interactive prompts
- required setup value validation

### `src/install/extension.ts`
Installed extension management for:
- installing the TelePi handoff extension
- detecting symlink vs copy vs custom file states

### `src/install/launchd.ts`
launchd/plist helpers for:
- generating the LaunchAgent plist
- reading launchd environment/config state
- reconciling the loaded LaunchAgent via `launchctl`
- reporting install/runtime launchd status

### `src/install/shared.ts`
Shared install types and constants used across install modules.

## Testing layout

### Integration-heavy suites
- `test/bot.test.ts`
- `test/install.test.ts`
- `test/pi-session.test.ts`

These keep behavior-level regressions in check.

### Focused unit suites
- `test/bot/message-rendering.test.ts`
- `test/bot/telegram-transport.test.ts`
- `test/bot/slash-command.test.ts`
- `test/bot/keyboard.test.ts`
- `test/bot/extension-dialogs.test.ts`
- `test/bot/chat-state.test.ts`
- `test/bot/stream-segments.test.ts`

These support low-risk refactors of isolated helpers/subsystems.

## Remaining large modules

The main remaining hotspots are:
- `src/bot.ts` — still the central orchestration/callback registration layer
- `src/pi-session.ts` — session/service/registry/runtime path concerns in one large module
- `test/bot.test.ts` — large integration suite that could eventually be split by feature area

Those are the next likely candidates if more structural cleanup is needed.
