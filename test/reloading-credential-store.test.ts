import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createReloadingCredentialStore } from "../src/reloading-credential-store.js";

async function createPiCredentialStore(authPath: string) {
  const { AuthStorage } = await import(
    new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js", import.meta.url).href,
  );
  return AuthStorage.create(authPath);
}

describe("createReloadingCredentialStore", () => {
  const originalEnv = process.env;
  let tempDir: string;
  let authPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-credentials-"));
    authPath = path.join(tempDir, "auth.json");
    process.env = { ...originalEnv, TELEPI_RELOADING_TEST_API_KEY: "resolved-api-key" };
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reloads an API key changed to an environment reference by the Pi credential store", async () => {
    const piStore = await createPiCredentialStore(authPath);
    await piStore.modify("anthropic", async () => ({ type: "api_key", key: "initial-api-key" }));

    const store = await createReloadingCredentialStore(authPath);
    await expect(store.read("anthropic")).resolves.toEqual({ type: "api_key", key: "initial-api-key" });

    await piStore.modify("anthropic", async () => ({
      type: "api_key",
      key: "$TELEPI_RELOADING_TEST_API_KEY",
    }));

    await expect(store.read("anthropic")).resolves.toEqual({ type: "api_key", key: "resolved-api-key" });
  });

  it("preserves existing credentials when modifying another provider", async () => {
    const piStore = await createPiCredentialStore(authPath);
    await piStore.modify("anthropic", async () => ({ type: "api_key", key: "anthropic-api-key" }));

    const store = await createReloadingCredentialStore(authPath);
    await store.modify("openai", async () => ({ type: "api_key", key: "openai-api-key" }));

    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      anthropic: { type: "api_key", key: "anthropic-api-key" },
      openai: { type: "api_key", key: "openai-api-key" },
    });
    await expect(store.list()).resolves.toEqual([
      { providerId: "anthropic", type: "api_key" },
      { providerId: "openai", type: "api_key" },
    ]);
  });
});
