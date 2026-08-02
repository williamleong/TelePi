import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export interface TopicSessionRecord {
  sessionFile: string;
  workspace: string;
}

interface TopicSessionState {
  version: 1;
  topics: Record<string, TopicSessionRecord>;
}

export class TopicSessionStore {
  private constructor(
    private readonly filePath: string | undefined,
    private state: TopicSessionState,
  ) {}

  static open(filePath: string): TopicSessionStore {
    const store = new TopicSessionStore(filePath, emptyState());
    store.load();
    return store;
  }

  static memory(): TopicSessionStore {
    return new TopicSessionStore(undefined, emptyState());
  }

  get(key: string): TopicSessionRecord | undefined {
    return this.state.topics[key];
  }

  set(key: string, record: TopicSessionRecord): void {
    this.state.topics[key] = { ...record };
    this.persist();
  }

  delete(key: string): void {
    delete this.state.topics[key];
    this.persist();
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) {
      return;
    }

    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      this.state = parseState(parsed);
    } catch {
      console.warn(`Could not read topic session state at ${this.filePath}; using empty state`);
    }
  }

  private persist(): void {
    if (!this.filePath) {
      return;
    }

    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      writeFileSync(tempPath, JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
      renameSync(tempPath, this.filePath);
    } catch {
      console.warn(`Could not write topic session state at ${this.filePath}`);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }
}

function emptyState(): TopicSessionState {
  return { version: 1, topics: {} };
}

function parseState(value: unknown): TopicSessionState {
  if (!isPlainObject(value) || value.version !== 1 || !isPlainObject(value.topics)) {
    throw new Error("Invalid topic session state");
  }

  const topics: Record<string, TopicSessionRecord> = {};
  for (const [key, record] of Object.entries(value.topics)) {
    if (isTopicSessionRecord(record)) {
      topics[key] = { ...record };
    }
  }
  return { version: 1, topics };
}

function isTopicSessionRecord(value: unknown): value is TopicSessionRecord {
  return (
    isPlainObject(value) &&
    typeof value.sessionFile === "string" &&
    value.sessionFile.length > 0 &&
    typeof value.workspace === "string" &&
    value.workspace.length > 0
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
