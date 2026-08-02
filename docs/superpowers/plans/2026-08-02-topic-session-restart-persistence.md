# Telegram Topic Session Restart Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore each Telegram chat or topic's most recently active Pi session after a TelePi process restart.

**Architecture:** A focused `TopicSessionStore` owns a versioned, atomically written JSON state file. `PiSessionRegistry` lazily resolves a context through an explicit bootstrap, then persisted state, then fresh-session creation; `PiSessionService` reports successful runtime replacements so the registry keeps the stored path current.

**Tech Stack:** TypeScript 5.7, Node.js 22 filesystem APIs, Vitest 3, Pi coding-agent session runtime.

## Global Constraints

- Do not persist bot tokens or message contents.
- Persistence failures must warn but must not prevent TelePi from serving messages.
- Missing saved Pi session files must be removed from state rather than opened as empty histories.
- Explicit `PI_SESSION_PATH` bootstrap retains precedence over persisted topic state.
- Ordinary registry disposal retains mappings; intentional removal and handback delete them.
- State writes must use a temporary file followed by atomic rename.
- Do not infer mappings for sessions created before this feature.

---

## File Structure

- Create `src/topic-session-store.ts`: validate, read, mutate, and atomically persist context-to-session records.
- Create `test/topic-session-store.test.ts`: isolated filesystem tests for state shape and failure handling.
- Modify `src/paths.ts`: expose platform-aware state-directory and state-file helpers.
- Modify `test/config.test.ts`: cover state path policy alongside existing path/config tests.
- Modify `src/pi-session.ts`: restore records and report session lifecycle changes.
- Modify `test/pi-session.test.ts`: cover restart recovery, precedence, staleness, and lifecycle updates.
- Modify `src/index.ts`: create the disk-backed store for the production registry.
- Modify `README.md`: document restart restoration and stale-session fallback.

### Task 1: Platform Paths and Atomic Topic Session Store

**Files:**
- Create: `src/topic-session-store.ts`
- Create: `test/topic-session-store.test.ts`
- Modify: `src/paths.ts`
- Modify: `test/config.test.ts`

**Interfaces:**
- Produces: `TopicSessionRecord = { sessionFile: string; workspace: string }`
- Produces: `TopicSessionStore.open(filePath: string): TopicSessionStore`
- Produces: `TopicSessionStore.memory(): TopicSessionStore`
- Produces: `get(key: string): TopicSessionRecord | undefined`, `set(key, record): void`, and `delete(key): void`
- Produces: `getDefaultTelePiStateDir(homeDirectory?, platform?, xdgStateHome?): string`
- Produces: `getDefaultTopicSessionStatePath(...): string`

- [ ] **Step 1: Write failing path and persistence tests**

Cover exact platform paths and a real temporary state file:

```ts
it("uses XDG state storage on Linux", () => {
  expect(getDefaultTelePiStateDir("/home/test", "linux", "/state")).toBe("/state/telepi");
  expect(getDefaultTelePiStateDir("/home/test", "linux")).toBe("/home/test/.local/state/telepi");
});

it("uses Application Support on macOS", () => {
  expect(getDefaultTelePiStateDir("/Users/test", "darwin")).toBe(
    "/Users/test/Library/Application Support/TelePi",
  );
});

it("persists and reloads versioned topic records", () => {
  const statePath = path.join(tempDir, "topic-sessions.json");
  const store = TopicSessionStore.open(statePath);
  store.set("123::77", { sessionFile: "/sessions/a.jsonl", workspace: "/workspace/a" });

  expect(TopicSessionStore.open(statePath).get("123::77")).toEqual({
    sessionFile: "/sessions/a.jsonl",
    workspace: "/workspace/a",
  });
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
    version: 1,
    topics: {
      "123::77": { sessionFile: "/sessions/a.jsonl", workspace: "/workspace/a" },
    },
  });
});
```

Also test delete persistence, malformed JSON degrading to empty state with `console.warn`, invalid record fields being ignored, and `memory()` performing no filesystem write.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run test/topic-session-store.test.ts test/config.test.ts`

Expected: FAIL because the new store and path exports do not exist.

- [ ] **Step 3: Implement path helpers and the minimal store**

Use a versioned internal shape and synchronous mutation because the state is tiny and every successful method must be durable before returning:

```ts
export interface TopicSessionRecord {
  sessionFile: string;
  workspace: string;
}

