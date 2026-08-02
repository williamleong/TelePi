# Two-Way Telegram Topic and Session Name Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename an existing topic-scoped Pi session when an allowlisted Telegram user renames its forum topic.

**Architecture:** Add a transport-neutral `PiSessionService.setSessionName()` boundary, then special-case Telegram `forum_topic_edited` service messages before the existing generic service-message ignore path. The bot reads only an existing topic session and never creates one for a rename.

**Tech Stack:** TypeScript, grammY, Pi SDK AgentSession API, Vitest.

## Global Constraints

- Preserve the existing Pi-session-to-Telegram-topic synchronization path.
- Process inbound names only from allowlisted Telegram users.
- Never call `getOrCreate()` because of a topic edit.
- Ignore missing sessions, missing thread IDs, icon-only edits, empty names, and same-name edits.
- Keep all other Telegram forum service messages ignored.
- Log rename failures without replying to the service message.
- Add no dependencies or persistent topic-to-session mapping.

---

### Task 1: Add inbound topic-name synchronization

**Files:**
- Modify: `src/pi-session.ts:680-715`
- Modify: `src/bot.ts:80-145,585-589`
- Modify: `test/pi-session.test.ts:1995-2040`
- Modify: `test/bot.test.ts:187-365,1019-1035`

**Interfaces:**
- Consumes: Pi SDK `AgentSession.setSessionName(name: string): void`, `sessionRegistry.get(target)`, and Telegram `forum_topic_edited.name`.
- Produces: `PiSessionService.setSessionName(name: string): void` and an inbound topic-edit synchronization branch in `createBot()`.

- [ ] **Step 1: Write the failing Pi-session delegation test**

Add `setSessionName: vi.fn()` to the AgentSession fake created in `test/pi-session.test.ts`, then add:

```typescript
it("renames the active Pi session", async () => {
  const service = await PiSessionService.create(createConfig());
  const currentSession = mockState.createdSessions[0]?.session;

  service.setSessionName("Project kickoff");

  expect(currentSession.setSessionName).toHaveBeenCalledWith("Project kickoff");
});
```

The production mutation this catches is removing or misrouting the service-to-AgentSession name write.

- [ ] **Step 2: Run the delegation test and verify RED**

Run:

```bash
npm test -- test/pi-session.test.ts -t "renames the active Pi session"
```

Expected: FAIL because `PiSessionService.setSessionName()` does not exist.

- [ ] **Step 3: Add the minimal service boundary**

Add beside `prompt()` in `PiSessionService`:

```typescript
setSessionName(name: string): void {
  this.getSession().setSessionName(name);
}
```

This delegates persistence and `session_info_changed` emission to Pi.

- [ ] **Step 4: Run the delegation test and verify GREEN**

Run:

```bash
npm test -- test/pi-session.test.ts -t "renames the active Pi session"
```

Expected: PASS.

- [ ] **Step 5: Extend the bot test double and write the failing success test**

Add this method to the fake returned by `createMockPiSession()`:

```typescript
setSessionName: vi.fn(),
```

Replace the current broad topic-service test with a focused test group. The first test must create an existing topic session through the registry harness, reset the creation spy, submit a real grammY update, and assert the session write:

```typescript
it("renames an existing topic session when an allowed user renames the topic", async () => {
  const { bot, api, registry } = setupBot();
  const target = { chatId: ALLOWED_CHAT_ID, messageThreadId: 777 };
  await registry.registry.getOrCreate(target);
  const topicSession = registry.getSession(ALLOWED_CHAT_ID, 777)!;
  registry.registry.getOrCreate.mockClear();

  await bot.handleUpdate(createTestUpdate({
    message: {
      text: undefined,
      entities: undefined,
      chat: { id: ALLOWED_CHAT_ID, type: "supergroup", is_forum: true },
      from: { id: ALLOWED_USER_ID, is_bot: false, first_name: "Test" },
      message_thread_id: 777,
      forum_topic_edited: { name: "Project kickoff" },
    },
  }));

  expect(topicSession.service.setSessionName).toHaveBeenCalledWith("Project kickoff");
  expect(registry.registry.getOrCreate).not.toHaveBeenCalled();
  expect(api.sendMessage).not.toHaveBeenCalled();
});
```

If the returned setup object does not expose `registry`, add it without changing the registry's production behavior.

