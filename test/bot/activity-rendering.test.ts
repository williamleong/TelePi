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

  it("rolls over without dropping long thinking text", () => {
    const source = `start-${"x".repeat(9000)}-end`;
    const transcript = createActivityTranscript();
    transcript.appendThinking({ blockKey: "1:0", delta: source });
    const chunks = renderActivityTranscript(transcript);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.text.length <= 4000)).toBe(true);
    expect(chunks.every((chunk) => chunk.fallbackText.length <= 4000)).toBe(true);
    const reconstructed = chunks
      .map((chunk) => chunk.fallbackText)
      .join("\n")
      .replaceAll("🧠 Thinking\n", "")
      .replaceAll("🧠 Thinking (continued)\n", "");
    expect(reconstructed.replaceAll("\n", "")).toBe(source);
  });
});
