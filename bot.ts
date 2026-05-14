#!/usr/bin/env bun
/// <reference types="bun" />
/// <reference types="node" />
/**
 * Telegram → multi-agent CLI bridge (claude / codex / pi).
 * Long-polls Telegram, dispatches messages to the currently-selected agent
 * for that chat, and persists per-agent session state so conversations resume.
 *
 * v0.4 additions on top of v0.3:
 *  - confirm gate: dangerous Bash commands prompt the user via Telegram inline
 *    keyboard before execution (claude + codex). Hook lives in bin/bash-confirm.ts
 *    and talks to the bot over a Unix socket.
 *  - callback_query handling for the confirm buttons.
 *  - per-chat hook installation (workspace/.claude/settings.json for Claude;
 *    merged hooks.json in each CODEX_HOME for Codex).
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, symlinkSync, unlinkSync, lstatSync } from "fs";
import { join, dirname, resolve as resolvePath } from "path";
import { homedir } from "os";

import { JobRegistry, type Job } from "./lib/job-registry.ts";
import { createAuditWriter, type AuditWriter } from "./lib/audit-log.ts";
import { runSubprocessStream } from "./lib/subprocess-stream.ts";
import { parseClaudeStreamLine, detectProgressLine, stripAnsi } from "./lib/stream-parser.ts";
import { ConfirmServer, type ConfirmRequest } from "./lib/confirm-server.ts";
import {
  installBashConfirmHook,
  installSafetyDeny,
  uninstallSafetyDeny,
} from "./lib/hook-installer.ts";
import { createStreamingMessage, type StreamingMessage } from "./lib/telegram-stream.ts";
import { createToolIndicator, type ToolIndicator } from "./lib/tool-indicator.ts";
import { markdownToTelegramHtml } from "./lib/telegram-html.ts";
import { downloadTelegramFile, inferExtension, makeMediaPath } from "./lib/media-download.ts";
import { resolveCliPath } from "./lib/resolve-cli-path.ts";

// ---------- types ----------
type Agent = "claude" | "codex" | "pi" | "gemini";
// All agents this bot knows how to drive. Populated at boot from ALL_AGENTS
// minus any whose CLI we cannot locate — see the install detection block
// further down. Code that needs to know which agents are *actually* usable
// in this process should read AGENT_NAMES.
const ALL_AGENTS = ["claude", "codex", "pi", "gemini"] as const;
let AGENT_NAMES: Agent[] = [...ALL_AGENTS];

interface ClaudeAgentConfig { path: string; model: string; maxTurns?: number; timeoutMs?: number; idleTimeoutMs?: number; }
interface CodexAgentConfig  { path: string; model: string | null; sandbox: "read-only" | "workspace-write" | "danger-full-access"; maxTurns?: number; timeoutMs?: number; idleTimeoutMs?: number; }
interface PiAgentConfig     { path: string; model: string | null; provider: string | null; maxTurns?: number; timeoutMs?: number; idleTimeoutMs?: number; }
interface GeminiAgentConfig { path: string; model: string | null; approvalMode?: "default" | "auto_edit" | "yolo" | "plan"; maxTurns?: number; timeoutMs?: number; idleTimeoutMs?: number; }

interface ConfirmGateConfig {
  enabled?: boolean;
  pendingTimeoutMs?: number;
  /** Extra regex sources merged into DEFAULT_DANGER_PATTERNS. */
  extraPatterns?: string[];
}

interface StreamingConfig {
  /** Stream the Claude answer incrementally via editMessageText. Default true. */
  enabled?: boolean;
  /** Pass --include-partial-messages to claude for per-token deltas. Default true. */
  claudePartialMessages?: boolean;
  /** Min interval between edits in ms (Telegram rate limit cushion). Default 1500. */
  minIntervalMs?: number;
}

interface Config {
  token: string;
  allowedUserIds: number[];
  cwd: string;
  defaultAgent: Agent;
  agents: {
    claude: ClaudeAgentConfig;
    codex: CodexAgentConfig;
    pi: PiAgentConfig;
    gemini: GeminiAgentConfig;
  };
  sessionTimeoutMs: number;
  /** Default idle (no-stdout) timeout applied to all agents unless overridden. ms. */
  idleTimeoutMs?: number;
  pollTimeoutSec: number;
  logLevel: "debug" | "info" | "error";
  confirmGate?: ConfirmGateConfig;
  streaming?: StreamingConfig;
}

interface TgUser { id: number; username?: string; first_name?: string; }
interface TgChat { id: number; type: string; }
interface TgPhotoSize { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number; }
interface TgDocument { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number; }
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  date: number;
}
interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

interface AgentSession {
  sessionId: string | null;
  turnCount: number;
  createdAt: string;
  lastUsedAt: string;
}

interface ChatState {
  active: Agent;
  agents: Partial<Record<Agent, AgentSession>>;
}

interface AgentResult {
  sessionId: string | null;
  text: string;
  error: string | null;
}

// ---------- paths ----------
// ROOT = where the bot source lives (npm/bun global install location, or a
// local checkout). HOOK_SCRIPT must live next to the source because Claude/
// Codex spawn it via PreToolUse hook.
// HOME = where this user's runtime state lives (config, sessions, logs,
// sockets, workspace). Defaults to ~/.cliclaw; override with $CLICLAW_HOME.
// Splitting these lets multiple users on one machine share one global
// install while keeping per-user state isolated.
const ROOT = dirname(Bun.fileURLToPath(import.meta.url));
const HOME = process.env.CLICLAW_HOME
  ? resolvePath(process.env.CLICLAW_HOME)
  : join(homedir(), ".cliclaw");
const CONFIG_FILE = join(HOME, "config.json");
const SESSIONS_FILE = join(HOME, "sessions.json");
const LOG_FILE = join(HOME, "logs", "bot.log");
const AUDIT_FILE = join(HOME, "logs", "audit.jsonl");
const SESSION_ROOT = join(HOME, "sessions");
const HOOK_SCRIPT = resolvePath(ROOT, "bin/bash-confirm.ts");
const SOCKET_PATH = join(HOME, ".sock", "confirm.sock");
const EXTRA_PATTERNS_FILE = join(HOME, ".sock", "danger-patterns.json");
const UPLOADS_ROOT = join(HOME, "workspace", "uploads");

mkdirSync(dirname(LOG_FILE), { recursive: true });
mkdirSync(SESSION_ROOT, { recursive: true });
mkdirSync(dirname(SOCKET_PATH), { recursive: true });

