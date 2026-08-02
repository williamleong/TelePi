# Immediate Abort Control: Final Fix Report

## Scope

Applied the final-review wave for the immediate Telegram Abort control. The patch changes the prompt activation ordering and the fallback ownership path for legacy activity-off tool messages.

## RED evidence

Before the implementation change, the focused suite had 3 expected failures:

1. `keeps Abort hidden until extension binding succeeds, then publishes it before prompting` found `<i>⏳ Working…</i>` with Abort while deferred extension binding was still pending.
2. `puts Abort on the initial activity-off all tool output when Working delivery fails` found the first tool send (`messageId: 2`) with `hasAbort: false`.
3. `puts Abort on the initial activity-off errors-only tool output when Working delivery fails` found the first error-tool send (`messageId: 2`) with `hasAbort: false`.

Command and result:

```text
npm test -- --run test/bot/prompt-handler.test.ts
53 tests: 50 passed, 3 failed
```

The failures exercised visible Telegram behavior, including the send payload and no follow-up Abort markup attach, rather than mocking private implementation functions.

## GREEN implementation

- `src/bot/prompt-handler.ts`
  - Binds extensions and installs Pi callbacks before calling `ensureWorkingMessage()`; the temporary Working/Abort message is now sent immediately before `piSession.prompt()`.
  - Keeps typing active from the start of the flow, including while extension binding is deferred.
  - Adds `sendLegacyOutput()`: when no Abort owner exists, its initial tool send includes `abortKeyboard`, then records the owner and forum callback routing immediately. When an owner already exists, it retains attach-before-detach migration.
  - Uses the helper for activity-off `all` tool-start output and `errors-only` tool-error output.

- `test/bot/prompt-handler.test.ts`
  - Adds a deferred-binding regression proving no Working/Abort message is sent during binding and that Working/Abort exists before `prompt()` executes.
  - Adds `all` and `errors-only` Working-send-failure regressions proving the first legacy tool send includes Abort, records callback ownership, and needs no Abort attach markup edit.
  - Updates binding/subscription failure expectations: the existing terminal failure reply and typing cleanup remain, without publishing a cancel control before setup succeeds.

- `README.md` and `docs/architecture.md`
  - Correct the lifecycle wording to state that Working/Abort is created after extension binding and subscription, immediately before prompting.

## GREEN verification

```text
npm test -- --run test/bot/prompt-handler.test.ts  # 53 passed
npm test -- --run test/bot.test.ts                 # 146 passed
npm run build                                      # tsc succeeded
npm test                                            # 37 files, 597 tests passed
```

The bot-focused and full-suite output contains pre-existing expected stderr from tests that deliberately exercise Telegram formatting, topic-rename, and stale-callback error handling; no test failed.

## Self-review

- Confirmed the temporary control cannot exist while `bindExtensions()` is pending and cannot be published before subscription succeeds.
- Confirmed direct legacy sends acquire Abort in the send request when no owner exists, so a failed later markup attach cannot remove the only inline control.
- Confirmed migration is used only when a prior owner exists; attach-before-detach behavior remains unchanged in that branch.
- Confirmed `git diff --check` reports no whitespace errors.

## Concerns

None. The remaining limitation is intentional: if the Telegram Working send itself fails, the fallback tool/assistant output is the first opportunity to show an inline Abort control; `/abort` remains available throughout.

## Commit

`fix: close Telegram abort timing gaps` (the commit hash is reported by the execution result because a Git commit cannot contain its own final object hash).
