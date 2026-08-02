import {
  createActivityTranscript,
  renderActivityTranscript,
} from "../../src/bot/activity-rendering.js";

describe("activity transcript", () => {
  it("assembles thinking blocks verbatim and preserves event order", () => {
    const transcript = createActivityTranscript();
    transcript.appendThinking({ blockKey: "1:0", delta: "Inspect <src>" });
    transcript.appendThinking({ blockKey: "1:0", delta: " & tests" });
    transcript.startTool("tool-1", "read", { path: "src/a.ts" });
    transcript.appendThinking({ blockKey: "2:0", delta: "Run tests" });

    expect(transcript.entries).toEqual([
      { kind: "thinking", blockKey: "1:0", text: "Inspect <src> & tests" },
      {
        kind: "tool",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "src/a.ts" },
        status: "running",
      },
      { kind: "thinking", blockKey: "2:0", text: "Run tests" },
    ]);
  });

  it("updates tool completion in place", () => {
    const transcript = createActivityTranscript();
    transcript.startTool("tool-1", "bash", { command: "npm test" });
    transcript.finishTool("tool-1", false);
    expect(transcript.entries[0]).toMatchObject({ status: "success" });
    transcript.finishTool("tool-1", true);
    expect(transcript.entries[0]).toMatchObject({ status: "error" });
  });

  it("updates only Agent activity from structured partial results", () => {
    const transcript = createActivityTranscript();
    transcript.startTool("agent-1", "Agent", { description: "Find relevant code" });

    expect(transcript.updateTool("agent-1", {
      details: { activity: "running command…" },
    })).toBe(true);
    expect(transcript.updateTool("agent-1", {
      details: { activity: "running command…" },
    })).toBe(false);
    expect(transcript.updateTool("missing", {
      details: { activity: "reading…" },
    })).toBe(false);

    expect(renderActivityTranscript(transcript)[0]?.fallbackText).toContain(
      "• Agent — Find relevant code\nrunning command…",
    );

    transcript.finishTool("agent-1", false);
    expect(renderActivityTranscript(transcript)[0]?.fallbackText).toContain(
      "✓ Agent — Find relevant code\nDone",
    );
  });

  it("shows Error when an Agent fails", () => {
    const transcript = createActivityTranscript();
    transcript.startTool("agent-1", "Agent", { description: "Find relevant code" });
    transcript.updateTool("agent-1", { details: { activity: "reading…" } });

    transcript.finishTool("agent-1", true);

    expect(renderActivityTranscript(transcript)[0]?.fallbackText).toContain(
      "✗ Agent — Find relevant code\nError",
    );
  });

  it.each([null, [], {}, { details: null }, { details: { activity: " " } }])(
    "ignores malformed Agent update %j",
    (partialResult) => {
      const transcript = createActivityTranscript();
      transcript.startTool("agent-1", "Agent", {});
      expect(transcript.updateTool("agent-1", partialResult)).toBe(false);
    },
  );

  it("ignores structured updates for other tools", () => {
    const transcript = createActivityTranscript();
    transcript.startTool("bash-1", "bash", { command: "npm test" });

    expect(transcript.updateTool("bash-1", {
      details: { activity: "must not appear" },
    })).toBe(false);
    expect(renderActivityTranscript(transcript)[0]?.fallbackText).not.toContain("must not appear");
  });

  it("ignores Agent updates whose activity accessor throws", () => {
    const transcript = createActivityTranscript();
    transcript.startTool("agent-1", "Agent", {});
    const partialResult = Object.defineProperty({}, "details", {
      get() {
        throw new Error("unsafe accessor");
      },
    });

    expect(transcript.updateTool("agent-1", partialResult)).toBe(false);
  });

  it("keeps the Agent chunk stable when completion shortens live activity", () => {
    const transcript = createActivityTranscript();
    transcript.appendThinking({ blockKey: "1:0", delta: "x".repeat(3_900) });
    transcript.startTool("agent-1", "Agent", { description: "Find relevant code" });
    transcript.updateTool("agent-1", {
      details: { activity: "running command ".repeat(30) },
    });
    const runningChunks = renderActivityTranscript(transcript);

    transcript.finishTool("agent-1", false);
    const completedChunks = renderActivityTranscript(transcript);

    expect(runningChunks).toHaveLength(2);
    expect(completedChunks).toHaveLength(runningChunks.length);
    expect(completedChunks[1]?.fallbackText).toContain("Done");
  });

  it("bounds oversized Agent descriptions instead of dropping the row", () => {
    const transcript = createActivityTranscript();
    transcript.startTool("agent-1", "Agent", { description: "x".repeat(5_000) });

    const chunks = renderActivityTranscript(transcript);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.fallbackText).toMatch(/^• Agent — x+…$/);
    expect(chunks[0]?.fallbackText.length).toBeLessThanOrEqual(4000);
  });

  it.each([
    ["read", { path: "src/a.ts" }, "🔍 Read\nsrc/a.ts"],
    ["bash", { command: "npm test" }, "⌨️ Bash\nnpm test"],
    ["edit", { path: "src/a.ts", edits: [] }, "✏️ Edit\nsrc/a.ts"],
    ["write", { path: "src/new.ts", content: "secret" }, "📝 Write\nsrc/new.ts"],
    ["grep", { pattern: "needle", path: "src" }, "🔎 Grep\nneedle in src"],
    ["find", { pattern: "*.ts", path: "src" }, "📁 Find\n*.ts in src"],
    ["ls", {}, "📂 LS\n."],
  ])("formats %s from allowlisted fields", (toolName, args, expected) => {
    const transcript = createActivityTranscript();
    transcript.startTool("tool-1", toolName, args);
    const [chunk] = renderActivityTranscript(transcript);
    expect(chunk.fallbackText).toContain(expected);
  });

  it("hides unknown tool arguments", () => {
    const transcript = createActivityTranscript();
    transcript.startTool("tool-1", "deploy_secret", { token: "must-not-appear" });
    const [chunk] = renderActivityTranscript(transcript);

    expect(chunk.fallbackText).toContain("Deploy Secret");
    expect(chunk.fallbackText).not.toContain("must-not-appear");
  });

  it("escapes HTML while preserving plain thinking text", () => {
    const transcript = createActivityTranscript();
    transcript.appendThinking({ blockKey: "1:0", delta: "Check <tag> & value" });
    const [chunk] = renderActivityTranscript(transcript);

    expect(chunk.text).toContain("Check &lt;tag&gt; &amp; value");
    expect(chunk.fallbackText).toContain("Check <tag> & value");
    expect(chunk.parseMode).toBe("HTML");
  });

  it("renders compact thinking and tool blocks with normalized separators", () => {
    const transcript = createActivityTranscript();
    transcript.appendThinking({ blockKey: "1:0", delta: "Inspecting state\n\n" });
    transcript.startTool("tool-1", "bash", { command: "npm test" });

    expect(renderActivityTranscript(transcript)).toEqual([{
      text: "🧠 Thinking\nInspecting state\n\n<b>• ⌨️ Bash</b>\n<code>npm test</code>",
      fallbackText: "🧠 Thinking\nInspecting state\n\n• ⌨️ Bash\nnpm test",
      parseMode: "HTML",
      sourceText: "🧠 Thinking\nInspecting state\n\n• ⌨️ Bash\nnpm test",
    }]);
  });

  it("separates adjacent tool blocks in HTML and fallback output", () => {
    const transcript = createActivityTranscript();
    transcript.startTool("tool-1", "bash", { command: "npm test" });
    transcript.startTool("tool-2", "read", { path: "src/a.ts" });

    expect(renderActivityTranscript(transcript)).toEqual([{
      text: "<b>• ⌨️ Bash</b>\n<code>npm test</code>\n\n<b>• 🔍 Read</b>\n<code>src/a.ts</code>",
      fallbackText: "• ⌨️ Bash\nnpm test\n\n• 🔍 Read\nsrc/a.ts",
      parseMode: "HTML",
      sourceText: "• ⌨️ Bash\nnpm test\n\n• 🔍 Read\nsrc/a.ts",
    }]);
  });

  it("rolls over when the two-newline separator no longer fits", () => {
    const transcript = createActivityTranscript();
    transcript.appendThinking({ blockKey: "1:0", delta: "x".repeat(3949) });
    transcript.startTool("tool-1", "bash", { command: "npm test" });

    const chunks = renderActivityTranscript(transcript);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => !chunk.text.startsWith("\n") && !chunk.text.endsWith("\n"))).toBe(true);
    expect(chunks.every((chunk) => !chunk.fallbackText.startsWith("\n") && !chunk.fallbackText.endsWith("\n"))).toBe(true);
  });

  it("rolls over without bold continued thinking headings", () => {
    const source = `start-${"x".repeat(9000)}-end`;
    const transcript = createActivityTranscript();
    transcript.appendThinking({ blockKey: "1:0", delta: source });
    const chunks = renderActivityTranscript(transcript);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.text.length <= 4000)).toBe(true);
    expect(chunks.every((chunk) => chunk.fallbackText.length <= 4000)).toBe(true);
    expect(chunks.slice(1).every((chunk) =>
      chunk.text.startsWith("🧠 Thinking (continued)\n")
    )).toBe(true);
    const reconstructed = chunks
      .map((chunk) => chunk.fallbackText.replace(/^🧠 Thinking(?: \(continued\))?\n?/, ""))
      .join("");
    expect(reconstructed).toBe(source);
  });

  it("preserves boundary spaces and newlines when thinking rolls over", () => {
    const source = `${"alpha \n".repeat(2_000)}tail \n\n`;
    const normalizedSource = source.trimEnd();
    const transcript = createActivityTranscript();
    transcript.appendThinking({ blockKey: "1:0", delta: source });
    const chunks = renderActivityTranscript(transcript);

    expect(chunks.length).toBeGreaterThan(2);
    const reconstructed = chunks
      .map((chunk) => chunk.fallbackText.replace(/^🧠 Thinking(?: \(continued\))?\n?/, ""))
      .join("");
    expect(reconstructed).toBe(normalizedSource);
  });
});
