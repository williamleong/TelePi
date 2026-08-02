# Telegram Stream UX and Steering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove routine Working/Done messages, compact thinking/tool activity, and route same-context follow-on text to Pi's native steering queue.

**Architecture:** Keep the existing chronological segment worker as the sole output pipeline. Successful runs rely on Telegram typing before the first segment, attach Abort when the first output message is delivered, and perform keyboard-only cleanup at settlement. Add a narrow `PiSessionService.steer(text)` boundary and let the prompt handler accept steering only through a context-aware callback supplied by `bot.ts`; never start a second prompt flow.

**Tech Stack:** TypeScript, Node.js, grammY, Pi AgentSession SDK, Vitest.

## Global Constraints

- Successful runs send no `Working…` or `Done` message.
- Native typing remains active until prompt settlement.
- Before first output, `/abort` is the cancellation path; the first output message receives the Abort keyboard.
- Failure and abort notices remain visible.
- Only ordinary text may steer; images, voice, slash commands, dialogs, and prompt-inbox files retain current behavior.
- Steering must reuse the active prompt subscription and chronological delivery worker.
- Preserve `/activity`, every `TOOL_VERBOSITY` mode, topic isolation, callback routing, and topic-name synchronization.
- Add no dependencies or configuration options.

---

### Task 1: Compact activity rendering

**Files:**
- Modify: `src/bot/activity-rendering.ts:74-185`
- Test: `test/bot/activity-rendering.test.ts`

**Interfaces:**
- Consumes: existing `ActivityTranscript` and `renderActivityTranscript(transcript): RenderedChunk[]`.
- Produces: the same renderer API with plain thinking headings, trailing-whitespace normalization, and a one-newline block separator.

- [ ] **Step 1: Add exact failing formatting tests**

Add a test that renders thinking with trailing blank lines followed by Bash and asserts exact HTML and fallback text:

```ts
const transcript = createActivityTranscript();
transcript.appendThinking({ text: "Inspecting state\n\n" });
transcript.startTool("bash", "tool-1", { command: "npm test" });

expect(renderActivityTranscript(transcript)).toEqual([{
  text: "🧠 Thinking\nInspecting state\n<b>• ⌨️ Bash</b>\n<code>npm test</code>",
  fallbackText: "🧠 Thinking\nInspecting state\n• ⌨️ Bash\nnpm test",
  parseMode: "HTML",
  sourceText: "🧠 Thinking\nInspecting state\n• ⌨️ Bash\nnpm test",
}]);
```

Add a rollover assertion that `🧠 Thinking (continued)` is not wrapped in `<b>` and every rendered chunk stays within Telegram's limit.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- test/bot/activity-rendering.test.ts
```

Expected: the exact formatting test fails because the current renderer uses bold headings, preserves trailing newlines, and inserts `\n\n` between blocks.

- [ ] **Step 3: Implement compact rendering**

Change the block separator and thinking rendering:

```ts
const separator = current ? "\n" : "";

function renderThinkingBlock(text: string, continued: boolean): ActivityBlock {
  const header = continued ? "🧠 Thinking (continued)" : "🧠 Thinking";
  const normalizedText = text.trimEnd();
  return {
    html: normalizedText ? `${header}\n${escapeHTML(normalizedText)}` : header,
    fallback: normalizedText ? `${header}\n${normalizedText}` : header,
  };
}
```

Ensure the split path cannot stall when a fragment contains only trailing whitespace. Normalize thinking text once before prefix splitting, and emit a heading-only block when the normalized text is empty.

- [ ] **Step 4: Run focused rendering tests**

Run:

```bash
npm test -- test/bot/activity-rendering.test.ts test/bot/stream-segments.test.ts
npm run build
```

Expected: PASS; existing activity ordering and chunking remain intact.

- [ ] **Step 5: Commit**

```bash
git add src/bot/activity-rendering.ts test/bot/activity-rendering.test.ts
git commit -m "fix: compact Telegram activity formatting"
```

---

### Task 2: Remove successful-run status messages

**Files:**
- Modify: `src/bot/prompt-handler.ts:90-530`
- Test: `test/bot/prompt-handler.test.ts`
- Test: `test/bot.test.ts`

**Interfaces:**
- Consumes: existing chronological delivery queue, `migrateAbortOwner(messageId)`, `cleanupAbortOwners()`, and typing lifecycle.
- Produces: no routine status message; first delivered output owns Abort; failures use a standalone explicit notice.

- [ ] **Step 1: Rewrite status lifecycle tests to RED**

Update the success-path harness assertions:

```ts
expect(sendMessageCalls.some((call) => call.text.includes("Working"))).toBe(false);
expect(sendMessageCalls.some((call) => call.text.includes("Done"))).toBe(false);
expect(editTextCalls.some((call) => call.text.includes("Done"))).toBe(false);
expect(firstOutputSend.options.reply_markup).toEqual(abortKeyboardShape);
expect(clearMarkupCalls.at(-1)?.messageId).toBe(firstOutputMessageId);
```

Cover:

- activity-first and assistant-first runs;
- silent success sends no message;
- typing starts before `prompt()` and stops only after settlement;
- `/abort` still calls the active session before any output;
- attach failure does not fail output;
- success removes every historical keyboard without a final text edit;
- bind, subscribe, prompt, delivery, and abort failures still send one visible notice.

At bot level, replace `Working → Done` expectations with no status message and verify the first chronological output owns the callback context.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- test/bot/prompt-handler.test.ts -t "status|silent|Abort owner|typing lifetime|failure"
npm test -- test/bot.test.ts -t "chronological|silent|abort|failure"
```

