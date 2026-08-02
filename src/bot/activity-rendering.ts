import { escapeHTML } from "../format.js";
import type { PiThinkingDelta } from "../pi-session.js";
import type { RenderedChunk } from "./message-rendering.js";

export type ActivityToolStatus = "running" | "success" | "error";

export type ActivityEntry =
  | { kind: "thinking"; blockKey: string; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      args: unknown;
      status: ActivityToolStatus;
    };

export interface ActivityTranscript {
  readonly entries: ActivityEntry[];
  appendThinking(event: PiThinkingDelta): void;
  startTool(toolCallId: string, toolName: string, args: unknown): void;
  finishTool(toolCallId: string, isError: boolean): void;
}

export const ACTIVITY_MESSAGE_LIMIT = 4_000;

export function createActivityTranscript(): ActivityTranscript {
  const entries: ActivityEntry[] = [];

  return {
    entries,
    appendThinking(event) {
      const lastEntry = entries.at(-1);
      if (lastEntry?.kind === "thinking" && lastEntry.blockKey === event.blockKey) {
        lastEntry.text += event.delta;
        return;
      }

      entries.push({ kind: "thinking", blockKey: event.blockKey, text: event.delta });
    },
    startTool(toolCallId, toolName, args) {
      entries.push({
        kind: "tool",
        toolCallId,
        toolName,
        args,
        status: "running",
      });
    },
    finishTool(toolCallId, isError) {
      const entry = entries.find(
        (candidate): candidate is Extract<ActivityEntry, { kind: "tool" }> =>
          candidate.kind === "tool" && candidate.toolCallId === toolCallId,
      );
      if (entry) {
        entry.status = isError ? "error" : "success";
      }
    },
  };
}

type ActivityBlock = {
  html: string;
  fallback: string;
};

export function renderActivityTranscript(transcript: ActivityTranscript): RenderedChunk[] {
  const chunks: RenderedChunk[] = [];
  let current: ActivityBlock | undefined;

  const flush = () => {
    if (!current) {
      return;
    }

    chunks.push({
      text: current.html,
      fallbackText: current.fallback,
      parseMode: "HTML",
      sourceText: current.fallback,
    });
    current = undefined;
  };

  const appendBlock = (block: ActivityBlock): boolean => {
    const separator = current ? "\n" : "";
    const next = {
      html: `${current?.html ?? ""}${separator}${block.html}`,
      fallback: `${current?.fallback ?? ""}${separator}${block.fallback}`,
    };
    if (!fits(next)) {
      return false;
    }

    current = next;
    return true;
  };

  for (const entry of transcript.entries) {
    if (entry.kind === "tool") {
      appendCompleteBlock(fitToolBlock(entry), appendBlock, flush);
      continue;
    }

    appendThinking(entry.text, appendBlock, flush);
  }

  flush();
  return chunks;
}

function appendCompleteBlock(
  block: ActivityBlock,
  appendBlock: (block: ActivityBlock) => boolean,
  flush: () => void,
): void {
  if (!appendBlock(block)) {
    flush();
    appendBlock(block);
  }
}

function appendThinking(
  text: string,
  appendBlock: (block: ActivityBlock) => boolean,
  flush: () => void,
): void {
  const normalizedText = text.trimEnd();
  const completeBlock = renderThinkingBlock(normalizedText, false);
  if (fits(completeBlock)) {
    appendCompleteBlock(completeBlock, appendBlock, flush);
    return;
  }

  flush();
  const characters = Array.from(normalizedText);
  let offset = 0;
  let continued = false;

  while (offset < characters.length) {
    const length = largestFittingThinkingPrefix(characters, offset, continued);
    const fragment = characters.slice(offset, offset + length).join("");
    appendCompleteBlock(renderThinkingBlock(fragment, continued), appendBlock, flush);
    offset += length;
    continued = true;
  }
}

function largestFittingThinkingPrefix(
  characters: string[],
  offset: number,
  continued: boolean,
): number {
  let low = 1;
  let high = characters.length - offset;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const text = characters.slice(offset, offset + middle).join("");
    if (fits(renderThinkingBlock(text, continued))) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return low;
}

function renderThinkingBlock(text: string, continued: boolean): ActivityBlock {
  const header = continued ? "🧠 Thinking (continued)" : "🧠 Thinking";
  const normalizedText = text.trimEnd();
  return {
    html: normalizedText ? `${header}\n${escapeHTML(normalizedText)}` : header,
    fallback: normalizedText ? `${header}\n${normalizedText}` : header,
  };
}

function fitToolBlock(entry: Extract<ActivityEntry, { kind: "tool" }>): ActivityBlock {
  const summary = summarizeTool(entry.toolName, entry.args);
  const status = statusSymbol(entry.status);
  const header = `${status} ${summary.label}`;
  const render = (detail: string | undefined): ActivityBlock => ({
    html: detail === undefined
      ? `<b>${escapeHTML(header)}</b>`
      : `<b>${escapeHTML(header)}</b>\n<code>${escapeHTML(detail)}</code>`,
    fallback: detail === undefined ? header : `${header}\n${detail}`,
  });

  const fullBlock = render(summary.detail);
  if (fits(fullBlock)) {
    return fullBlock;
  }

  if (summary.detail === undefined) {
    return render(undefined);
  }

  const characters = Array.from(summary.detail);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(render(`${characters.slice(0, middle).join("")}…`))) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return render(low > 0 ? `${characters.slice(0, low).join("")}…` : undefined);
}

function summarizeTool(toolName: string, args: unknown): { label: string; detail?: string } {
  switch (toolName) {
    case "read":
      return { label: "🔍 Read", detail: readString(args, "path") };
    case "bash":
      return { label: "⌨️ Bash", detail: readString(args, "command") };
    case "edit":
      return { label: "✏️ Edit", detail: readString(args, "path") };
    case "write":
      return { label: "📝 Write", detail: readString(args, "path") };
    case "grep":
      return {
        label: "🔎 Grep",
        detail: formatPatternAndPath(readString(args, "pattern"), readString(args, "path")),
      };
    case "find":
      return {
        label: "📁 Find",
        detail: formatPatternAndPath(readString(args, "pattern"), readString(args, "path")),
      };
    case "ls":
      return { label: "📂 LS", detail: readString(args, "path") ?? "." };
    default:
      return { label: humanizeToolName(toolName) };
  }
}

function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function formatPatternAndPath(pattern: string | undefined, path: string | undefined): string | undefined {
  if (!pattern) {
    return undefined;
  }

  return path ? `${pattern} in ${path}` : pattern;
}

function humanizeToolName(name: string): string {
  const words = name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z\d]+/)
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`);
  const label = words.join(" ") || "Tool";
  return Array.from(label).slice(0, 512).join("");
}

function statusSymbol(status: ActivityToolStatus): string {
  switch (status) {
    case "success":
      return "✓";
    case "error":
      return "✗";
    default:
      return "•";
  }
}

function fits(block: ActivityBlock): boolean {
  return block.html.length <= ACTIVITY_MESSAGE_LIMIT
    && block.fallback.length <= ACTIVITY_MESSAGE_LIMIT;
}