interface TopicSessionState {
  version: 1;
  topics: Record<string, TopicSessionRecord>;
}

export class TopicSessionStore {
  static open(filePath: string): TopicSessionStore;
  static memory(): TopicSessionStore;
  get(key: string): TopicSessionRecord | undefined;
  set(key: string, record: TopicSessionRecord): void;
  delete(key: string): void;
}
```

Validate `version === 1`, a plain-object `topics`, and non-empty string fields. For disk writes, call `mkdirSync(dirname, { recursive: true, mode: 0o700 })`, write `${filePath}.${process.pid}.tmp` with mode `0o600`, then `renameSync`. Catch read/write errors, warn with the state path, retain valid in-memory state, and clean up the exact temp path with `rmSync(tempPath, { force: true })`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run test/topic-session-store.test.ts test/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the store**

```bash
git add src/topic-session-store.ts src/paths.ts test/topic-session-store.test.ts test/config.test.ts
git commit -m "feat: persist Telegram topic session records"
```

### Task 2: Restore Persisted Sessions Through the Registry

**Files:**
- Modify: `src/pi-session.ts:1267-1384`
- Modify: `test/pi-session.test.ts:2148-2249`

**Interfaces:**
- Consumes: `TopicSessionStore`, `TopicSessionRecord`
- Produces: `PiSessionRegistry.create(config, topicSessionStore?): Promise<PiSessionRegistry>`
- Produces: lazy startup precedence `bootstrap -> valid stored record -> new session`

- [ ] **Step 1: Write failing restart and precedence tests**

Use a temporary real session file and `TopicSessionStore.memory()`:

```ts
it("restores a topic session after recreating the registry", async () => {
  const sessionFile = path.join(tempDir, "saved.jsonl");
  writeFileSync(sessionFile, "{}\n");
  const store = TopicSessionStore.memory();
  store.set("1::99", { sessionFile, workspace: "/workspace/saved" });

  const registry = await PiSessionRegistry.create(createConfig(), store);
  await registry.getOrCreate({ chatId: 1, messageThreadId: 99 });

  expect(mockState.SessionManager.open).toHaveBeenCalledWith(
    sessionFile,
    undefined,
    "/workspace/saved",
  );
});
```

Add tests proving another topic calls `SessionManager.create`, an explicit bootstrap overrides and replaces a stored record, a missing saved file deletes only that record and creates a fresh session, and `dispose()` leaves the record intact.

- [ ] **Step 2: Run focused registry tests and verify RED**

Run: `npx vitest run test/pi-session.test.ts -t "registry|restores|bootstrap|missing saved"`

Expected: FAIL because the registry does not consume persisted records.

- [ ] **Step 3: Implement lazy restoration**

Add an optional store dependency that defaults to `TopicSessionStore.memory()` so unit callers cannot touch the user's real state. Change service configuration to be context-aware:

```ts
private createServiceConfig(key: string): TelePiConfig {
  const bootstrapPath = this.consumeBootstrapSessionPath();
  if (bootstrapPath) {
    return { ...this.config, piSessionPath: bootstrapPath };
  }

  const saved = this.topicSessionStore.get(key);
  if (!saved) return { ...this.config, piSessionPath: undefined };
  if (!existsSync(saved.sessionFile)) {
    console.warn(`Saved Pi session for Telegram context ${key} no longer exists; starting a new session.`);
    this.topicSessionStore.delete(key);
    return { ...this.config, piSessionPath: undefined };
  }

  return { ...this.config, workspace: saved.workspace, piSessionPath: saved.sessionFile };
}
```

After the generation check and `services.set`, persist `service.getInfo().sessionFile` and workspace. Never persist an undefined path.

- [ ] **Step 4: Run focused registry tests and verify GREEN**

Run: `npx vitest run test/pi-session.test.ts -t "registry|restores|bootstrap|missing saved"`

Expected: PASS.

- [ ] **Step 5: Commit registry restoration**

```bash
git add src/pi-session.ts test/pi-session.test.ts
git commit -m "feat: restore topic sessions after restart"
```

### Task 3: Track Session Replacement and Intentional Removal

**Files:**
- Modify: `src/pi-session.ts:620-1264,1271-1384`
- Modify: `test/pi-session.test.ts`

**Interfaces:**
- Produces: optional `PiSessionService.create(config, onSessionChange?)` callback
- Callback value: `{ sessionFile?: string; workspace: string }`
- Registry behavior: set when `sessionFile` exists; delete when it is undefined

- [ ] **Step 1: Write failing lifecycle tests**

Create a registry with a memory store, obtain a topic service, and assert the store after each operation. Cover:

```ts
await service.newSession();
expect(store.get(key)?.sessionFile).toBe(service.getInfo().sessionFile);