Expected: failures show the current `Working…` send and `Done` edit.

- [ ] **Step 3: Remove status creation and attach Abort on first output**

Delete `ensureWorkingMessage()`, `workingMessagePromise`, `statusMessageId`, and successful `updateStatus()` usage. Start typing before session activation as today, but do not send a Telegram message.

When sending a new segment chunk, attach Abort directly to the first new output message when no owner exists:

```ts
const message = await sendTextMessage(bot.api, target, rendered.text, {
  parseMode: rendered.parseMode,
  fallbackText: rendered.fallbackText,
  delivery: rendered.delivery,
  replyMarkup: abortOwnerMessageId === undefined ? abortKeyboard : undefined,
});
if (abortOwnerMessageId === undefined) {
  abortOwnerMessageId = message.message_id;
  abortOwnerMessageIds.add(message.message_id);
  trackCallbackMessage?.(target, message.message_id);
}
```

For later output, retain attach-before-detach migration. Avoid immediately editing the same first message to attach the keyboard twice.

Make successful finalization:

```ts
deliveryFinalizing = true;
appendToolSummary();
await drainDelivery();
await cleanupAbortOwners();
deliveryFinalized = true;
stopTyping();
```

Make failure finalization render a standalone notice with `safeReply()` after draining deliverable output, then clean keyboards and typing. Preserve the existing failure text from `renderPromptFailure()`.

- [ ] **Step 4: Run lifecycle and integration tests**

Run:

```bash
npm test -- test/bot/prompt-handler.test.ts test/bot.test.ts
npm run build
```

Expected: PASS with no Working/Done operations and unchanged failure visibility.

- [ ] **Step 5: Commit**

```bash
git add src/bot/prompt-handler.ts test/bot/prompt-handler.test.ts test/bot.test.ts
git commit -m "feat: remove Telegram prompt status messages"
```

---

### Task 3: Add native text steering

**Files:**
- Modify: `src/pi-session.ts:604-705`
- Modify: `src/bot/prompt-handler.ts:32-770`
- Modify: `src/bot.ts:530-690,1400-1520`
- Test: `test/pi-session.test.ts`
- Test: `test/bot/prompt-handler.test.ts`
- Test: `test/bot.test.ts`

**Interfaces:**
- Produces: `PiSessionService.steer(text: string): Promise<void>`.
- Produces: prompt-handler dependency `trySteer(target: PiSessionContext, text: string): Promise<boolean>`; `true` means accepted, `false` means this busy state is not steerable. The handler calls it only when `preloadedSlashCommands === undefined` and no images are present.
- Consumes: `chatState.isLocallyBusy(target)`, `getExistingSession(target)`, and `PiSessionService.isStreaming()`.

- [ ] **Step 1: Add failing Pi service steering tests**

Mock `AgentSession.steer` and assert:

```ts
await service.steer("focus on the race");
expect(agentSession.steer).toHaveBeenCalledWith("focus on the race");
```

Add a rejection test asserting the public error includes `Pi session steering failed` and preserves the cause through the project's `wrapError()` pattern.

- [ ] **Step 2: Run the service test and verify RED**

Run:

```bash
npm test -- test/pi-session.test.ts -t "steer"
```

Expected: FAIL because `PiSessionService.steer` does not exist.

- [ ] **Step 3: Add the service boundary**

Add:

```ts
export async function steerSession(session: AgentSession, text: string): Promise<void> {
  try {
    await session.steer(text);
  } catch (error) {
    throw wrapError("Pi session steering failed", error);
  }
}

async steer(text: string): Promise<void> {
  await steerSession(this.getSession(), text);
}
```

Keep the method text-only. Do not accept images or streaming behavior options.

- [ ] **Step 4: Add failing prompt-handler steering tests**

Extend `CreatePromptHandlerOptions` with `trySteer`. Test both busy gates for ordinary text:

```ts
trySteer.mockResolvedValue(true);
expect(await handleUserPrompt(ctx, target, "check the logs")).toBe(true);
expect(trySteer).toHaveBeenCalledWith(target, "check the logs");
expect(sendBusyReply).not.toHaveBeenCalled();
expect(taskRunner.tryStartPrompt).not.toHaveBeenCalled();
```

For the reservation race, return `false` from the first `isBusy`, make `taskRunner.tryStartPrompt()` return `"busy"`, then assert the second `trySteer()` accepts the text.

Also test:

- `trySteer()` returns false: preserve `sendBusyReply()` and return false;
- `trySteer()` rejects: send a concise `Steering failed: …` error and do not start a second flow;
- accepted steering does not create a second subscription, status, typing interval, or task reservation;
- a busy Pi slash command (`preloadedSlashCommands` supplied) and an image-bearing prompt never call `trySteer()` and retain the busy reply.

- [ ] **Step 5: Implement steering at both busy gates**

Add a helper inside `createPromptHandler()`:

```ts
const acceptSteering = async (ctx: Context, target: PiSessionContext, text: string) => {
  try {
    return await trySteer(target, text);
  } catch (error) {
    const failure = renderPrefixedError("Steering failed", error);
    await safeReply(ctx, failure.text, {
      fallbackText: failure.fallbackText,
      parseMode: failure.parseMode,
    }, target);
    return true;
  }
};
```

Import `renderPrefixedError` from `./message-rendering.js`. Compute `const steerableInput = preloadedSlashCommands === undefined && (!images || images.length === 0)`. Before each `sendBusyReply()`, call `acceptSteering()` only when `steerableInput` is true. If it returns true, return true without invoking `runPromptFlow()`.

- [ ] **Step 6: Add failing bot-level eligibility and isolation tests**

Using real grammY updates and per-topic mocked sessions, assert:

1. same-topic streaming + plain text calls `piSession.steer(text)` and sends no busy reply;
2. topic A streaming does not steer text sent to topic B;
3. local busy state prevents steering and retains the busy reply;
4. extension input consumes text before steering;
5. slash commands, photos/documents, voice/audio, and prompt-inbox dispatch do not call steer;
6. after steering, later Pi deltas are delivered by the original chronological output flow;
7. steering rejection sends one error and leaves the active run intact.

- [ ] **Step 7: Provide the context-aware callback**

In `bot.ts`, wire:

```ts
trySteer: async (target, text) => {
  if (chatState.isLocallyBusy(target)) {
    return false;
  }
  const piSession = getExistingSession(target);
  if (!piSession?.isStreaming()) {
    return false;
  }
  await piSession.steer(text);
  return true;
},
```

Keep normal text routing through `handleUserPrompt()`. Do not alter media handlers or prompt-inbox `isBusy` behavior. Slash commands continue through their existing handlers and therefore retain busy behavior rather than steering.

- [ ] **Step 8: Run steering and regression tests**

Run:

```bash
npm test -- test/pi-session.test.ts test/bot/prompt-handler.test.ts test/bot.test.ts
npm run build
```

Expected: PASS; one active prompt flow handles both original and steered output.

- [ ] **Step 9: Commit**

```bash
git add src/pi-session.ts src/bot/prompt-handler.ts src/bot.ts test/pi-session.test.ts test/bot/prompt-handler.test.ts test/bot.test.ts
git commit -m "feat: steer active Pi runs from Telegram"
```

---

### Task 4: Update documentation and verify the release

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Documents the user-visible status, Abort, formatting, and steering semantics implemented by Tasks 1-3.

- [ ] **Step 1: Update user documentation**

In `README.md`, replace Working/Done lifecycle text with:

- typing is the pre-output progress signal;
- `/abort` works before output and the inline Abort button begins on first output;
- successful completion adds no status message;
- ordinary follow-on text during the same active run steers Pi;
- media and commands are not steering inputs.

Show the compact plain `🧠 Thinking` heading and single-newline transition to a tool row.

- [ ] **Step 2: Update architecture documentation**

In `docs/architecture.md`, document that:

- the segment worker owns all output and Abort migration;
- success finalization is keyboard/typing cleanup only;
- `PiSessionService.steer()` feeds the active SDK queue without a second prompt handler;
- `bot.ts` decides steering eligibility from local busy and per-context streaming state.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run build
npm run test:coverage
git diff --check
```

Expected: all tests pass, TypeScript builds, coverage remains above repository thresholds, and no whitespace errors appear.

- [ ] **Step 4: Check stale copy**

Run:

```bash
rg -n "Working…|✅ Done|Still working on previous message|Thinking</b>|Thinking\\n\\n" README.md docs src test
```

Expected: only intentional failure/busy compatibility tests or historical design documents match; current user documentation and success-path tests contain no stale lifecycle claims.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/architecture.md
git commit -m "docs: explain Telegram steering and compact streams"
```
