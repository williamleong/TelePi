# Pi SDK 0.83 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade TelePi's embedded runtime to Pi SDK 0.83.0 while preserving its complete Telegram and session-management behavior.

**Architecture:** Replace direct `AuthStorage` and `ModelRegistry.create()` construction with Pi 0.83's `ModelRuntime`. Isolate Pi's non-exported file credential store behind a reload-aware adapter, then continue using the `ModelRegistry` compatibility facade exposed by session services.

**Tech Stack:** Node.js 22.19+, TypeScript ESM, Pi SDK 0.83.0, Vitest 3, Grammy 1.44

## Global Constraints

- Pin `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent` to exactly `0.83.0` as runtime dependencies.
- Set the tested compatibility range to `>=0.83.0 <0.84.0`.
- Preserve session, workspace, tree, label, topic, rich-message, voice, handoff, provider-notice, bash-guard, and systemd behavior.
- Keep `grammy` at `^1.44.0`.
- Port upstream commit `b7cba54` selectively; do not merge the upstream branch.
- Do not add an RPC backend.

---

### Task 1: Package Pi SDK 0.83 as the embedded runtime

**Files:**
- Modify: `test/package-metadata.test.ts`
- Modify: `test/pi-sdk-compatibility.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/pi-sdk-compatibility.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: direct Pi runtime dependencies at `0.83.0` and `REQUIRED_PI_SDK_RANGE = ">=0.83.0 <0.84.0"`.

- [ ] **Step 1: Change metadata tests to require Pi 0.83 runtime dependencies**

Update the package test so each Pi package must satisfy:

```ts
expect(packageJson.dependencies?.[packageName]).toBe("0.83.0");
expect(packageJson.devDependencies?.[packageName]).toBeUndefined();
expect(packageJson.peerDependencies?.[packageName]).toBeUndefined();
```

Update the README assertion to require `Pi SDK packages 0.83.x`. Update the compatibility-error expectation to include `>=0.83.0 <0.84.0`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- test/package-metadata.test.ts test/pi-sdk-compatibility.test.ts
```

Expected: failures show the existing 0.80 dependency declarations and compatibility range.

- [ ] **Step 3: Update package metadata, compatibility text, and README**

Move the three Pi packages into `dependencies` at `0.83.0`, remove their development and peer declarations, retain Grammy 1.44, and run:

```bash
npm install --save-exact \
  @earendil-works/pi-agent-core@0.83.0 \
  @earendil-works/pi-ai@0.83.0 \
  @earendil-works/pi-coding-agent@0.83.0
```

Set:

```ts
export const REQUIRED_PI_SDK_RANGE = ">=0.83.0 <0.84.0";
```

Replace README references to Pi 0.80 packages with Pi 0.83 and installation commands using `@0.83.0`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same focused Vitest command. Expected: both test files pass.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json README.md src/pi-sdk-compatibility.ts \
  test/package-metadata.test.ts test/pi-sdk-compatibility.test.ts
git commit -m "build: upgrade embedded Pi SDK to 0.83.0"
```

### Task 2: Add reload-aware Pi credential storage

**Files:**
- Create: `src/reloading-credential-store.ts`
- Create: `test/reloading-credential-store.test.ts`

**Interfaces:**
- Produces: `createReloadingCredentialStore(authPath: string): Promise<CredentialStore>`.
- Depends on: Pi 0.83's internal `dist/core/auth-storage.js` implementation and public `CredentialStore` types.

- [ ] **Step 1: Write credential reload tests**

Add one test that writes an API key, reads it, replaces it with an environment reference, and expects the resolved environment value. Add another test that modifies one provider and proves the other provider remains in `auth.json` and `list()` returns both metadata entries.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- test/reloading-credential-store.test.ts
```

Expected: module resolution fails because `src/reloading-credential-store.ts` does not exist.

- [ ] **Step 3: Implement the adapter**

Implement a `CredentialStore` whose `read`, `list`, `modify`, and `delete` methods create a fresh Pi `AuthStorage` delegate. Resolve `dist/core/auth-storage.js` by walking ancestors from `import.meta.url`, and throw `Could not locate Pi's credential storage implementation` if no module exists.

- [ ] **Step 4: Run the test and verify GREEN**

