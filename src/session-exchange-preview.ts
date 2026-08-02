import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";

export const USER_PREVIEW_LIMIT = 1_000;
export const ASSISTANT_PREVIEW_LIMIT = 2_000;
export const SHORTENED_RESPONSE_MARKER = "… recent response shortened …";

export interface PiSessionExchangePreview {
  userText: string;
  assistantText: string;
}

export function buildLastExchangePreview(
  messages: AgentMessage[],
): PiSessionExchangePreview | undefined {
  let currentUserText: string | undefined;
  let currentAssistantParts: string[] = [];
  let latestCompleted: PiSessionExchangePreview | undefined;

  const finishCurrent = (): void => {
    if (currentUserText === undefined || currentAssistantParts.length === 0) return;
    latestCompleted = {
      userText: truncateUserText(currentUserText),
      assistantText: truncateAssistantText(currentAssistantParts.join("\n\n")),
    };
  };

  for (const message of messages) {
    if (message.role === "user") {
      finishCurrent();
      currentUserText = extractUserText(message.content);
      currentAssistantParts = [];
      continue;
    }

    if (message.role !== "assistant" || currentUserText === undefined) continue;
    const text = extractAssistantText(message.content);
    if (text) currentAssistantParts.push(text);
  }

  finishCurrent();
  return latestCompleted;
}

function extractUserText(content: UserMessage["content"]): string {
  if (typeof content === "string") return content.trim();
  return content
    .map((block) => block.type === "text" ? block.text.trim() : "[image]")
    .filter(Boolean)
    .join("\n");
}

function extractAssistantText(content: AssistantMessage["content"]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
}

function truncateUserText(text: string): string {
  if (text.length <= USER_PREVIEW_LIMIT) return text;
  return `${text.slice(0, USER_PREVIEW_LIMIT - 1)}…`;
}

function truncateAssistantText(text: string): string {
  if (text.length <= ASSISTANT_PREVIEW_LIMIT) return text;
  const separator = `\n\n${SHORTENED_RESPONSE_MARKER}\n\n`;
  const available = ASSISTANT_PREVIEW_LIMIT - separator.length;
  const headLength = Math.ceil(available * 0.6);
  const tailLength = available - headLength;
  return `${text.slice(0, headLength)}${separator}${text.slice(-tailLength)}`;
}
