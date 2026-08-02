import * as formatModule from "../../src/format.js";

import {
  appendWithCap,
  buildStreamingPreview,
  findPreferredSplitIndex,
  formatMarkdownMessage,
  formatRichMarkdownMessage,
  formatToolSummaryLine,
  renderAssistantSegment,
  renderDialogPanel,
  renderExtensionError,
  renderExtensionNotice,
  renderFailedText,
  getWorkspaceShortName,
  renderHelpHTML,
  renderHelpPlain,
  renderPromptFailure,
  renderSessionInfoHTML,
  renderSessionInfoPlain,
  renderSessionExchangePreview,
  renderToolEndMessage,
  renderToolStartMessage,
  renderVoiceSupportHTML,
  renderVoiceSupportPlain,
  splitMarkdownForTelegram,
  splitRichMarkdownForTelegram,
  splitTelegramText,
  stripHtml,
  summarizeToolOutput,
  trimLine,
  isMessageNotModifiedError,
  isRichMarkdownCandidate,
  isTelegramParseError,
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_RICH_MESSAGE_LIMIT,
} from "../../src/bot/message-rendering.js";
import { SHORTENED_RESPONSE_MARKER } from "../../src/session-exchange-preview.js";

describe("bot message rendering helpers", () => {
  const info = {
    sessionId: "session-1234",
    sessionFile: "/tmp/session.jsonl",
    workspace: "/workspace/project",
    sessionName: "My Session",
    modelFallbackMessage: "Using fallback model",
    model: "anthropic/claude-sonnet-4-5",
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders session info and help in plain text and HTML", () => {
    expect(renderSessionInfoPlain(info)).toContain("Session ID: session-1234");
    expect(renderSessionInfoPlain(info)).toContain("Model note: Using fallback model");
    expect(renderSessionInfoHTML(info)).toContain("<b>Session ID:</b>");
    expect(renderSessionInfoHTML(info)).toContain("<code>/tmp/session.jsonl</code>");

    expect(renderHelpPlain(info)).toContain("/commands — browse TelePi and Pi commands");
    expect(renderHelpPlain(info)).toContain("/activity on|off");
    expect(renderHelpPlain(info)).toContain("bare /activity reports the current state");
    expect(renderHelpPlain(info)).toContain("Each Telegram chat/topic has its own Pi session");
    expect(renderHelpHTML(info)).toContain("<code>/sessions &lt;path|id&gt;</code>");
    expect(renderHelpHTML(info)).toContain("<code>/activity on|off</code>");
    expect(renderHelpHTML(info)).toContain("bare <code>/activity</code> reports the current state");
    expect(renderHelpHTML(info)).toContain("<b>Notes</b>");
  });

  it("renders session diagnostics with warning, error, and info sections", () => {
    const diagnosticsInfo = {
      ...info,
      diagnostics: [
        { type: "warning", message: "Project settings: failed to parse .pi/settings.json" },
        { type: "error", message: 'Failed to load extension "/ext/bad.ts": boom' },
        { type: "info", message: "Session will continue with the current workspace." },
        { type: "warning", message: "Theme issue (/themes/missing.json): theme path does not exist" },
      ],
    };

    expect(renderSessionInfoPlain(diagnosticsInfo)).toContain("Errors:");
    expect(renderSessionInfoPlain(diagnosticsInfo)).toContain('- Failed to load extension "/ext/bad.ts": boom');
    expect(renderSessionInfoPlain(diagnosticsInfo)).toContain("Warnings:");
    expect(renderSessionInfoPlain(diagnosticsInfo)).toContain("- Project settings: failed to parse .pi/settings.json");
    expect(renderSessionInfoPlain(diagnosticsInfo)).toContain("Notes:");
    expect(renderSessionInfoPlain(diagnosticsInfo)).toContain("- Session will continue with the current workspace.");
    expect(renderSessionInfoHTML(diagnosticsInfo)).toContain("<b>Errors:</b>");
    expect(renderSessionInfoHTML(diagnosticsInfo)).toContain("<b>Warnings:</b>");
    expect(renderSessionInfoHTML(diagnosticsInfo)).toContain("<b>Notes:</b>");
    expect(renderSessionInfoHTML(diagnosticsInfo)).toContain("Session will continue with the current workspace.");
  });

  it("renders voice support, dialog panels, tool updates, and tool summaries", () => {
    expect(renderVoiceSupportPlain(["openai", "parakeet"]))
      .toBe("Voice transcription: openai, parakeet.");
    expect(renderVoiceSupportHTML([], "Missing ffmpeg")).toContain("⚠️ Missing ffmpeg");

    const dialogPanel = renderDialogPanel("Pick one", ["2 options available.", "Use the buttons below."], "🧭");
    expect(dialogPanel.parseMode).toBe("HTML");
    expect(dialogPanel.text).toContain("<pre>");
    expect(dialogPanel.fallbackText).toContain("┌");
    expect(dialogPanel.fallbackText).toContain("🧭 Pick one");
    expect(dialogPanel.fallbackText).toContain("Use the buttons below.");

    expect(renderToolStartMessage("bash")).toEqual({
      text: "<b>🔧 Running:</b> <code>bash</code>",
      fallbackText: "🔧 Running: bash",
      parseMode: "HTML",
    });

    const toolEnd = renderToolEndMessage("bash", "done", false);
    expect(toolEnd.text).toContain("✅");
    expect(toolEnd.text).toContain("<pre>done</pre>");
    expect(toolEnd.fallbackText).toContain("done");

    expect(formatToolSummaryLine(new Map([[
      "read", 1,
    ], ["bash", 2]]))).toBe("🔧 3 tools used: bash ×2, read");
    expect(formatToolSummaryLine(new Map())).toBe("");
  });

  it("renders an escaped resumed-session exchange preview", () => {
    const rendered = renderSessionExchangePreview({
      userText: "Use <auth> & tests",
      assistantText: "Done <success>",
    });

    expect(rendered.fallbackText).toBe([
      "↩️ Recent context",
      "",
      "You",
      "Use <auth> & tests",
      "",
      "Pi",
      "Done <success>",
    ].join("\n"));
    expect(rendered.text).toContain("<b>↩️ Recent context</b>");
    expect(rendered.text).toContain("<b>You</b>");
    expect(rendered.text).toContain("Use &lt;auth&gt; &amp; tests");
    expect(rendered.text).toContain("<b>Pi</b>");
  });

  it("bounds an escaped exchange preview without splitting entities or Unicode", () => {
    const userText = `user-prefix-${"&<>🧪".repeat(197)}abc`;
    const assistantText = `assistant-head-${"&<>🧪".repeat(394)}-assistant-tail`;

    const rendered = renderSessionExchangePreview({ userText, assistantText });

    expect(userText).toHaveLength(1_000);
    expect(assistantText).toHaveLength(2_000);
    expect(rendered.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(rendered.text).not.toMatch(/&(?!amp;|lt;|gt;)/);
    expect(rendered.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(rendered.fallbackText).toContain("You\nuser-prefix-");
    expect(rendered.fallbackText).toContain("Pi\nassistant-head-");
    expect(rendered.fallbackText).toContain(SHORTENED_RESPONSE_MARKER);
    expect(rendered.fallbackText).toContain("-assistant-tail");
  });

  it("renders prompt and extension failures consistently", () => {
    expect(renderPromptFailure("partial output", new Error("something failed")))
      .toBe("partial output\n\n⚠️ something failed");
    expect(renderPromptFailure("", new Error("Aborted by user"))).toBe("⏹ Aborted");

    expect(renderFailedText(new Error("boom"))).toEqual({
      text: "<b>Failed:</b> boom",
      fallbackText: "Failed: boom",
      parseMode: "HTML",
    });

    expect(renderExtensionNotice("Heads up", "warning")).toEqual({
      text: "<b>⚠️</b> Heads up",
      fallbackText: "⚠️ Heads up",
      parseMode: "HTML",
    });

    expect(renderExtensionError("command:review", "command", "No diff found")).toEqual({
      text: "<b>❌ /review failed:</b> No diff found",
      fallbackText: "❌ /review failed: No diff found",
      parseMode: "HTML",
    });
  });

  it("splits Telegram text and markdown into safe chunks", () => {
    const chunks = splitTelegramText(`${"a".repeat(3900)}\n${"b".repeat(3900)}`);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);

    const markdown = "<".repeat(2500);
    const renderedChunks = splitMarkdownForTelegram(markdown);
    expect(renderedChunks.length).toBeGreaterThan(1);
    expect(renderedChunks.every((chunk) => chunk.text.length <= 4000)).toBe(true);
    expect(renderedChunks.map((chunk) => chunk.sourceText).join("")).toBe(markdown);
  });

  it("renders assistant segments with a heading, escaped HTML, and a raw fallback", () => {
    const [chunk] = renderAssistantSegment("Use <tag> & **bold**");

    expect(chunk).toMatchObject({
      text: "<b>💬 Assistant</b>\nUse &lt;tag&gt; &amp; <b>bold</b>",
      fallbackText: "💬 Assistant\nUse <tag> & **bold**",
      parseMode: "HTML",
      sourceText: "Use <tag> & **bold**",
    });
  });

  it("splits assistant segments with headings inside Telegram's message limit", () => {
    const text = "<".repeat(5_000);
    const chunks = renderAssistantSegment(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= TELEGRAM_MESSAGE_LIMIT)).toBe(true);
    expect(chunks.every((chunk) => chunk.fallbackText.length <= TELEGRAM_MESSAGE_LIMIT)).toBe(true);
    expect(chunks.map((chunk) => chunk.sourceText).join("")).toBe(text);
    expect(chunks[0]?.fallbackText).toMatch(/^💬 Assistant\n/);
    expect(chunks[1]?.fallbackText).toMatch(/^💬 Assistant \(continued\)\n/);
  });

  it("preserves rich Markdown assistant delivery with a Markdown-safe heading", () => {
    const markdown = [
      "# Report",
      "",
      "| Metric | Value |",
      "| ------ | ----- |",
      "| Speed | **42 ms** |",
    ].join("\n");

    const [chunk] = renderAssistantSegment(markdown);

    expect(chunk).toMatchObject({
      text: `**💬 Assistant**\n\n${markdown}`,
      fallbackText: `💬 Assistant\n${markdown}`,
      delivery: "rich-markdown",
      sourceText: markdown,
    });
    expect(chunk.text.length).toBeLessThanOrEqual(TELEGRAM_RICH_MESSAGE_LIMIT);
    expect(chunk.fallbackText.length).toBeLessThanOrEqual(TELEGRAM_RICH_MESSAGE_LIMIT);
  });

  it("falls back to plain text when Telegram HTML formatting fails", () => {
    vi.spyOn(formatModule, "formatTelegramHTML").mockImplementation(() => {
      throw new Error("broken formatter");
    });

    expect(formatMarkdownMessage("hello <world>")).toEqual({
      text: "hello <world>",
      fallbackText: "hello <world>",
      parseMode: undefined,
    });
  });

  it("formats rich Markdown chunks without HTML conversion and neutralizes external media embeds", () => {
    const markdown = [
      "# Report",
      "",
      "| Metric | Value |",
      "| ------ | ----- |",
      "| Speed | **42 ms** |",
      "",
      "![chart](https://example.com/chart.png)",
      "![👍](tg://emoji?id=5368324170671202286)",
    ].join("\n");

    const rendered = formatRichMarkdownMessage(markdown);

    expect(rendered.delivery).toBe("rich-markdown");
    expect(rendered.parseMode).toBeUndefined();
    expect(rendered.text).toContain("# Report");
    expect(rendered.text).toContain("| Metric | Value |");
    expect(rendered.text).toContain("[chart](https://example.com/chart.png)");
    expect(rendered.text).not.toContain("![chart]");
    expect(rendered.text).toContain("![👍](tg://emoji?id=5368324170671202286)");
    expect(rendered.fallbackText).toBe(markdown);
  });

  it("splits rich Markdown with Telegram's rich-message limit", () => {
    const markdown = `${"a".repeat(TELEGRAM_RICH_MESSAGE_LIMIT)}${"b".repeat(100)}`;
    const chunks = splitRichMarkdownForTelegram(markdown);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.delivery === "rich-markdown")).toBe(true);
    expect(chunks.every((chunk) => chunk.text.length <= TELEGRAM_RICH_MESSAGE_LIMIT)).toBe(true);
    expect(chunks.map((chunk) => chunk.sourceText).join("")).toBe(markdown);
  });

  it("detects Markdown that benefits from Telegram rich messages", () => {
    expect(isRichMarkdownCandidate("# Heading\n\nBody")).toBe(true);
    expect(isRichMarkdownCandidate("| A | B |\n|---|---|\n| 1 | 2 |")).toBe(true);
    expect(isRichMarkdownCandidate("Text with a footnote[^1].\n\n[^1]: Details")).toBe(true);
    expect(isRichMarkdownCandidate("Plain **bold** text")).toBe(false);
  });

  it("provides utility helpers for previews and string cleanup", () => {
    expect(findPreferredSplitIndex("line1\nline2", 6)).toBe(5);
    expect(findPreferredSplitIndex("word1 word2", 8)).toBe(5);
    expect(findPreferredSplitIndex("abcdef", 3)).toBe(3);

    expect(buildStreamingPreview("a".repeat(3801))).toContain("… streaming (preview truncated)");
    expect(appendWithCap("abc", "def", 4)).toBe("cdef");
    expect(summarizeToolOutput(`  ${"x".repeat(510)}  `)).toBe(`${"x".repeat(500)}\n…`);
    expect(trimLine("one   two\nthree", 7)).toBe("one tw…");
    expect(stripHtml("<b>Hello</b> <code>world</code>")).toBe("Hello world");
    expect(getWorkspaceShortName("/workspace/project")).toBe("project");
    expect(getWorkspaceShortName("C:\\workspace\\project")).toBe("project");
  });

  it("recognizes Telegram parse and message-not-modified errors", () => {
    expect(isMessageNotModifiedError(new Error("Bad Request: message is not modified"))).toBe(true);
    expect(isMessageNotModifiedError(new Error("other"))).toBe(false);

    expect(isTelegramParseError(new Error("Bad Request: can't parse entities"))).toBe(true);
    expect(isTelegramParseError(new Error("unsupported start tag at byte offset 1"))).toBe(true);
    expect(isTelegramParseError(new Error("Entity name expected"))).toBe(true);
    expect(isTelegramParseError(new Error("plain failure"))).toBe(false);
  });
});