// ---------- config ----------
const config: Config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
if (!config.token || config.token.startsWith("PASTE_")) {
  console.error("config.json: token not set");
  process.exit(1);
}
// Resolve agent CLI paths. A blank or missing `path` triggers auto-discovery
// (well-known locations, nvm scan, login-shell fallback) so the bot works on
// any user's machine without hand-edited absolute paths. An explicit path that
// exists is honored as-is — auto-discovery is opt-in by omission.
//
// Agents whose CLI cannot be located are DROPPED from AGENT_NAMES rather than
// killing the bot — users routinely pick a subset (claude only, or claude +
// codex without pi, etc.) and earlier versions refused to start in that case.
{
  // A config.json written by an older cliclaw (before a given agent
  // existed) won't have that agent's entry at all. Auto-create a minimal
  // placeholder so the resolver + later config.agents[a].path = ...
  // assignment don't crash with "undefined is not an object". Defaults
  // mirror config.example.json shape; the user is free to edit them.
  const defaultAgentEntries: Record<Agent, () => Record<string, unknown>> = {
    claude: () => ({ path: "", model: "sonnet", maxTurns: 100 }),
    codex:  () => ({ path: "", model: null, sandbox: "workspace-write", maxTurns: 50 }),
    pi:     () => ({ path: "", model: null, provider: null, maxTurns: 50 }),
    gemini: () => ({ path: "", model: null, approvalMode: "auto_edit", maxTurns: 50 }),
  };
  const agents = config.agents as unknown as Record<Agent, unknown>;
  for (const a of ALL_AGENTS) {
    if (!agents[a]) agents[a] = defaultAgentEntries[a]();
  }

  const usable: Agent[] = [];
  for (const a of AGENT_NAMES) {
    const p = config.agents[a]?.path;
    if (p && existsSync(p)) { usable.push(a); continue; }
    const resolved = resolveCliPath(a);
    if (!resolved) {
      const detail = p
        ? `configured path missing (${p}) and auto-discovery failed`
        : "not installed (auto-discovery found no binary)";
      console.error(`config.json: agents.${a} skipped — ${detail}.`);
      continue;
    }
    if (p && p !== resolved) {
      console.error(`config.json: agents.${a}.path missing (${p}); using ${resolved}`);
    } else if (!p) {
      console.error(`config.json: agents.${a}.path auto-resolved to ${resolved}`);
    }
    config.agents[a]!.path = resolved;
    usable.push(a);
  }
  AGENT_NAMES = usable;
}
if (AGENT_NAMES.length === 0) {
  console.error(
    "No coding agent CLIs are available on this machine. " +
      "Install at least one of: claude (Claude Code), codex, pi.",
  );
  process.exit(1);
}
if (!AGENT_NAMES.includes(config.defaultAgent)) {
  console.error(
    `config.json: defaultAgent='${config.defaultAgent}' is not installed; ` +
      `falling back to '${AGENT_NAMES[0]}'. ` +
      `Available: ${AGENT_NAMES.join(", ")}.`,
  );
  config.defaultAgent = AGENT_NAMES[0];
}
// Resolve a relative cwd against the user's CLICLAW_HOME so launchctl /
// cron / arbitrary working directories all yield the same workspace path.
config.cwd = resolvePath(HOME, config.cwd);
mkdirSync(config.cwd, { recursive: true });

// `confirmGateEnabled` reflects whether the hook infrastructure is wired up
// at all (set once at boot from config). `safetyEnabled` is the runtime
// toggle the user flips via /safety on|off — it gates whether IPC requests
// from the installed hook actually prompt the user or get auto-allowed.
// Separating the two lets /safety stay a soft switch without needing to
// (re)install hooks at runtime.
const confirmGateEnabled = config.confirmGate?.enabled !== false; // default ON
const SAFETY_FILE = join(HOME, "safety.json");

function loadSafety(): boolean {
  if (!confirmGateEnabled) return false; // hook missing → toggle is a no-op
  try {
    const parsed = JSON.parse(readFileSync(SAFETY_FILE, "utf8")) as { enabled?: unknown };
    if (typeof parsed.enabled === "boolean") return parsed.enabled;
  } catch { /* no persisted state yet */ }
  return true; // default ON when hook infra is up
}

function saveSafety(enabled: boolean): void {
  try { writeFileSync(SAFETY_FILE, JSON.stringify({ enabled }, null, 2)); }
  catch (err) { log("error", `persist safety state failed: ${err}`); }
}

let safetyEnabled = loadSafety();
const confirmPendingTimeoutMs = config.confirmGate?.pendingTimeoutMs ?? 5 * 60 * 1000;
const extraDangerPatterns = config.confirmGate?.extraPatterns ?? [];
const streamingEnabled = config.streaming?.enabled !== false;
const claudePartialMessages = config.streaming?.claudePartialMessages !== false;
const streamMinIntervalMs = config.streaming?.minIntervalMs ?? 1500;

function agentTimeoutMs(agent: Agent): number {
  return config.agents[agent].timeoutMs ?? config.sessionTimeoutMs;
}
function agentIdleTimeoutMs(agent: Agent): number | undefined {
  return config.agents[agent].idleTimeoutMs ?? config.idleTimeoutMs;
}
function agentModeLabel(agent: Agent): string {
  const safetyTag = safetyEnabled ? " + 안전모드 ON" : "";
  if (agent === "claude") return confirmGateEnabled ? `헤드리스${safetyTag}` : "헤드리스";
  if (agent === "codex")  return `sandbox=${config.agents.codex.sandbox}${confirmGateEnabled ? safetyTag : ""}`;
  if (agent === "pi")     return "기본";
  return "?";
}

// Persist user-supplied extra patterns to a file the hook can read.
writeFileSync(EXTRA_PATTERNS_FILE, JSON.stringify(extraDangerPatterns));

// ---------- logging ----------
// Redact secrets before any log write. Telegram bot tokens and npm
// automation tokens have predictable shapes — we mask both, plus the
// exact `config.token` string in case a future fetch error embeds the
// API URL verbatim. The redacted form keeps the first few chars so
// audit logs are still useful for distinguishing tokens at a glance.
const TG_TOKEN_RE = /\d{8,}:[A-Za-z0-9_-]{30,}/g;
const NPM_TOKEN_RE = /npm_[A-Za-z0-9]{30,}/g;
const GH_TOKEN_RE  = /gh[pousr]_[A-Za-z0-9]{30,}/g;

function redact(msg: string): string {
  let out = msg;
  if (config?.token) {
    out = out.split(config.token).join("[REDACTED:bot-token]");
  }
  out = out
    .replace(TG_TOKEN_RE, (m) => `${m.slice(0, 6)}…[REDACTED:bot-token]`)
    .replace(NPM_TOKEN_RE, "[REDACTED:npm-token]")
    .replace(GH_TOKEN_RE, "[REDACTED:gh-token]");
  return out;
}

function log(level: "debug" | "info" | "error", msg: string): void {
  const order = { debug: 0, info: 1, error: 2 };
  if (order[level] < order[config.logLevel]) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${redact(msg)}\n`;
  process.stdout.write(line);
  try { appendFileSync(LOG_FILE, line); } catch {}
}

const audit: AuditWriter = createAuditWriter(AUDIT_FILE);
const jobs = new JobRegistry();

// ---------- session store ----------
type SessionStore = Record<string, ChatState>;

function loadStore(): SessionStore {
  try { return JSON.parse(readFileSync(SESSIONS_FILE, "utf8")); }
  catch { return {}; }
}
function saveStore(s: SessionStore): void {
  writeFileSync(SESSIONS_FILE, JSON.stringify(s, null, 2));
}
function getChat(store: SessionStore, chatId: number): ChatState {
  const key = String(chatId);
  if (!store[key]) store[key] = { active: config.defaultAgent, agents: {} };
  // The stored `active` may name an agent whose CLI got uninstalled between
  // runs. Don't dispatch to a missing binary — silently rewind to the boot
  // defaultAgent and let the user re-select with /claude /codex /pi.
  if (!AGENT_NAMES.includes(store[key].active)) {
    store[key].active = config.defaultAgent;
  }
  return store[key];
}
function getOrInitAgentSession(chat: ChatState, agent: Agent): AgentSession {
  if (!chat.agents[agent]) {
    chat.agents[agent] = {
      sessionId: null,
      turnCount: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
  }
  return chat.agents[agent]!;
}
function agentSessionDir(agent: Agent, chatId: number): string {
  const dir = join(SESSION_ROOT, agent, String(chatId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- telegram api ----------
const API = `https://api.telegram.org/bot${config.token}`;

async function tg<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json() as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(`tg ${method}: ${data.description}`);
  return data.result as T;
}