Run the focused test. Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/reloading-credential-store.ts test/reloading-credential-store.test.ts
git commit -m "feat: reload Pi credentials across processes"
```

### Task 3: Migrate session construction to ModelRuntime

**Files:**
- Modify: `src/pi-session.ts`
- Modify: `test/pi-session.test.ts`

**Interfaces:**
- Consumes: `createReloadingCredentialStore(authPath)` from Task 2.
- Produces: Pi 0.83-compatible session services with `services.modelRuntime` and `services.modelRegistry`.

- [ ] **Step 1: Update session-test doubles and expectations first**

Replace mocked `AuthStorage` with a mocked credential-store factory and add a mocked `ModelRuntime.create`. Have service doubles expose both `modelRuntime` and its `new ModelRegistry(modelRuntime)` facade. Update creation expectations to assert:

```ts
expect(mockState.ModelRuntime.create).toHaveBeenCalledWith({
  credentials: expect.objectContaining({ kind: "credential-store" }),
  modelsPath: "/mock-agent/models.json",
});
expect(mockState.createAgentSessionServices).toHaveBeenCalledWith(
  expect.objectContaining({ modelRuntime: expect.any(Object) }),
);
```

Change replacement tests to expect a new model runtime and registry on same-runtime and cross-runtime replacements. Change model-listing tests to expect `modelRuntime.getAvailable()` to be awaited. Remove assertions against `authStorage.reload()`.

- [ ] **Step 2: Run the session test and verify RED**

Run:

```bash
npm test -- test/pi-session.test.ts
```

Expected: failures show production still calls `AuthStorage.create()`, `ModelRegistry.create()`, and `services.authStorage.reload()`.

- [ ] **Step 3: Implement ModelRuntime session construction**

In `src/pi-session.ts`:

- remove the root `AuthStorage` import;
- import `ModelRuntime` and `createReloadingCredentialStore`;
- create `ModelRuntime` with `<agentDir>/auth.json` and `<agentDir>/models.json` inside the runtime factory;
- pass `modelRuntime` to `createAgentSessionServices`;
- retain all existing extension factories, model-scope resolution, diagnostics, tools, and callbacks;
- remove `reloadAuthStorage()`;
- await `runtime.services.modelRuntime.getAvailable()` before `listModels()` reads the registry;
- use the services' `modelRegistry` facade for lookup and model selection.

- [ ] **Step 4: Run session and model-scope tests and verify GREEN**

Run:

```bash
npm test -- test/pi-session.test.ts test/model-scope.test.ts
```

Expected: both files pass with all existing session-management cases intact.

- [ ] **Step 5: Commit**

```bash
git add src/pi-session.ts test/pi-session.test.ts
git commit -m "refactor: create TelePi sessions with ModelRuntime"
```

### Task 4: Prove Pi 0.83 extensions and GPT-5.6 catalog support

**Files:**
- Modify: `test/pi-sdk-compatibility.test.ts`

**Interfaces:**
- Verifies: external extension imports and Pi 0.83's built-in OpenAI Codex GPT-5.6 catalog.

- [ ] **Step 1: Add real-SDK compatibility tests**

Add an extension-loading test using `DefaultResourceLoader` and a temporary TypeScript extension that imports `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, and `@earendil-works/pi-agent-core` and registers `telepi-sdk-check`.

Add a catalog test:

```ts
const runtime = await ModelRuntime.create();
const ids = new Set(
  runtime.getModels("openai-codex").map((model) => model.id),
);
expect(ids).toEqual(expect.objectContaining([
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]));
```

Use individual `ids.has(...)` assertions if the matcher does not support sets.

- [ ] **Step 2: Run the compatibility test**

Run:

```bash
npm test -- test/pi-sdk-compatibility.test.ts
```

Expected after Task 1: the real Pi 0.83 extension and model-catalog tests pass. If either fails, treat it as a migration defect and fix the runtime/package integration rather than weakening the assertion.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run build
npm run package:release
npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent grammy
```

Expected: zero test failures, successful TypeScript and release builds, direct Pi packages at 0.83.0, and Grammy 1.44.x.

- [ ] **Step 4: Inspect the final diff**

Run:

```bash
git diff --check
git status --short
git diff HEAD~3 --stat
```

Confirm only migration code, tests, documentation, and generated dependency metadata changed.

- [ ] **Step 5: Commit**

```bash
git add test/pi-sdk-compatibility.test.ts
git commit -m "test: verify Pi 0.83 extension and GPT-5.6 support"
```
