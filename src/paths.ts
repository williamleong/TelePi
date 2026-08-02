import { homedir } from "node:os";
import path from "node:path";

export const DOCKER_WORKSPACE_PATH = "/workspace";
const DEFAULT_CONFIG_DIRNAME = path.join(".config", "telepi");
const DEFAULT_CONFIG_FILENAME = "config.env";
const DEFAULT_TOPIC_SESSION_STATE_FILENAME = "topic-sessions.json";

export function getHomeDirectory(): string {
  return process.env.HOME?.trim() || homedir();
}

export function expandHomePath(filePath: string): string {
  const normalized = filePath.trim();
  if (normalized === "~") {
    return getHomeDirectory();
  }

  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return path.join(getHomeDirectory(), normalized.slice(2));
  }

  return normalized;
}

export function resolvePathFromCwd(filePath: string, cwd: string = process.cwd()): string {
  const expandedPath = expandHomePath(filePath);
  return path.isAbsolute(expandedPath) ? expandedPath : path.resolve(cwd, expandedPath);
}

export function getDefaultTelePiConfigPath(homeDirectory: string = getHomeDirectory()): string {
  return path.join(homeDirectory, DEFAULT_CONFIG_DIRNAME, DEFAULT_CONFIG_FILENAME);
}

/**
 * Returns the default systemd user directory path.
 * Typically ~/.config/systemd/user on Linux.
 */
export function getDefaultSystemdUserDir(homeDirectory: string = getHomeDirectory()): string {
  return path.join(homeDirectory, ".config", "systemd", "user");
}

/**
 * Returns the default TelePi log directory for the given platform.
 * macOS: ~/Library/Logs/TelePi
 * Linux: ~/.local/state/telepi/logs
 */
export function getDefaultLogDir(
  homeDirectory: string = getHomeDirectory(),
  platform: "darwin" | "linux",
): string {
  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Logs", "TelePi");
  }

  return path.join(homeDirectory, ".local", "state", "telepi", "logs");
}

export function getDefaultTelePiStateDir(
  homeDirectory: string = getHomeDirectory(),
  platform: "darwin" | "linux" = process.platform === "darwin" ? "darwin" : "linux",
  xdgStateHome?: string,
): string {
  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", "TelePi");
  }

  return path.join(
    xdgStateHome?.trim() || process.env.XDG_STATE_HOME?.trim() || path.join(homeDirectory, ".local", "state"),
    "telepi",
  );
}

export function getDefaultTopicSessionStatePath(
  homeDirectory: string = getHomeDirectory(),
  platform: "darwin" | "linux" = process.platform === "darwin" ? "darwin" : "linux",
  xdgStateHome?: string,
): string {
  return path.join(
    getDefaultTelePiStateDir(homeDirectory, platform, xdgStateHome),
    DEFAULT_TOPIC_SESSION_STATE_FILENAME,
  );
}