const MAX_LEN = 4096;

/**
 * Send agent / system text as parse_mode=HTML when possible, falling back to
 * plain text on a Telegram parse-mode error so a malformed snippet from a
 * model never breaks message delivery.
 *
 * Long messages are chunked at MAX_LEN. Chunking is conservative — applied to
 * the HTML-converted output to respect Telegram's 4096-char limit.
 */
async function sendMessage(chatId: number, text: string): Promise<void> {
  if (!text) text = "(빈 응답)";
  const html = markdownToTelegramHtml(text);
  await sendChunkedHtml(chatId, html, text);
  audit.write({ chatId, type: "msg_out", data: { len: text.length } });
}

async function sendChunkedHtml(chatId: number, html: string, plainFallback: string): Promise<void> {
  for (let i = 0; i < html.length; i += MAX_LEN) {
    const chunk = html.slice(i, i + MAX_LEN);
    const plainChunk = plainFallback.slice(i, i + MAX_LEN);
    try {
      await tg("sendMessage", { chat_id: chatId, text: chunk, parse_mode: "HTML" });
    } catch (err) {
      // The model can produce HTML the parser doesn't accept (mismatched tags,
      // odd entities). Always retry the same chunk as plain text so the user
      // still sees the answer — log once for observability.
      log("error", `sendMessage HTML failed, retrying plain: ${err}`);
      audit.write({ chatId, type: "error", data: { op: "sendMessage", err: String(err) } });
      try { await tg("sendMessage", { chat_id: chatId, text: plainChunk }); }
      catch (err2) { log("error", `sendMessage plain also failed: ${err2}`); break; }
    }
  }
}

async function sendTyping(chatId: number): Promise<void> {
  try { await tg("sendChatAction", { chat_id: chatId, action: "typing" }); } catch {}
}

// ---------- tool indicator (single rolling bubble) ----------
// The indicator text is short and always shaped like "🔧 Tool: brief"; we still
// HTML-escape the brief to be safe against shell snippets that contain <, >, &.
import { escapeHtml } from "./lib/telegram-html.ts";

function makeToolIndicator(chatId: number): ToolIndicator {
  const send = async (cid: number, text: string): Promise<{ message_id: number }> => {
    const html = escapeHtml(text);
    try {
      const m = await tg<TgMessage>("sendMessage", { chat_id: cid, text: html, parse_mode: "HTML" });
      return { message_id: m.message_id };
    } catch {
      const m = await tg<TgMessage>("sendMessage", { chat_id: cid, text });
      return { message_id: m.message_id };
    }
  };
  const edit = async (cid: number, id: number, text: string): Promise<void> => {
    const html = escapeHtml(text);
    try { await tg("editMessageText", { chat_id: cid, message_id: id, text: html, parse_mode: "HTML" }); }
    catch { await tg("editMessageText", { chat_id: cid, message_id: id, text }); }
  };
  return createToolIndicator({
    chatId,
    minIntervalMs: 1500,
    send,
    edit,
    delete: async (cid, id) => { await tg("deleteMessage", { chat_id: cid, message_id: id }); },
    onError: (err) => log("error", `tool indicator: ${err instanceof Error ? err.message : err}`),
  });
}

// ---------- confirm gate ----------
interface ConfirmMsgRecord { messageId: number; chatId: number; }
const confirmMessages = new Map<string, ConfirmMsgRecord>();
let confirmServer: ConfirmServer | null = null;

function confirmMessageText(req: ConfirmRequest): string {
  const truncated = req.command.length > 800 ? req.command.slice(0, 800) + "…" : req.command;
  return [
    "⚠️ 위험 명령 확인",
    "",
    `에이전트: ${req.agent}`,
    `패턴: ${req.patternId} — ${req.reason}`,
    "",
    "명령:",
    truncated,
  ].join("\n");
}

function confirmOutcomeText(decision: "allow" | "deny", reason?: string): string {
  if (decision === "allow") return "✅ 허용됨";
  return reason ? `❌ 거부됨: ${reason}` : "❌ 거부됨";
}

if (confirmGateEnabled) {
  confirmServer = new ConfirmServer({
    socketPath: SOCKET_PATH,
    pendingTimeoutMs: confirmPendingTimeoutMs,
    onRequest: (req) => {
      audit.write({
        chatId: req.chatId, type: "confirm_ask", agent: req.agent,
        data: { requestId: req.requestId, patternId: req.patternId, command: req.command.slice(0, 500) },
      });
      void promptConfirm(req);
    },
  });
}

async function promptConfirm(req: ConfirmRequest): Promise<void> {
  // Runtime safety toggle: when OFF, the user has chosen to rely on their
  // own external Bash guards (pre-bash-guard, EDR, etc.) and we pass the
  // request straight through without surfacing a Telegram prompt.
  if (!safetyEnabled) {
    confirmServer?.respond(req.requestId, "allow", "안전모드 OFF (사용자 환경의 외부 가드에 위임)");
    audit.write({
      chatId: req.chatId, type: "confirm_decision", agent: req.agent,
      data: { requestId: req.requestId, patternId: req.patternId, decision: "allow", reason: "safety_off" },
    });
    return;
  }
  try {
    const msg = await tg<TgMessage>("sendMessage", {
      chat_id: req.chatId,
      text: confirmMessageText(req),
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ 허용", callback_data: `confirm:${req.requestId}:allow` },
          { text: "❌ 거부", callback_data: `confirm:${req.requestId}:deny` },
        ]],
      },
    });
    confirmMessages.set(req.requestId, { messageId: msg.message_id, chatId: req.chatId });
  } catch (err) {
    log("error", `confirm prompt failed: ${err}`);
    confirmServer?.respond(req.requestId, "deny", "사용자에게 프롬프트를 띄우지 못함");
  }
}

async function handleCallbackQuery(q: TgCallbackQuery): Promise<void> {
  const userId = q.from.id;
  if (!config.allowedUserIds.includes(userId)) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "권한 없음" });
    return;
  }
  const data = q.data ?? "";
  const m = data.match(/^confirm:([0-9a-f-]+):(allow|deny)$/);
  if (!m) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "잘못된 콜백" });
    return;
  }
  const [, requestId, decisionStr] = m;
  const decision = decisionStr as "allow" | "deny";
  const rec = confirmMessages.get(requestId);
  const handled = confirmServer?.respond(requestId, decision) ?? false;
  audit.write({
    chatId: rec?.chatId ?? q.message?.chat.id ?? 0, userId, type: "confirm_decision",
    data: { requestId, decision, handled },
  });
  await tg("answerCallbackQuery", {
    callback_query_id: q.id,
    text: handled ? (decision === "allow" ? "허용" : "거부") : "이미 만료됨",
  });
  if (rec && handled) {
    confirmMessages.delete(requestId);
    try {
      await tg("editMessageText", {
        chat_id: rec.chatId,
        message_id: rec.messageId,
        text: confirmOutcomeText(decision),
      });
    } catch { /* user may have deleted the message; ignore */ }
  }
}

