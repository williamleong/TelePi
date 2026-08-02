# Upstream Fork Note Refresh Design

**Date:** 2026-08-02
**Status:** Approved

## Goal

Refresh the opening README note so it connects this fork to Pi's workflow-first philosophy and accurately summarizes the major improvements over upstream TelePi.

## Copy

Replace the existing note with:

```markdown
> [!NOTE]
> This is a personal-use fork of
> [benedict2310/TelePi](https://github.com/benedict2310/TelePi), developed
> in Pi’s spirit: adapt the tool to your workflow, not your workflow to the tool.
>
> Compared with upstream TelePi, this fork:
>
> - Tracks Pi SDK 0.83.0, including updated session APIs and cross-process
>   credential reloading.
> - Keeps Telegram chats and forum topics in independent Pi sessions, persists
>   their mappings across restarts, and safely recovers missing or invalid sessions.
> - Streams assistant responses, thinking, tool activity, and Agent progress
>   chronologically with richer Telegram formatting.
> - Supports steering active Pi runs and provides immediate, run-scoped Abort
>   controls that cannot cancel a later task.
> - Exposes Pi commands, prompt templates, skills, and compatible extension
>   commands through Telegram’s command menu and picker.
> - Renders extension interactions as native Telegram select, confirm, and input
>   dialogs, including `ask_user` custom-UI fallbacks.
> - Synchronizes Pi session names with Telegram forum-topic names and shows recent
>   conversation context when resuming.
> - Hardens prompt delivery, callbacks, Unicode chunking, downloads, handoff,
>   persistence, and Linux service packaging.
```

## Rationale

The opening sentence echoes Pi's documented principle—adapt Pi to the workflow rather than forcing the workflow around the tool—without implying endorsement by Pi's maintainers. The bullets group user-visible capabilities rather than listing individual commits.

## Constraints

- Keep the upstream project link.
- Retain the `NOTE` callout at the top of the README.
- Describe only implemented behavior.
- Keep the note concise enough to scan before the main product description.
- Do not change installation, usage, or command documentation.

## Verification

- Compare every bullet against current production code and tests.
- Confirm Markdown wrapping and callout formatting.
- Run `npm test` and `npm run build` before integration.
