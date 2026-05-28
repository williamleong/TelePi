import type { Dirent } from "node:fs";
import { readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { PiSessionContext } from "../pi-session.js";

export type PromptInboxPollResult = "busy" | "empty" | "queued" | "failed";

export interface PromptInboxPollOptions {
  inboxDir: string;
  target: PiSessionContext;
  isBusy: (target: PiSessionContext) => boolean;
  handlePrompt: (target: PiSessionContext, prompt: string) => Promise<boolean>;
}

export interface PromptInboxPollingOptions extends PromptInboxPollOptions {
  intervalMs: number;
  onError?: (error: unknown) => void;
}

export interface ClaimedPromptInboxFile {
  path: string;
  originalPath: string;
  prompt: string;
  ack: () => Promise<void>;
  fail: () => Promise<void>;
}

interface PromptInboxCandidate {
  path: string;
  name: string;
  modifiedMs: number;
}

export function startPromptInboxPolling(options: PromptInboxPollingOptions): () => void {
  let inFlight = false;
  const poll = () => {
    if (inFlight) {
      return;
    }

    inFlight = true;
    void pollPromptInboxOnce(options)
      .catch((error) => {
        if (options.onError) {
          options.onError(error);
          return;
        }
        console.error("Prompt inbox polling failed", error);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const timer = setInterval(poll, options.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function pollPromptInboxOnce(options: PromptInboxPollOptions): Promise<PromptInboxPollResult> {
  if (options.isBusy(options.target)) {
    return "busy";
  }

  const claimed = await claimNextPromptInboxFile(options.inboxDir);
  if (!claimed) {
    return "empty";
  }

  let accepted: boolean;
  try {
    accepted = await options.handlePrompt(options.target, claimed.prompt);
  } catch (error) {
    await claimed.fail();
    throw error;
  }

  if (!accepted) {
    await claimed.fail();
    return "failed";
  }

  await claimed.ack();
  return "queued";
}

export async function claimNextPromptInboxFile(inboxDir: string): Promise<ClaimedPromptInboxFile | undefined> {
  const candidates = await listPromptInboxCandidates(inboxDir);

  for (const candidate of candidates) {
    const processingPath = `${candidate.path}.processing`;
    if (await pathExists(processingPath)) {
      continue;
    }

    try {
      await rename(candidate.path, processingPath);
    } catch (error) {
      if (isMissingDirectoryError(error)) {
        continue;
      }
      throw error;
    }

    const contents = await readFile(processingPath, "utf8");
    const prompt = contents.trim();
    if (!prompt) {
      await rm(processingPath, { force: true });
      continue;
    }

    return {
      path: processingPath,
      originalPath: candidate.path,
      prompt,
      ack: async () => {
        await rm(processingPath, { force: true });
      },
      fail: async () => {
        const failedPath = `${candidate.path}.failed`;
        await rm(failedPath, { force: true });
        await rename(processingPath, failedPath).catch((error) => {
          if (!isMissingDirectoryError(error)) {
            throw error;
          }
        });
      },
    };
  }

  return undefined;
}

async function listPromptInboxCandidates(inboxDir: string): Promise<PromptInboxCandidate[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(inboxDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectoryError(error)) {
      return [];
    }
    throw error;
  }

  const candidates: PromptInboxCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".txt") {
      continue;
    }

    const filePath = path.join(inboxDir, entry.name);
    const fileStat = await stat(filePath);
    candidates.push({
      path: filePath,
      name: entry.name,
      modifiedMs: fileStat.mtimeMs,
    });
  }

  return candidates.sort((left, right) =>
    left.modifiedMs - right.modifiedMs || left.name.localeCompare(right.name),
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isMissingDirectoryError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingDirectoryError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
