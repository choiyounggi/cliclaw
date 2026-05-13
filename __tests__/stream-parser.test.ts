import { describe, it, expect } from "vitest";
import { parseClaudeStreamLine, detectProgressLine, stripAnsi } from "../lib/stream-parser.ts";

describe("parseClaudeStreamLine", () => {
  it("extracts Bash tool with command brief", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la /etc" } }] },
    });
    expect(parseClaudeStreamLine(line)).toEqual({ name: "Bash", brief: "ls -la /etc" });
  });

  it("extracts Read tool with file_path", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/x.ts" } }] },
    });
    expect(parseClaudeStreamLine(line)).toEqual({ name: "Read", brief: "/tmp/x.ts" });
  });

  it("truncates long Bash commands with ellipsis", () => {
    const longCmd = "echo " + "a".repeat(200);
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: longCmd } }] },
    });
    const r = parseClaudeStreamLine(line)!;
    expect(r.brief.length).toBeLessThanOrEqual(100);
    expect(r.brief.endsWith("…")).toBe(true);
  });

  it("returns null for non-assistant events", () => {
    expect(parseClaudeStreamLine(JSON.stringify({ type: "result", result: "done" }))).toBeNull();
    expect(parseClaudeStreamLine(JSON.stringify({ type: "system" }))).toBeNull();
  });

  it("returns null for assistant text-only blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    expect(parseClaudeStreamLine(line)).toBeNull();
  });

  it("returns null for invalid JSON / empty / non-object lines", () => {
    expect(parseClaudeStreamLine("")).toBeNull();
    expect(parseClaudeStreamLine("not json")).toBeNull();
    expect(parseClaudeStreamLine("   ")).toBeNull();
    expect(parseClaudeStreamLine("123")).toBeNull();
  });

  it("MCP tools: name only, no brief required", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "mcp__rtb__query_db", input: { sql: "SELECT 1" } }] },
    });
    const r = parseClaudeStreamLine(line)!;
    expect(r.name).toBe("mcp__rtb__query_db");
    expect(r.brief).toBe("");
  });

  it("collapses multi-line whitespace in brief", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo a\n  b\n\tc" } }] },
    });
    expect(parseClaudeStreamLine(line)!.brief).toBe("echo a b c");
  });
});

describe("detectProgressLine", () => {
  it("surfaces codex 'running command:' marker", () => {
    expect(detectProgressLine("running command: ls -la")).toBe("Bash: ls -la");
  });

  it("surfaces pi-style '> reading file ...' marker", () => {
    expect(detectProgressLine("> reading file: /etc/hosts")).toBe("reading file: /etc/hosts");
  });

  it("ignores empty and whitespace-only lines", () => {
    expect(detectProgressLine("")).toBeNull();
    expect(detectProgressLine("   ")).toBeNull();
  });

  it("ignores short lines without signal", () => {
    expect(detectProgressLine("ok")).toBeNull();
  });

  it("ignores bare timestamps", () => {
    expect(detectProgressLine("[2026-05-13T12:00:00Z]")).toBeNull();
  });

  it("strips ANSI escapes before matching", () => {
    expect(detectProgressLine("\x1b[32mrunning command:\x1b[0m npm test")).toBe("Bash: npm test");
  });
});

describe("stripAnsi", () => {
  it("removes SGR color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });
  it("removes cursor movement codes", () => {
    expect(stripAnsi("\x1b[2K\x1b[1Ahello")).toBe("hello");
  });
  it("preserves plain text", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });
});