await service.switchSession("/sessions/s2.jsonl");
expect(store.get(key)?.sessionFile).toBe("/sessions/s2.jsonl");

await service.fork("entry-1");
expect(store.get(key)?.sessionFile).toBe(service.getInfo().sessionFile);

registry.remove(context);
expect(store.get(key)).toBeUndefined();
```

Add a direct successful `handback()` assertion that clears the record through the callback. Preserve existing concurrent `getOrCreate()` generation tests.

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run: `npx vitest run test/pi-session.test.ts -t "persists|removes|handback|new session|switch|fork"`

Expected: FAIL because replacements do not notify the registry.

- [ ] **Step 3: Add the narrow lifecycle callback**

Store the callback on `PiSessionService`. Invoke it only after successful active-handle replacement/rebinding in `newSession`, `switchSession`, and `fork`, and after successful handle clearing in `handback`. Do not invoke it from `dispose()`.

In `PiSessionRegistry.getOrCreate()`, bind a key-specific callback:

```ts
const onSessionChange = ({ sessionFile, workspace }: PiSessionLocation) => {
  if (sessionFile) {
    this.topicSessionStore.set(key, { sessionFile, workspace });
  } else {
    this.topicSessionStore.delete(key);
  }
};
```

Make `remove()` delete the persisted key even when no in-memory service exists. Ensure cancelled runtime operations retain the current mapping rather than replacing or deleting it.

- [ ] **Step 4: Run all Pi session tests and verify GREEN**

Run: `npx vitest run test/pi-session.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit lifecycle tracking**

```bash
git add src/pi-session.ts test/pi-session.test.ts
git commit -m "feat: track active session changes by topic"
```

### Task 4: Production Wiring, Documentation, and Full Verification

**Files:**
- Modify: `src/index.ts:1-30`
- Modify: `README.md` per-topic session documentation
- Test: `test/topic-session-store.test.ts`
- Test: complete test suite

**Interfaces:**
- Consumes: `TopicSessionStore.open(getDefaultTopicSessionStatePath())`
- Produces: production disk persistence across process recreation

- [ ] **Step 1: Write a failing production-wiring test or export a focused factory**

Avoid starting Telegram polling. Extract or export a narrow helper if needed:

```ts
export function createTopicSessionStore(): TopicSessionStore {
  return TopicSessionStore.open(getDefaultTopicSessionStatePath());
}
```

Test that the helper returns a disk-backed store at the default path by mocking only the path/store boundary. If extraction would add needless API surface, verify wiring through module mocks in the existing entrypoint test.

- [ ] **Step 2: Run the wiring test and verify RED**

Run: `npx vitest run test/entrypoint.test.ts test/topic-session-store.test.ts`

Expected: FAIL because `startBot()` still creates an in-memory-only registry.

- [ ] **Step 3: Wire production and update README**

Create one disk-backed store during startup and pass it to the registry:

```ts
const topicSessionStore = TopicSessionStore.open(getDefaultTopicSessionStatePath());
sessionRegistry = await PiSessionRegistry.create(config, topicSessionStore);
```

Document that existing topics resume their last active Pi session after a restart, `/handback` forgets the association, and a missing saved JSONL session causes a new session.

- [ ] **Step 4: Run formatting checks, build, and complete tests**

Run:

```bash
git diff --check
npm run build
npm test
```

Expected: TypeScript build succeeds and all tests pass.

- [ ] **Step 5: Commit production wiring and docs**

```bash
git add src/index.ts README.md test/entrypoint.test.ts test/topic-session-store.test.ts
git commit -m "docs: describe topic session restart recovery"
```

- [ ] **Step 6: Review the complete branch diff**

Run:

```bash
git status --short
git diff main...HEAD --stat
git diff --check main...HEAD
```

Expected: only the approved persistence design, implementation, tests, and documentation appear; no generated artifacts or dependency changes are included.