// ---------- claude adapter ----------
async function runClaude(
  prompt: string,
  session: AgentSession | undefined,
  chatId: number,
  abort: AbortSignal,
  onProgress: (text: string) => void,
  stream: StreamingMessage | null,
): Promise<AgentResult> {
  const c = config.agents.claude;
  // bypassPermissions: headless 모드에서 권한 ask 프롬프트는 자동 거절로
  // 끝나 사용자 응답을 받을 수 없다. Bash 도구는 PreToolUse confirm 훅이
  // 텔레그램으로 다시 묻고, 그 외 도구(WebFetch 등)는 allowedUserIds로
  // 차단된 단일 채널이라는 봇 신뢰 경계에 위임한다.
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--model", c.model,
    "--permission-mode", "bypassPermissions",
  ];
  if (stream && claudePartialMessages) args.push("--include-partial-messages");
  // --continue resumes the most-recent session in cwd. More robust than
  // --resume <id>, which suffers ID drift between the stream's emitted
  // session_id and the on-disk session file name.
  const isContinuation = !!(session && session.turnCount > 0);
  if (isContinuation) args.push("--continue");

  log("debug", `claude args: --model ${c.model} ${isContinuation ? "--continue" : "(new)"} stream=${!!stream}`);

  let sessionId: string | null = null;
  let resultText = "";
  let errorDetail: string | null = null;
  let rawErrorPayload: string | null = null;
  // True when a tool_use was just emitted; the next text we append should
  // start a fresh paragraph so consecutive turns don't run together.
  let pendingParagraph = false;

  const appendStreamText = (text: string): void => {
    if (!stream || !text) return;
    if (pendingParagraph && stream.hasContent()) {
      stream.append("\n\n");
    }
    pendingParagraph = false;
    stream.append(text);
  };

  const onLine = (line: string): void => {
    const t = line.trim();
    if (!t) return;
    const tool = parseClaudeStreamLine(t);
    if (tool) {
      const briefMsg = tool.brief ? `🔧 ${tool.name}: ${tool.brief}` : `🔧 ${tool.name}`;
      audit.write({ chatId, type: "tool_use", agent: "claude", data: { name: tool.name, brief: tool.brief } });
      onProgress(briefMsg);
      // After a tool call, force a blank line before the model's next prose.
      pendingParagraph = true;
    }
    try {
      const obj = JSON.parse(t);
      if (obj.session_id && !sessionId) sessionId = obj.session_id;

      // tool_use can also arrive as a stream_event content_block_start —
      // mark the paragraph break early in that case too.
      if (
        obj.type === "stream_event" &&
        obj.event?.type === "content_block_start" &&
        obj.event?.content_block?.type === "tool_use"
      ) {
        pendingParagraph = true;
      }

      // Per-token deltas (when --include-partial-messages is on).
      if (obj.type === "stream_event" && obj.event?.type === "content_block_delta") {
        const d = obj.event.delta;
        if (d?.type === "text_delta" && typeof d.text === "string") {
          appendStreamText(d.text);
        }
      }

      // Whole content blocks (fallback when partial messages are disabled).
      if (stream && !claudePartialMessages && obj.type === "assistant" && obj.message?.content) {
        for (const block of obj.message.content) {
          if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
            appendStreamText(block.text + "\n");
          }
        }
      }

      if (obj.type === "result") {
        if (obj.is_error) {
          const candidates = [obj.result, obj.error, obj.message, obj.detail];
          const text = candidates.find((v: unknown) => typeof v === "string" && v.length > 0);
          const subtype = obj.subtype ? ` (subtype=${obj.subtype})` : "";
          const keys = ` keys=[${Object.keys(obj).join(",")}]`;
          errorDetail = (text as string | undefined) ?? `claude reported is_error=true${subtype}${keys}`;
          rawErrorPayload = JSON.stringify(obj).slice(0, 1500);
        } else if (typeof obj.result === "string") {
          resultText = obj.result;
        }
      }
    } catch { /* skip non-JSON */ }
  };

  const timeoutMs = agentTimeoutMs("claude");
  const idleTimeoutMs = agentIdleTimeoutMs("claude");
  const { exitCode, stderr, killedReason } = await runSubprocessStream(c.path, args, {
    cwd: config.cwd,
    env: confirmGateEnv(chatId, "claude"),
    timeoutMs,
    idleTimeoutMs,
    signal: abort,
    onStdoutLine: onLine,
  });

  if (killedReason === "abort") {
    return { sessionId, text: "", error: "사용자가 중지함" };
  }
  if (killedReason === "timeout") {
    return { sessionId, text: "", error: `타임아웃 (${timeoutMs}ms 초과)` };
  }
  if (killedReason === "idle") {
    return { sessionId, text: "", error: `무활동 타임아웃 (${idleTimeoutMs}ms)` };
  }

  if (errorDetail || rawErrorPayload) {
    log("error", `claude is_error payload: ${rawErrorPayload ?? errorDetail}`);
    if (stderr.trim()) log("error", `claude stderr: ${stderr.trim().slice(0, 1000)}`);
  }
  if (exitCode !== 0 && !resultText && !errorDetail) {
    errorDetail = stderr.trim().slice(0, 1000) || `exit ${exitCode}`;
    log("error", `claude exit=${exitCode} stderr=${stderr.slice(0, 500)}`);
  }
  return { sessionId, text: resultText, error: errorDetail };
}

// ---------- codex adapter helpers ----------
// Files we still safely symlink (auth, config, AGENTS.md, hook scripts, skills,
// rules, references). hooks.json is NOT in this list — we synthesize it per chat.
const CODEX_SHARED_ITEMS = [
  "auth.json",
  "config.toml",
  "AGENTS.md",
  "hooks",       // hook scripts dir (the user's own scripts referenced from hooks.json)
  "skills",
  "rules",
  "references",
];

function ensureCodexSharedFiles(codexHome: string): void {
  const userCodexHome = join(homedir(), ".codex");
  if (!existsSync(userCodexHome)) return;
  for (const f of CODEX_SHARED_ITEMS) {
    const src = join(userCodexHome, f);
    const dst = join(codexHome, f);
    if (existsSync(src) && !existsSync(dst)) {
      try { symlinkSync(src, dst); }
      catch (err) { log("error", `symlink ${dst} -> ${src} failed: ${err}`); }
    }
  }
  // hooks.json: install the bot's bash-confirm hook merged with the user's
  // existing hook chain, written as a real file (no symlink).
  const userHooksJson = join(userCodexHome, "hooks.json");
  const dstHooksJson = join(codexHome, "hooks.json");
  if (existsSync(dstHooksJson)) {
    // If a previous version symlinked it, swap the symlink for a real file.
    try {
      const stat = lstatSync(dstHooksJson);
      if (stat.isSymbolicLink()) unlinkSync(dstHooksJson);
    } catch { /* ignore */ }
  }
  // Seed from user's hooks.json if our merged file doesn't exist yet.
  if (!existsSync(dstHooksJson) && existsSync(userHooksJson)) {
    try {
      const userJson = readFileSync(userHooksJson, "utf8");
      writeFileSync(dstHooksJson, userJson);
    } catch (err) { log("error", `seed codex hooks.json failed: ${err}`); }
  }
  if (confirmGateEnabled) {
    try { installBashConfirmHook(dstHooksJson, `bun ${HOOK_SCRIPT}`); }
    catch (err) { log("error", `install codex confirm hook failed: ${err}`); }
  }
}

