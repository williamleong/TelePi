import {
  createActivityTranscript,
  type ActivityTranscript,
} from "./activity-rendering.js";
import type { AssistantSegmentDelivery, RenderedChunk } from "./message-rendering.js";
import type { PiThinkingDelta } from "../pi-session.js";

export type StreamSegmentKind = "activity" | "assistant";

export interface SegmentChunkState {
  messageId?: number;
  rendered?: RenderedChunk;
}

export interface StreamSegment {
  id: number;
  kind: StreamSegmentKind;
  sealed: boolean;
  revision: number;
  deliveredRevision: number;
  deliveryFailed: boolean;
  assistantText: string;
  assistantDelivery?: AssistantSegmentDelivery;
  activity?: ActivityTranscript;
  chunks: SegmentChunkState[];
}

export interface StreamSegments {
  appendAssistantText(delta: string): StreamSegment;
  sealAssistantSegment(): void;
  appendThinking(event: PiThinkingDelta): StreamSegment;
  startTool(toolName: string, toolCallId: string, args: unknown): StreamSegment;
  updateTool(toolCallId: string, partialResult: unknown): StreamSegment | undefined;
  finishTool(toolCallId: string, isError: boolean): StreamSegment | undefined;
  getSegments(): readonly StreamSegment[];
  getDirtySegments(): readonly StreamSegment[];
  lockAssistantDelivery(segmentId: number, delivery: AssistantSegmentDelivery): AssistantSegmentDelivery | undefined;
  setRenderedChunks(segmentId: number, chunks: RenderedChunk[]): void;
  setChunkMessageId(segmentId: number, chunkIndex: number, messageId: number): void;
  markDelivered(segmentId: number, revision: number): void;
  markDeliveryFailed(segmentId: number): void;
}

export function createStreamSegments(): StreamSegments {
  const segments: StreamSegment[] = [];
  const toolSegmentIds = new Map<string, number>();
  let nextSegmentId = 1;

  const findSegment = (segmentId: number): StreamSegment | undefined =>
    segments.find((segment) => segment.id === segmentId);

  const activeSegment = (kind: StreamSegmentKind): StreamSegment => {
    const current = segments.at(-1);
    if (current?.kind === kind && !current.sealed) {
      return current;
    }

    if (current) {
      current.sealed = true;
    }

    const segment: StreamSegment = {
      id: nextSegmentId++,
      kind,
      sealed: false,
      revision: 0,
      deliveredRevision: 0,
      deliveryFailed: false,
      assistantText: "",
      ...(kind === "activity" ? { activity: createActivityTranscript() } : {}),
      chunks: [],
    };
    segments.push(segment);
    return segment;
  };

  return {
    appendAssistantText(delta) {
      const segment = activeSegment("assistant");
      segment.assistantText += delta;
      segment.revision += 1;
      return segment;
    },
    sealAssistantSegment() {
      const current = segments.at(-1);
      if (current?.kind === "assistant") {
        current.sealed = true;
      }
    },
    appendThinking(event) {
      const segment = activeSegment("activity");
      segment.activity?.appendThinking(event);
      segment.revision += 1;
      return segment;
    },
    startTool(toolName, toolCallId, args) {
      const segment = activeSegment("activity");
      segment.activity?.startTool(toolCallId, toolName, args);
      toolSegmentIds.set(toolCallId, segment.id);
      segment.revision += 1;
      return segment;
    },
    updateTool(toolCallId, partialResult) {
      const segmentId = toolSegmentIds.get(toolCallId);
      if (segmentId === undefined) {
        return undefined;
      }

      const segment = findSegment(segmentId);
      if (!segment?.activity?.updateTool(toolCallId, partialResult)) {
        return undefined;
      }

      segment.revision += 1;
      return segment;
    },
    finishTool(toolCallId, isError) {
      const segmentId = toolSegmentIds.get(toolCallId);
      if (segmentId === undefined) {
        return undefined;
      }

      const segment = findSegment(segmentId);
      if (!segment?.activity) {
        return undefined;
      }

      const tool = segment.activity.entries.find(
        (entry): entry is Extract<typeof entry, { kind: "tool" }> =>
          entry.kind === "tool" && entry.toolCallId === toolCallId,
      );
      if (!tool) {
        return undefined;
      }

      toolSegmentIds.delete(toolCallId);
      segment.activity.finishTool(toolCallId, isError);
      segment.revision += 1;
      return segment;
    },
    getSegments() {
      return segments;
    },
    getDirtySegments() {
      return segments.filter(
        (segment) => segment.revision > segment.deliveredRevision && !segment.deliveryFailed,
      );
    },
    lockAssistantDelivery(segmentId, delivery) {
      const segment = findSegment(segmentId);
      if (!segment || segment.kind !== "assistant") {
        return undefined;
      }

      segment.assistantDelivery ??= delivery;
      return segment.assistantDelivery;
    },
    setRenderedChunks(segmentId, chunks) {
      const segment = findSegment(segmentId);
      if (!segment) {
        return;
      }

      const discardedMessageId = segment.chunks
        .slice(chunks.length)
        .find((chunk) => chunk.messageId !== undefined)?.messageId;
      if (discardedMessageId !== undefined) {
        throw new Error(`Cannot discard delivered Telegram chunk ${discardedMessageId}.`);
      }

      segment.chunks = chunks.map((rendered, index) => ({
        messageId: segment.chunks[index]?.messageId,
        rendered,
      }));
    },
    setChunkMessageId(segmentId, chunkIndex, messageId) {
      const chunk = findSegment(segmentId)?.chunks[chunkIndex];
      if (chunk) {
        chunk.messageId = messageId;
      }
    },
    markDelivered(segmentId, revision) {
      const segment = findSegment(segmentId);
      if (segment) {
        segment.deliveredRevision = Math.max(
          segment.deliveredRevision,
          Math.min(revision, segment.revision),
        );
      }
    },
    markDeliveryFailed(segmentId) {
      const segment = findSegment(segmentId);
      if (segment) {
        segment.deliveryFailed = true;
      }
    },
  };
}
