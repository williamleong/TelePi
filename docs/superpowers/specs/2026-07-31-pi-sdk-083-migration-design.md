# Pi SDK 0.83 Migration Design

## Goal

Upgrade TelePi's embedded Pi runtime from 0.80.3 to 0.83.0 so it uses the same Pi release as the installed CLI and exposes that release's model catalog, including GPT-5.6 Luna, Sol, and Terra.

## Scope

TelePi will keep its embedded runtime and all existing Telegram and session-management behavior. The change will selectively port the useful parts of upstream TelePi commit `b7cba54` rather than merge the upstream branch.

The migration must preserve:

- session listing, creation, resume, fork, tree navigation, labels, and workspace switching;
- Telegram topics, rich messages, extension dialogs, voice handling, and handoff;
- Grammy 1.44;
- TelePi's bash timeout and self-management guard;
- provider-response notices and systemd behavior.

RPC migration and unrelated refactoring are out of scope.

## Dependency Policy

TelePi will install these runtime dependencies at exactly `0.83.0`:

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`

The Pi packages move from development plus peer dependencies into regular dependencies, matching upstream's packaging fix and making the embedded runtime self-contained. TelePi's compatibility message will state the tested range `>=0.83.0 <0.84.0`. The lockfile must resolve all three direct packages to `0.83.0`.

## Runtime Architecture

Pi 0.83 no longer exports `AuthStorage` from the coding-agent package root. TelePi will construct one `ModelRuntime` for each cwd-bound session runtime:

1. Create `SettingsManager` for the effective workspace.
2. Create a reload-aware `CredentialStore` for `<agentDir>/auth.json`.
3. Create `ModelRuntime` with that credential store and `<agentDir>/models.json`.
4. Pass the model runtime to `createAgentSessionServices`.
5. Resolve configured and scoped models through the services' compatibility `ModelRegistry`.
6. Create the session through the existing `AgentSessionRuntime` factory.

The reload-aware store will delegate each operation to a new Pi `AuthStorage` instance. This observes credentials written by the installed Pi CLI while retaining Pi's environment-value resolution, file locking, and atomic writes. Because Pi 0.83 does not export `AuthStorage`, the adapter will isolate the internal module-path lookup in one tested file.

Model listing will await `ModelRuntime.getAvailable()` before reading the synchronous `ModelRegistry` facade. Prompting and model selection will rely on the reload-aware credential store rather than calling the removed `services.authStorage.reload()` API.

## Compatibility and Errors

TelePi will retain its startup compatibility assertion and update its error message to `>=0.83.0 <0.84.0`. Failure to locate Pi's internal credential storage will stop session creation with a direct setup error.

Session-service diagnostics will continue to combine Pi runtime diagnostics, settings errors, and resource-loading diagnostics without changing Telegram output.

## Testing

The migration will use test-first changes for observable behavior:

- package metadata requires the three Pi dependencies at `0.83.0` and no Pi peer dependencies;
- the compatibility guard reports the 0.83 range;
- the reload-aware credential store observes external edits, resolves environment references, and preserves unrelated providers during writes;
- session construction passes `ModelRuntime` to Pi 0.83 services and recreates it on runtime replacement;
- model listing refreshes runtime availability;
- external extensions can import Earendil Pi packages;
- a real Pi 0.83 model runtime contains GPT-5.6 Luna, Sol, and Terra in the OpenAI Codex catalog;
- the full existing test suite and TypeScript build pass.

## Acceptance Criteria

1. All three direct Pi dependencies resolve to 0.83.0.
2. TelePi compiles without importing root `AuthStorage` or calling `ModelRegistry.create()`.
3. Existing session-management and Telegram tests remain green.
4. Credential changes made outside TelePi are visible without restarting TelePi.
5. TelePi's model catalog includes `openai-codex/gpt-5.6-luna`, `openai-codex/gpt-5.6-sol`, and `openai-codex/gpt-5.6-terra`.
6. `npm test`, `npm run build`, and the release packaging checks complete successfully.