function confirmGateEnv(chatId: number, agent: string): Record<string, string> {
  if (!confirmGateEnabled) return {};
  return {
    BOT_CONFIRM_SOCKET: SOCKET_PATH,
    TG_CHAT_ID: String(chatId),
    BOT_AGENT: agent,
    BOT_DANGER_PATTERNS_FILE: EXTRA_PATTERNS_FILE,
  };
}

// ---------- codex adapter ----------
async function runCodex(
  prompt: string,
  chatId: number,
  session: AgentSession | undefined,
  abort: AbortSignal,
  onProgress: (text: string) => void,
): Promise<AgentResult> {
  const c = config.agents.codex;
  const codexHome = agentSessionDir("codex", chatId);
  ensureCodexSharedFiles(codexHome);
  const outFile = join(codexHome, "last_message.txt");
  const isResume = !!(session && session.turnCount > 0);

  const args: string[] = ["exec"];
  if (isResume) {
    args.push("resume", "--last");
    if (c.model) args.push("-m", c.model);
    args.push("--skip-git-repo-check");
    args.push("-o", outFile);
    args.push(prompt);
  } else {
    args.push("-s", c.sandbox);
    if (c.model) args.push("-m", c.model);
    args.push("--skip-git-repo-check");
    args.push("--color", "never");
    args.push("-o", outFile);
    args.push("-C", config.cwd);
    args.push(prompt);
  }

  log("debug", `codex args: ${args.slice(0, 8).join(" ")} (CODEX_HOME=${codexHome})`);

  const onLine = (line: string): void => {
    const indicator = detectProgressLine(line);
    if (indicator) {
      audit.write({ chatId, type: "tool_use", agent: "codex", data: { brief: indicator } });
      onProgress(`🔧 ${indicator}`);
    }
  };

  const timeoutMs = agentTimeoutMs("codex");
  const idleTimeoutMs = agentIdleTimeoutMs("codex");
  const { exitCode, stdout, stderr, killedReason } = await runSubprocessStream(c.path, args, {
    cwd: config.cwd,
    env: { CODEX_HOME: codexHome, ...confirmGateEnv(chatId, "codex") },
    timeoutMs,
    idleTimeoutMs,
    signal: abort,
    onStdoutLine: onLine,
  });

  if (killedReason === "abort") return { sessionId: null, text: "", error: "사용자가 중지함" };
  if (killedReason === "timeout") return { sessionId: null, text: "", error: `타임아웃 (${timeoutMs}ms 초과)` };
  if (killedReason === "idle") return { sessionId: null, text: "", error: `무활동 타임아웃 (${idleTimeoutMs}ms)` };

  let text = "";
  try { text = readFileSync(outFile, "utf8").trim(); } catch { /* not written */ }
  if (!text) text = stripAnsi(stdout).trim();

  if (exitCode !== 0) {
    return { sessionId: null, text: "", error: (stripAnsi(stderr).trim() || text).slice(0, 4000) };
  }
  return { sessionId: null, text, error: null };
}

// ---------- pi adapter ----------
async function runPi(
  prompt: string,
  chatId: number,
  session: AgentSession | undefined,
  abort: AbortSignal,
  onProgress: (text: string) => void,
): Promise<AgentResult> {
  const c = config.agents.pi;
  const sessionDir = agentSessionDir("pi", chatId);
  const args = [
    "-p",
    "--mode", "text",
    "--session-dir", sessionDir,
  ];
  if (c.provider) args.push("--provider", c.provider);
  if (c.model) args.push("--model", c.model);
  if (session && session.turnCount > 0) args.push("--continue");
  args.push(prompt);

  log("debug", `pi args: ${args.slice(0, 6).join(" ")} (session-dir=${sessionDir})`);

  const onLine = (line: string): void => {
    const indicator = detectProgressLine(line);
    if (indicator) {
      audit.write({ chatId, type: "tool_use", agent: "pi", data: { brief: indicator } });
      onProgress(`🔧 ${indicator}`);
    }
  };

  const timeoutMs = agentTimeoutMs("pi");
  const idleTimeoutMs = agentIdleTimeoutMs("pi");
  const { exitCode, stdout, stderr, killedReason } = await runSubprocessStream(c.path, args, {
    cwd: config.cwd,
    timeoutMs,
    idleTimeoutMs,
    signal: abort,
    onStdoutLine: onLine,
  });

  if (killedReason === "abort") return { sessionId: null, text: "", error: "사용자가 중지함" };
  if (killedReason === "timeout") return { sessionId: null, text: "", error: `타임아웃 (${timeoutMs}ms 초과)` };
  if (killedReason === "idle") return { sessionId: null, text: "", error: `무활동 타임아웃 (${idleTimeoutMs}ms)` };

  const text = stripAnsi(stdout).trim();
  if (exitCode !== 0) {
    return { sessionId: null, text: "", error: (stripAnsi(stderr).trim() || text).slice(0, 4000) };
  }
  return { sessionId: null, text, error: null };
}

// ---------- gemini adapter ----------
async function runGemini(
  prompt: string,
  chatId: number,
  session: AgentSession | undefined,
  abort: AbortSignal,
  onProgress: (text: string) => void,
): Promise<AgentResult> {
  const c = config.agents.gemini;
  // Per-chat cwd so each chat has its own `~/.gemini/<project>/sessions/`
  // entry — Gemini stores session state keyed by working directory, so
  // running every chat from `config.cwd` would have them all stomp the
  // same "latest" session.
  const sessionDir = agentSessionDir("gemini", chatId);
  // Approval mode default = auto_edit (edit tools auto-approved, shell &
  // destructive ones prompt). Gemini doesn't yet integrate with cliclaw's
  // bash-confirm IPC, so this upstream default is the only line of defense
  // for shell-level actions until that integration lands. Users who want
  // full autonomy can opt into "yolo" via config.agents.gemini.approvalMode.
  const approval = c.approvalMode ?? "auto_edit";
  const args = [
    "-p", prompt,
    "--approval-mode", approval,
    "-o", "text",
  ];
  if (c.model) args.push("-m", c.model);
  if (session && session.turnCount > 0) args.push("-r", "latest");

  log("debug", `gemini args: --approval-mode ${approval} ${session && session.turnCount > 0 ? "-r latest" : "(new)"} model=${c.model ?? "default"}`);

  const onLine = (line: string): void => {
    const indicator = detectProgressLine(line);
    if (indicator) {
      audit.write({ chatId, type: "tool_use", agent: "gemini", data: { brief: indicator } });
      onProgress(`🔧 ${indicator}`);
    }
  };

  const timeoutMs = agentTimeoutMs("gemini");
  const idleTimeoutMs = agentIdleTimeoutMs("gemini");
  const { exitCode, stdout, stderr, killedReason } = await runSubprocessStream(c.path, args, {
    cwd: sessionDir,
    timeoutMs,
    idleTimeoutMs,
    signal: abort,
    onStdoutLine: onLine,
  });

  if (killedReason === "abort") return { sessionId: null, text: "", error: "사용자가 중지함" };
  if (killedReason === "timeout") return { sessionId: null, text: "", error: `타임아웃 (${timeoutMs}ms 초과)` };
  if (killedReason === "idle") return { sessionId: null, text: "", error: `무활동 타임아웃 (${idleTimeoutMs}ms)` };

  const text = stripAnsi(stdout).trim();
  if (exitCode !== 0) {
    return { sessionId: null, text: "", error: (stripAnsi(stderr).trim() || text).slice(0, 4000) };
  }
  return { sessionId: null, text, error: null };
}

