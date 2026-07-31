import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { CredentialStore } from "@earendil-works/pi-ai";

type AuthStorageModule = {
  AuthStorage: {
    create(authPath?: string): CredentialStore;
  };
};

const AUTH_STORAGE_MODULE_PATH = [
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "core",
  "auth-storage.js",
];

export async function createReloadingCredentialStore(authPath: string): Promise<CredentialStore> {
  const { AuthStorage } = await loadAuthStorageModule();
  const createDelegate = () => AuthStorage.create(authPath);

  return {
    read: (providerId) => createDelegate().read(providerId),
    list: () => createDelegate().list(),
    modify: (providerId, fn) => createDelegate().modify(providerId, fn),
    delete: (providerId) => createDelegate().delete(providerId),
  };
}

async function loadAuthStorageModule(): Promise<AuthStorageModule> {
  const authStoragePath = findAuthStorageModulePath();
  return import(pathToFileURL(authStoragePath).href) as Promise<AuthStorageModule>;
}

function findAuthStorageModulePath(): string {
  let directory = dirname(fileURLToPath(import.meta.url));

  while (true) {
    const authStoragePath = join(directory, ...AUTH_STORAGE_MODULE_PATH);
    if (existsSync(authStoragePath)) {
      return authStoragePath;
    }

    const parentDirectory = dirname(directory);
    if (parentDirectory === directory) {
      throw new Error("Could not locate Pi's credential storage implementation");
    }
    directory = parentDirectory;
  }
}
