/**
 * Parse a Claude Code stream-json line and extract a tool_use indicator.
 * Returns null for non-tool events (text deltas, system, result, etc.).
 *
 * Expected event shape (Claude Code CLI):
 *   {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{...}}]}}
 */
export interface ToolUseIndicator {
  name: string;
  brief: string;
}

export function parseClaudeStreamLine(line: string): ToolUseIndicator | null {
  const t = line.trim();
  if (!t || t[0] !== "{") return null;
  let obj: unknown;
  try { obj = JSON.parse(t); } catch { return null; }
  if (!obj || typeof obj !== "object") return null;
  const evt = obj as { type?: string; message?: { content?: unknown[] } };
  if (evt.type !== "assistant" || !evt.message?.content) return null;
  for (const block of evt.message.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; name?: string; input?: unknown };
    if (b.type === "tool_use" && typeof b.name === "string") {
      return { name: b.name, brief: briefForTool(b.name, b.input) };
    }
  }
  return null;
}

function briefForTool(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  if (name === "Bash") return shorten(asStr(i.command), 100);
  if (name === "Read" || name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
    return shorten(asStr(i.file_path) || asStr(i.notebook_path), 100);
  }
  if (name === "Grep") return shorten(asStr(i.pattern), 80);
  if (name === "Glob") return shorten(asStr(i.pattern), 80);
  if (name === "WebFetch" || name === "WebSearch") return shorten(asStr(i.url) || asStr(i.query), 100);
  if (name.startsWith("mcp__")) return ""; // tool name itself already carries the server+tool info
  // Fallback: pick first short string-valued field.
  for (const v of Object.values(i)) {
    if (typeof v === "string" && v.length < 200) return shorten(v, 80);
  }
  return "";
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function shorten(s: string, max: number): string {
  if (!s) return "";
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/**
 * Heuristic progress detector for codex/pi raw text output.
 * Returns a brief one-line indicator if the line looks like meaningful progress,
 * else null. Used to throttle "still working" notifications without flooding chat.
 */
export function detectProgressLine(line: string): string | null {
  const stripped = stripAnsi(line).trim();
  if (!stripped) return null;
  if (stripped.length < 8) return null;
  // Drop pure timestamps/log frames that carry no signal.
  if (/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z?\]?\s*$/.test(stripped)) return null;
  // Codex prints "running command: <cmd>" — surface it.
  const cmdMatch = stripped.match(/running command:\s*(.+)/i);
  if (cmdMatch) return `Bash: ${shorten(cmdMatch[1], 100)}`;
  // Codex/pi tool-call markers (best-effort).
  if (/^(>|[-*])\s+(reading|writing|editing|running|searching|fetching)\b/i.test(stripped)) {
    return shorten(stripped.replace(/^(>|[-*])\s+/, ""), 120);
  }
  return null;
}

export function stripAnsi(s: string): string {
  // ESC [ ... letter — basic SGR/CSI strip
  return s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "");
}

/**
 * Parse a Gemini CLI `-o stream-json` line.
 *
 * Observed event shapes (Gemini 0.42):
 *   {"type":"init","session_id":"…","model":"…"}
 *   {"type":"message","role":"user","content":"…"}
 *   {"type":"message","role":"assistant","content":"…","delta":true}
 *   {"type":"result","status":"success","stats":{…}}
 *
 * We surface text deltas (assistant + delta:true) for live streaming,
 * and propagate the final "result" event so the caller knows when to
 * stop polling. Tool-use events aren't part of Gemini's documented
 * schema in 0.42, so detectProgressLine() picks up any free-form
 * progress hints from stdout instead.
 */
export type GeminiStreamEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "result"; ok: boolean }
  | { kind: "other" };

export function parseGeminiStreamLine(line: string): GeminiStreamEvent | null {
  const t = line.trim();
  if (!t || t[0] !== "{") return null;
  let obj: unknown;
  try { obj = JSON.parse(t); } catch { return null; }
  if (!obj || typeof obj !== "object") return null;
  const evt = obj as { type?: string; role?: string; content?: unknown; delta?: boolean; status?: string };
  if (evt.type === "message" && evt.role === "assistant" && evt.delta === true && typeof evt.content === "string") {
    return { kind: "text-delta", text: evt.content };
  }
  if (evt.type === "result") {
    return { kind: "result", ok: evt.status === "success" };
  }
  return { kind: "other" };
}