// ---------- dispatcher ----------
async function runAgent(
  agent: Agent,
  prompt: string,
  chatId: number,
  session: AgentSession | undefined,
  abort: AbortSignal,
  onProgress: (text: string) => void,
  stream: StreamingMessage | null,
): Promise<AgentResult> {
  if (agent === "claude") return runClaude(prompt, session, chatId, abort, onProgress, stream);
  if (agent === "codex")  return runCodex(prompt, chatId, session, abort, onProgress);
  if (agent === "pi")     return runPi(prompt, chatId, session, abort, onProgress);
  if (agent === "gemini") return runGemini(prompt, chatId, session, abort, onProgress);
  throw new Error(`unknown agent: ${agent}`);
}

// ---------- workspace settings (Claude project hook) ----------
function ensureWorkspaceClaudeSettings(): void {
  if (!confirmGateEnabled) return;
  const settingsPath = join(config.cwd, ".claude", "settings.json");
  try { installBashConfirmHook(settingsPath, `bun ${HOOK_SCRIPT}`); }
  catch (err) { log("error", `install claude workspace hook failed: ${err}`); }
  applySafetyDenyRules();
}

/**
 * Apply (or remove) Claude's permissions.deny rules for sensitive paths.
 * Mirrors the live `safetyEnabled` flag, so toggling /safety on|off in
 * Telegram updates the workspace settings.json without a bot restart.
 * Confirm gate must be enabled at boot — when it isn't the hook isn't
 * installed and these deny rules wouldn't be enforced by anyone either.
 */
function applySafetyDenyRules(): void {
  if (!confirmGateEnabled) return;
  const settingsPath = join(config.cwd, ".claude", "settings.json");
  try {
    if (safetyEnabled) installSafetyDeny(settingsPath);
    else uninstallSafetyDeny(settingsPath);
  } catch (err) {
    log("error", `apply safety deny rules failed: ${err}`);
  }
}

// ---------- message handler ----------
const store = loadStore();

function parseAgentSwitch(text: string): Agent | null {
  const t = text.toLowerCase().trim();
  // Map a /command to its agent name, but only honor it if that agent is
  // actually installed on this machine. /claude on a host that doesn't have
  // Claude Code installed should fall through to the unknown-command path
  // rather than break the runAgent dispatcher.
  const direct = t.startsWith("/") ? (t.slice(1) as Agent) : null;
  if (direct && (ALL_AGENTS as readonly string[]).includes(direct)) {
    return AGENT_NAMES.includes(direct) ? direct : null;
  }
  if (t.startsWith("/use ")) {
    const name = t.slice(5).trim() as Agent;
    if (AGENT_NAMES.includes(name)) return name;
  }
  return null;
}

function safetyLabel(): string {
  if (!confirmGateEnabled) return "비활성 (config)";
  return safetyEnabled ? "ON" : "OFF";
}

async function handleSafetyCommand(chatId: number, arg: string): Promise<void> {
  // When the hook was disabled at boot via config, the toggle is inert —
  // the wired pre-tool hook simply isn't there to ask in the first place.
  if (!confirmGateEnabled) {
    await sendMessage(
      chatId,
      "안전모드는 이 설치본에서 비활성화되어 있습니다 (config.confirmGate.enabled=false).\n" +
        "다시 활성화하려면 config.json을 수정하고 봇을 재시작하세요.",
    );
    return;
  }
  if (arg === "" || arg === "status") {
    const state = safetyEnabled ? "ON" : "OFF";
    const detail = safetyEnabled
      ? "위험 Bash 명령은 텔레그램 confirm 으로 다시 묻고, Claude 의 Read 도구가 ~/.ssh · ~/.aws · .env · *.pem · id_rsa 등 민감 파일을 차단합니다."
      : "모든 Bash 명령이 즉시 실행되고, 민감 파일 deny 룰도 비활성화됩니다. 본인 환경의 외부 가드(pre-bash-guard, EDR 등)에 위임된 상태입니다.";
    await sendMessage(chatId, `🛡 안전모드: ${state}\n${detail}\n\n사용: /safety on · /safety off`);
    return;
  }
  if (arg === "on") {
    if (safetyEnabled) { await sendMessage(chatId, "🛡 안전모드는 이미 ON 입니다."); return; }
    safetyEnabled = true;
    saveSafety(true);
    applySafetyDenyRules();
    log("info", `safety: ON (chat=${chatId})`);
    await sendMessage(
      chatId,
      "🛡 안전모드 ON.\n" +
        "• 위험 Bash 명령은 텔레그램 confirm 으로 다시 묻습니다.\n" +
        "• Claude 의 Read 도구가 ~/.ssh, ~/.aws, .env, *.pem, id_rsa 등 민감 파일을 차단합니다.",
    );
    return;
  }
  if (arg === "off") {
    if (!safetyEnabled) { await sendMessage(chatId, "🛡 안전모드는 이미 OFF 입니다."); return; }
    safetyEnabled = false;
    saveSafety(false);
    applySafetyDenyRules();
    log("info", `safety: OFF (chat=${chatId})`);
    await sendMessage(
      chatId,
      "🛡 안전모드 OFF. Bash 게이트 + 민감 파일 deny 룰이 비활성화됩니다.\n" +
        "본인 환경의 외부 가드(pre-bash-guard, EDR 등)가 위험 명령을 차단하는지 확인하세요.",
    );
    return;
  }
  await sendMessage(chatId, "사용: /safety · /safety on · /safety off");
}

function helpText(active: Agent): string {
  const labels: Record<Agent, string> = {
    claude: "  /claude  — Anthropic Claude Code",
    codex:  "  /codex   — OpenAI Codex",
    pi:     "  /pi      — Pi Coding Agent",
    gemini: "  /gemini  — Google Gemini CLI",
  };
  const switchLines = AGENT_NAMES.map((a) => labels[a]);
  return [
    "🤖 로컬 멀티에이전트 봇",
    "",
    `현재 에이전트: ${active}`,
    "",
    "에이전트 전환:",
    ...switchLines,
    "",
    "세션 명령:",
    "  /reset      — 현재 에이전트 세션 초기화",
    "  /reset all  — 이 채팅의 모든 에이전트 세션 초기화",
    "  /status     — 에이전트별 세션 상태 + 진행 중 작업 표시",
    "  /stop       — 진행 중 작업 취소",
    "  /safety     — 안전모드 상태 (/safety on · off로 토글)",
    "  /help       — 이 도움말",
    "",
    `작업 디렉토리: ${config.cwd}`,
    `안전모드: ${safetyLabel()}`,
    `스트리밍: ${streamingEnabled ? "ON (claude)" : "OFF"}`,
  ].join("\n");
}