- [ ] **Step 6: Write failing guard tests**

Add separate tests using the same update shape and literal expectations:

1. No pre-created topic session: assert `getOrCreate` and `sendMessage` are not called and `registry.getSession(ALLOWED_CHAT_ID, 778)` remains undefined.
2. Existing session with `getInfo()` returning `sessionName: "Project kickoff"`: assert `setSessionName` is not called.
3. Existing session but `from.id: 999`: assert `setSessionName` and `sendMessage` are not called.
4. Existing session with `forum_topic_edited: { icon_custom_emoji_id: "emoji-1" }`: assert `setSessionName` is not called.
5. Existing session with `forum_topic_edited: { name: "" }`: assert `setSessionName` is not called.
6. A `forum_topic_closed` service message: assert no session write and no Telegram reply, preserving the existing behavior.

These tests catch missing authorization, accidental session creation, redundant writes, and over-broad service-message handling.

- [ ] **Step 7: Run the topic-edit tests and verify RED**

Run:

```bash
npm test -- test/bot.test.ts -t "topic session|topic edit|forum-topic service"
```

Expected: the success test FAILS because topic-edit service messages are still ignored; the guard tests pass or fail only where their missing branches require implementation.

- [ ] **Step 8: Implement the minimal inbound synchronization branch**

Add a narrow extractor near `isForumTopicServiceMessage()`:

```typescript
function getEditedForumTopicName(ctx: Context): string | undefined {
  const message = ctx.message as Record<string, unknown> | undefined;
  const edit = message?.forum_topic_edited;
  if (!edit || typeof edit !== "object") {
    return undefined;
  }

  const name = (edit as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}
```

Inside `createBot()`, add this function beside `getExistingSession()`:

```typescript
const syncEditedForumTopicToSession = (ctx: Context): void => {
  const name = getEditedForumTopicName(ctx);
  const target = getRawTelegramTarget(ctx);
  if (!name || target?.messageThreadId === undefined) {
    return;
  }

  const session = getExistingSession(target);
  if (!session || session.getInfo().sessionName === name) {
    return;
  }

  try {
    session.setSessionName(name);
  } catch (error) {
    console.error("Failed to rename Pi session from Telegram forum topic:", formatError(error));
  }
};
```

Update the service-message middleware without weakening authorization for ordinary messages:

```typescript
bot.use(async (ctx, next) => {
  if (isForumTopicServiceMessage(ctx)) {
    const fromId = ctx.from?.id;
    if (fromId && config.telegramAllowedUserIdSet.has(fromId)) {
      syncEditedForumTopicToSession(ctx);
    }
    return;
  }

  const fromId = ctx.from?.id;
  // existing authorization and callback logic continues unchanged
```

Do not normalize the inbound name or call `getOrCreate()`.

- [ ] **Step 9: Run focused tests and verify GREEN**

Run:

```bash
npm test -- test/pi-session.test.ts -t "renames the active Pi session"
npm test -- test/bot.test.ts -t "topic session|topic edit|forum-topic service"
npm run build
```

Expected: all focused tests pass and TypeScript compiles.

- [ ] **Step 10: Commit the implementation**

```bash
git add src/pi-session.ts src/bot.ts test/pi-session.test.ts test/bot.test.ts
git commit -m "feat: sync Telegram topic names to sessions"
```

---

### Task 2: Document and verify two-way synchronization

**Files:**
- Modify: `README.md:50-70,210-220`

**Interfaces:**
- Consumes: completed behavior from Task 1.
- Produces: user-facing documentation for synchronization and its no-active-session rule.

- [ ] **Step 1: Update README behavior documentation**

Extend the per-chat/topic feature description with this concise behavior:

```markdown
- **Two-way topic naming**: Renaming an active Pi session renames its Telegram forum topic, and an allowlisted Telegram topic rename updates the active mapped session. Topic renames do not create sessions when no active mapping exists.
```

Keep the nearby session-isolation explanation consistent. Do not claim mappings survive restarts.

- [ ] **Step 2: Run complete verification**

Run:

```bash
npm test
npm run build
npm run test:coverage
git diff --check
git status --short
```

Expected: all tests pass, TypeScript compiles, coverage meets repository thresholds, `git diff --check` prints nothing, and only the intended README change remains uncommitted.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain two-way topic name sync"
```
