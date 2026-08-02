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
  ├─ prompt execution (`src/bot/prompt-handler.ts`)
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

### `src/bot/extension-dialogs.ts`
Telegram-backed extension UI dialog lifecycle for:
- select dialogs
- confirm dialogs
- input dialogs
- timeout/cancel/finalization behavior

### `src/bot/prompt-handler.ts`
Owns the prompt execution lifecycle:
- busy checks
- session bootstrap
- extension binding
- text streaming + debounced edits
- tool status rendering
- final response/error finalization
- delivering the per-prompt activity transcript separately from the final assistant output

### `src/bot/commands/*`
Grouped command handlers split by concern:
- `basic.ts` — `/start`, `/help`, `/commands`, `/abort`, `/session`, `/retry`
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

These support low-risk refactors of isolated helpers/subsystems.

## Remaining large modules

The main remaining hotspots are:
- `src/bot.ts` — still the central orchestration/callback registration layer
- `src/pi-session.ts` — session/service/registry/runtime path concerns in one large module
- `test/bot.test.ts` — large integration suite that could eventually be split by feature area

Those are the next likely candidates if more structural cleanup is needed.