function fmtMs(ms: number | undefined): string {
  if (!ms) return "—";
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

function statusText(chat: ChatState, chatId: number): string {
  const lines = [`현재: ${chat.active}`, ""];
  for (const a of AGENT_NAMES) {
    const s = chat.agents[a];
    const mode = agentModeLabel(a);
    const tmo = `타임아웃=${fmtMs(agentTimeoutMs(a))} / 무활동=${fmtMs(agentIdleTimeoutMs(a))}`;
    if (!s) {
      lines.push(`${a}: (세션 없음)  모드: ${mode}  ${tmo}`);
    } else {
      const sid = s.sessionId ? s.sessionId.slice(0, 8) : "—";
      lines.push(`${a}: 턴=${s.turnCount} 세션=${sid} 마지막=${s.lastUsedAt}`);
      lines.push(`  모드: ${mode}  ${tmo}`);
    }
  }
  const inFlight = jobs.get(chatId);
  if (inFlight) {
    const elapsed = Math.round((Date.now() - inFlight.startedAt.getTime()) / 1000);
    lines.push("", `🏃 진행 중: ${inFlight.agent} (${elapsed}초) — /stop 으로 취소`);
  }
  if (confirmServer) {
    lines.push("", `위험명령 확인 게이트: ON, 대기중=${confirmServer.pendingCount()}`);
  }
  return lines.join("\n");
}

/**
 * Download every image attachment on the incoming message and return their
 * local paths. Telegram delivers photos as a size ladder; we grab the largest.
 * Documents whose MIME starts with image/ are also captured. Returns [] when
 * the message carries no media or every download fails (logged but non-fatal).
 */
async function downloadMessageImages(msg: TgMessage): Promise<{ paths: string[]; errors: string[] }> {
  const paths: string[] = [];
  const errors: string[] = [];

  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo.reduce((a, b) => (a.file_size ?? 0) >= (b.file_size ?? 0) ? a : b);
    try {
      const outputPath = makeMediaPath(UPLOADS_ROOT, msg.chat.id, msg.message_id, "jpg");
      const { size } = await downloadTelegramFile({ token: config.token, fileId: largest.file_id, outputPath });
      paths.push(outputPath);
      audit.write({
        chatId: msg.chat.id, type: "msg_in", data: { kind: "photo", path: outputPath, bytes: size },
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      log("error", `photo download failed: ${m}`);
      errors.push(`photo: ${m}`);
    }
  }

  if (msg.document && (msg.document.mime_type ?? "").startsWith("image/")) {
    const doc = msg.document;
    try {
      const ext = inferExtension(doc.file_name, doc.mime_type);
      const outputPath = makeMediaPath(UPLOADS_ROOT, msg.chat.id, msg.message_id, ext);
      const { size } = await downloadTelegramFile({ token: config.token, fileId: doc.file_id, outputPath });
      paths.push(outputPath);
      audit.write({
        chatId: msg.chat.id, type: "msg_in",
        data: { kind: "image_document", mime: doc.mime_type, path: outputPath, bytes: size },
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      log("error", `image document download failed: ${m}`);
      errors.push(`document: ${m}`);
    }
  }

  return { paths, errors };
}

async function handleMessage(msg: TgMessage): Promise<void> {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  // Telegram uses `text` for plain messages and `caption` for media messages.
  let text = (msg.text ?? msg.caption ?? "").trim();
  if (!userId) return;

  if (config.allowedUserIds.length === 0) {
    log("info", `UNAUTH msg from user_id=${userId} (@${msg.from?.username}) chat_id=${chatId}: "${text.slice(0, 80)}"`);
    log("info", `→ add ${userId} to config.allowedUserIds to allow this user`);
    await sendMessage(chatId, `권한이 없습니다. 본인 user_id=${userId}\n관리자에게 화이트리스트 등록을 요청하세요.`);
    return;
  }
  if (!config.allowedUserIds.includes(userId)) {
    log("info", `denied user_id=${userId}`);
    audit.write({ chatId, userId, type: "error", data: { kind: "unauthorized" } });
    await sendMessage(chatId, "권한이 없습니다.");
    return;
  }

  audit.write({ chatId, userId, type: "msg_in", data: { text: text.slice(0, 500) } });

  // Media: download any attached images upfront so the prompt can reference them.
  const hasMedia = !!(msg.photo?.length || (msg.document && (msg.document.mime_type ?? "").startsWith("image/")));
  let mediaPaths: string[] = [];
  if (hasMedia) {
    await sendTyping(chatId);
    const r = await downloadMessageImages(msg);
    mediaPaths = r.paths;
    for (const err of r.errors) {
      await sendMessage(chatId, `⚠️ 첨부 다운로드 실패: ${err}`);
    }
    if (mediaPaths.length === 0) return; // every attachment failed; bail out
  }

  const chat = getChat(store, chatId);

  if (text === "/start" || text === "/help") {
    audit.write({ chatId, userId, type: "cmd", data: { cmd: text } });
    await sendMessage(chatId, helpText(chat.active));
    return;
  }

  const switchTo = parseAgentSwitch(text);
  if (switchTo) {
    audit.write({ chatId, userId, type: "cmd", data: { cmd: "switch", to: switchTo } });
    chat.active = switchTo;
    saveStore(store);
    const s = chat.agents[switchTo];
    const tail = s ? ` (이어가기, ${s.turnCount}턴)` : " (새 세션)";
    await sendMessage(chatId, `✅ ${switchTo}로 전환됨${tail}`);
    return;
  }

  if (text === "/safety" || text.startsWith("/safety ")) {
    audit.write({ chatId, userId, type: "cmd", data: { cmd: "safety", arg: text.slice(7).trim() } });
    await handleSafetyCommand(chatId, text.slice(7).trim().toLowerCase());
    return;
  }

  if (text === "/status") {
    audit.write({ chatId, userId, type: "cmd", data: { cmd: "status" } });
    await sendMessage(chatId, statusText(chat, chatId));
    return;
  }

  if (text === "/stop") {
    const cancelled = jobs.cancel(chatId);
    audit.write({ chatId, userId, type: "stop", data: { hadJob: !!cancelled, agent: cancelled?.agent } });
    if (cancelled) {
      const elapsed = Math.round((Date.now() - cancelled.startedAt.getTime()) / 1000);
      await sendMessage(chatId, `🛑 [${cancelled.agent}] ${elapsed}초 경과 — 중지 중…`);
    } else {
      await sendMessage(chatId, "ℹ️ 진행 중인 작업이 없습니다.");
    }
    return;
  }

  if (text === "/reset" || text === "/reset all") {
    audit.write({ chatId, userId, type: "cmd", data: { cmd: text } });
    if (text === "/reset all") {
      chat.agents = {};
      saveStore(store);
      await sendMessage(chatId, "🧹 이 채팅의 모든 에이전트 세션을 초기화했습니다.");
    } else {
      delete chat.agents[chat.active];
      saveStore(store);
      await sendMessage(chatId, `🧹 ${chat.active} 세션을 초기화했습니다.`);
    }
    return;
  }

  if (mediaPaths.length > 0) {
    // An image-bearing message is always a prompt — never a command — and
    // we prepend the file paths so Claude can pick them up via Read.
    if (!text) text = "첨부 이미지를 분석해줘.";
    const refs = mediaPaths.map((p) => `- ${p}`).join("\n");
    text = `${text}\n\n[첨부 이미지 — Read 도구로 열어 분석할 것]\n${refs}`;
  }

  if (!text || text.startsWith("/")) {
    if (text.startsWith("/")) await sendMessage(chatId, `알 수 없는 명령: ${text}\n\n${helpText(chat.active)}`);
    return;
  }

  const existing = jobs.get(chatId);
  if (existing) {
    const elapsed = Math.round((Date.now() - existing.startedAt.getTime()) / 1000);
    audit.write({ chatId, userId, type: "lock_reject", data: { agent: existing.agent, elapsedSec: elapsed } });
    await sendMessage(
      chatId,
      `⏳ [${existing.agent}] 작업 진행 중 (${elapsed}초). /stop 으로 취소하거나 종료를 기다리세요.`,
    );
    return;
  }

  const agent = chat.active;
  let sessionBefore = chat.agents[agent];

  const maxTurns = config.agents[agent].maxTurns;
  if (sessionBefore && typeof maxTurns === "number" && sessionBefore.turnCount >= maxTurns) {
    log("info", `auto-reset [${agent}] chat=${chatId} turnCount=${sessionBefore.turnCount} >= maxTurns=${maxTurns}`);
    delete chat.agents[agent];
    saveStore(store);
    sessionBefore = undefined;
    await sendMessage(chatId, `🧹 [${agent}] ${maxTurns}턴 도달 — 세션 자동 초기화. 이전 컨텍스트는 사라집니다.`);
  }

  let job: Job;
  try {
    job = jobs.register(chatId, agent);
  } catch {
    await sendMessage(chatId, `⏳ [${agent}] 작업 진행 중. /stop 으로 취소하세요.`);
    return;
  }
  audit.write({ chatId, userId, type: "agent_start", agent });

  const typingHandle = setInterval(() => sendTyping(chatId), 4000);
  await sendTyping(chatId);
  const toolIndicator = makeToolIndicator(chatId);
  const onProgress = (text: string): void => toolIndicator.update(text);
  const stream: StreamingMessage | null = (streamingEnabled && agent === "claude")
    ? createStreamingMessage({
        chatId,
        send: async (cid, t) => {
          const html = markdownToTelegramHtml(t);
          try {
            const m = await tg<TgMessage>("sendMessage", { chat_id: cid, text: html, parse_mode: "HTML" });
            return { message_id: m.message_id };
          } catch {
            const m = await tg<TgMessage>("sendMessage", { chat_id: cid, text: t });
            return { message_id: m.message_id };
          }
        },
        edit: async (cid, id, t) => {
          const html = markdownToTelegramHtml(t);
          try { await tg("editMessageText", { chat_id: cid, message_id: id, text: html, parse_mode: "HTML" }); }
          catch { await tg("editMessageText", { chat_id: cid, message_id: id, text: t }); }
        },
        minIntervalMs: streamMinIntervalMs,
        onError: (err) => log("error", `stream: ${err instanceof Error ? err.message : err}`),
      })
    : null;

  try {
    let result = await runAgent(agent, text, chatId, sessionBefore, job.abort.signal, onProgress, stream);

    // --continue can fail if the cwd has no prior session OR if Claude can't
    // locate one. In that case, retry once as a fresh conversation.
    if (
      agent === "claude" &&
      result.error &&
      result.error !== "사용자가 중지함" &&
      sessionBefore && sessionBefore.turnCount > 0 &&
      /no conversation|session|continue|resume/i.test(result.error)
    ) {
      log("info", `claude --continue failed for chat=${chatId}, retrying fresh`);
      delete chat.agents.claude;
      result = await runClaude(text, undefined, chatId, job.abort.signal, onProgress, stream);
    }

    if (!result.error) {
      const next = getOrInitAgentSession(chat, agent);
      next.turnCount += 1;
      next.lastUsedAt = new Date().toISOString();
      if (result.sessionId) next.sessionId = result.sessionId;
      saveStore(store);
    }

    audit.write({
      chatId, userId, type: "agent_exit", agent,
      data: { ok: !result.error, error: result.error?.slice(0, 200), textLen: result.text.length, streamed: stream?.hasContent() ?? false },
    });

    if (stream && stream.hasContent()) {
      // The streamer already rendered the answer; just flush the final state.
      await stream.close();
      if (result.error) await sendMessage(chatId, `⚠️ [${agent}] ${result.error}`);
    } else if (result.error) {
      await sendMessage(chatId, `⚠️ [${agent}] ${result.error}`);
    } else {
      await sendMessage(chatId, `[${agent}] ${result.text || "(빈 응답)"}`);
    }
    // Move the rolling tool bubble below the answer (or remove it if nothing was used).
    await toolIndicator.finalize();
  } catch (err) {
    log("error", `handler failed: ${err instanceof Error ? err.stack : err}`);
    audit.write({ chatId, userId, type: "error", agent, data: { err: err instanceof Error ? err.message : String(err) } });
    await sendMessage(chatId, `⚠️ 내부 오류: ${err instanceof Error ? err.message : String(err)}`);
    // Best effort: clean up any rolling bubble so it doesn't linger over the error.
    try { await toolIndicator.clear(); } catch { /* swallow */ }
  } finally {
    clearInterval(typingHandle);
    jobs.clear(chatId);
  }
}

// ---------- polling loop ----------
let running = true;
const shutdown = (signal: string): void => {
  log("info", signal);
  running = false;
  // Best-effort: stop confirm server so the socket file is cleaned up.
  void confirmServer?.stop().catch(() => {});
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function pollLoop(): Promise<void> {
  let offset = 0;
  try {
    const me = await tg<TgUser & { username: string }>("getMe");
    log("info", `bot started: @${me.username} (id=${me.id})`);
  } catch (err) {
    log("error", `getMe failed — check token: ${err}`);
    process.exit(1);
  }
  log("info", `agents=[${AGENT_NAMES.join(",")}] default=${config.defaultAgent} allowed=[${config.allowedUserIds.join(",")}] cwd=${config.cwd}`);
  log("info", `confirm gate: ${confirmGateEnabled ? `wired (socket=${SOCKET_PATH})` : "OFF (disabled in config)"}`);
  log("info", `safety: ${safetyLabel()}`);

  while (running) {
    try {
      const updates = await tg<TgUpdate[]>("getUpdates", {
        offset,
        timeout: config.pollTimeoutSec,
        allowed_updates: ["message", "callback_query"],
      });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.callback_query) {
          handleCallbackQuery(u.callback_query).catch((err) => log("error", `callback: ${err}`));
          continue;
        }
        const m = u.message ?? u.edited_message;
        if (m) handleMessage(m).catch((err) => log("error", `unhandled: ${err}`));
      }
    } catch (err) {
      if (!running) break;
      log("error", `poll error: ${err instanceof Error ? err.message : err}`);
      await Bun.sleep(5000);
    }
  }
  log("info", "poll loop stopped");
}

// ---------- startup ----------
ensureWorkspaceClaudeSettings();
if (confirmServer) await confirmServer.start();

await pollLoop();
