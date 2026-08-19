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

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, symlinkSync, unlinkSync, lstatSync, readdirSync, statSync } from "fs";
import { join, dirname, resolve as resolvePath } from "path";
import { homedir } from "os";
import { execFileSync } from "node:child_process";

import { JobRegistry, type Job } from "./lib/job-registry.ts";
import { acquireInstanceLock, releaseInstanceLock } from "./lib/instance-lock.ts";
import {
  isNonPrivateChat, ConfigFatalError, isConfigFatalError,
  parseModelCommand, parsePlanCommand, isPassthrough, passthroughPrompt,
} from "./lib/chat-policy.ts";
import { createAuditWriter, type AuditWriter } from "./lib/audit-log.ts";
import { runSubprocessStream } from "./lib/subprocess-stream.ts";
import { parseClaudeStreamLine, parseGeminiStreamLine, detectProgressLine, stripAnsi } from "./lib/stream-parser.ts";
import { ConfirmServer, type ConfirmRequest } from "./lib/confirm-server.ts";
import {
  installBashConfirmHook,
  installSafetyDeny,
  uninstallSafetyDeny,
} from "./lib/hook-installer.ts";
import { createStreamingMessage, type StreamingMessage } from "./lib/telegram-stream.ts";
import { createToolIndicator, type ToolIndicator } from "./lib/tool-indicator.ts";
import { markdownToTelegramHtml, autoCloseUnfinished } from "./lib/telegram-html.ts";
import { downloadTelegramFile, inferExtension, makeMediaPath } from "./lib/media-download.ts";
import { resolveCliPath } from "./lib/resolve-cli-path.ts";
import { rotateIfLarge, truncateIfLarge } from "./lib/log-rotate.ts";
import { createRateLimiter } from "./lib/rate-limiter.ts";
import { DEFAULT_DANGER_PATTERNS, type DangerPattern } from "./lib/danger-patterns.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sweepStaleSessionDirs } from "./lib/session-sweep.ts";
import { getMessages } from "./lib/messages.ts";

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
  /** bot.log rotation threshold in MB. Default 10. */
  logRotateMb?: number;
  /** Number of rotated bot.log generations to keep on disk. Default 3. */
  logRotateKeep?: number;
  /** audit.jsonl rotation threshold in MB. Default 20. */
  auditRotateMb?: number;
  /** Rotated audit.jsonl generations to keep. Default 3. */
  auditRotateKeep?: number;
  /** Truncate bot.err on startup if larger than this in MB. Default 1. */
  stderrTruncateMb?: number;
  /** Days of inactivity before workspace/uploads/<chatId>/<file> is removed. Default 7. */
  uploadsRetentionDays?: number;
  /** Days of inactivity before sessions/<agent>/<chatId> is removed. Default 30. `<= 0` disables. */
  sessionRetentionDays?: number;
  /** Per-chat rate limit. Default 30 messages per 60 seconds. */
  rateLimit?: { maxPerWindow?: number; windowMs?: number };
  /** Telegram chat UX locale. "en" | "ko"; undefined (existing installs) → ko. */
  locale?: string;
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
  /** Per-chat, per-agent model override (D1). Absent -> config default. */
  modelOverride?: Partial<Record<Agent, string>>;
  /** Claude-only plan-mode toggle (D2): spawns with --permission-mode plan
   *  instead of bypassPermissions. Stored even while a non-claude agent is
   *  active, so it takes effect on switching back. */
  planMode?: boolean;
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

// ---------- process hardening ----------
// Strip env vars an attacker could use to hijack libraries loaded by
// child processes (LD_PRELOAD on Linux, DYLD_* on macOS, malloc-stack
// logging that can be coerced into arbitrary file writes). Mirrors the
// Codex CLI `codex-process-hardening` crate. Runs BEFORE config load so
// every subsequent log line / spawn / fetch sees the cleaned env.
const HIJACK_ENV = [
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FALLBACK_FRAMEWORK_PATH",
  "MallocStackLogging", "MallocStackLoggingNoCompact",
  "MallocLogFile",
] as const;
const _strippedEnv: string[] = [];
for (const k of HIJACK_ENV) {
  if (process.env[k] !== undefined) {
    _strippedEnv.push(k);
    delete process.env[k];
  }
}

// ---------- config ----------
// Load, parse, and validate config.json. Throws ConfigFatalError on any
// config-class fatal condition (missing/unparsable file, missing token,
// zero usable agent CLIs) — the boot loop below retries those instead of
// crash-looping under launchd. Any other thrown error is a genuine,
// unexpected bug and propagates so launchd restarts the process (throttled
// to 60s).
function loadAndValidateConfig(): Config {
  // Reset to the full candidate list on every attempt — a previous failed
  // attempt may have narrowed AGENT_NAMES down (e.g. to []) before hitting
  // a later fatal check, and a retry must re-scan everything fresh.
  AGENT_NAMES = [...ALL_AGENTS];

  let config: Config;
  try {
    config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigFatalError(`config.json: could not read/parse (${detail})`);
  }
  if (!config.token || config.token.startsWith("PASTE_")) {
    throw new ConfigFatalError("config.json: token not set");
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
    throw new ConfigFatalError(
      "No coding agent CLIs are available on this machine. " +
        "Install at least one of: claude (Claude Code), codex, pi.",
    );
  }
  if (!AGENT_NAMES.includes(config.defaultAgent)) {
    console.error(
      `config.json: defaultAgent='${config.defaultAgent}' is not installed; ` +
        `falling back to '${AGENT_NAMES[0]}'. ` +
        `Available: ${AGENT_NAMES.join(", ")}.`,
    );
    config.defaultAgent = AGENT_NAMES[0];
  }
  return config;
}

let config: Config;
for (;;) {
  try {
    config = loadAndValidateConfig();
    break;
  } catch (err) {
    if (!isConfigFatalError(err)) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${reason} — retrying config load every 60s`);
    await Bun.sleep(60_000);
  }
}
// Resolve a relative cwd against the user's CLICLAW_HOME so launchctl /
// cron / arbitrary working directories all yield the same workspace path.
config.cwd = resolvePath(HOME, config.cwd);
mkdirSync(config.cwd, { recursive: true });

// ---------- i18n ----------
// Resolved once at boot from config.locale — undefined (existing installs)
// keeps today's Korean UX; new installs default to English (D2).
const M = getMessages(config.locale);

// ---------- single-instance lock ----------
// Only one bot process may run per CLICLAW_HOME — two pollers racing the
// same Telegram getUpdates offset would double-handle messages and stomp
// each other's session files. Acquired only after config loads successfully
// (D7) so a dormant, still-unconfigured process never holds the lock.
function isLikelyCliclawProcess(pid: number): boolean {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      timeout: 5000,
      encoding: "utf8",
    });
    return out.includes("cliclaw") || out.includes("bot.ts");
  } catch {
    return false;
  }
}
{
  const lockResult = acquireInstanceLock(HOME, isLikelyCliclawProcess);
  if (!lockResult.acquired) {
    console.error(
      `FATAL: another cliclaw instance (pid ${lockResult.holderPid}) holds ${HOME}/bot.pid — stop it or delete the file if stale`,
    );
    process.exit(0);
  }
}

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
  try { writeFileAtomic(SAFETY_FILE, JSON.stringify({ enabled }, null, 2)); }
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
  return M.agentModeLabel(agent, {
    confirmGateEnabled,
    safetyEnabled,
    codexSandbox: config.agents.codex.sandbox,
    geminiApprovalMode: config.agents.gemini.approvalMode ?? "auto_edit",
  });
}

// Persist user-supplied extra patterns to a file the hook can read.
writeFileAtomic(EXTRA_PATTERNS_FILE, JSON.stringify(extraDangerPatterns));

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

// Rotate when bot.log crosses LOG_ROTATE_BYTES; keep LOG_ROTATE_KEEP
// generations on disk (bot.log.1 ... bot.log.N). Defaults sized for
// a year of routine traffic at typical chat volumes — a stuck crash
// loop is still bounded.
const LOG_ROTATE_BYTES = (config.logRotateMb ?? 10) * 1024 * 1024;
const LOG_ROTATE_KEEP  = config.logRotateKeep ?? 3;
const AUDIT_ROTATE_BYTES = (config.auditRotateMb ?? 20) * 1024 * 1024;
const AUDIT_ROTATE_KEEP  = config.auditRotateKeep ?? 3;
const STDERR_TRUNCATE_BYTES = (config.stderrTruncateMb ?? 1) * 1024 * 1024;

function log(level: "debug" | "info" | "error", msg: string): void {
  const order = { debug: 0, info: 1, error: 2 };
  if (order[level] < order[config.logLevel]) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${redact(msg)}\n`;
  process.stdout.write(line);
  // Cheap stat-on-every-call. Avoids needing to reason about per-write
  // counters that get wrong across multi-process scenarios.
  rotateIfLarge(LOG_FILE, { maxBytes: LOG_ROTATE_BYTES, keep: LOG_ROTATE_KEEP });
  try { appendFileSync(LOG_FILE, line); } catch {}
}

const audit: AuditWriter = createAuditWriter(AUDIT_FILE, {
  maxBytes: AUDIT_ROTATE_BYTES,
  keep: AUDIT_ROTATE_KEEP,
}, { redact });

// Per-chat sliding-window rate limit. Defaults are an abuse circuit-
// breaker, not a quota — 30/min is well above a human typing pace but
// catches an auto-forwarder or accidental loop within seconds.
const rateLimiter = createRateLimiter({
  maxPerWindow: config.rateLimit?.maxPerWindow ?? 30,
  windowMs: config.rateLimit?.windowMs ?? 60_000,
});
const jobs = new JobRegistry();

// ---------- session store ----------
type SessionStore = Record<string, ChatState>;

function loadStore(): SessionStore {
  try { return JSON.parse(readFileSync(SESSIONS_FILE, "utf8")); }
  catch { return {}; }
}
function saveStore(s: SessionStore): void {
  writeFileAtomic(SESSIONS_FILE, JSON.stringify(s, null, 2));
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
/** The model actually used to spawn `agent` for this chat: the per-chat
 *  override (D1) if set, else the config default (which is `null` for
 *  codex/pi/gemini when the CLI's own default should apply). */
function effectiveModel(chat: ChatState, agent: Agent): string | null {
  const override = chat.modelOverride?.[agent];
  if (override) return override;
  return config.agents[agent].model ?? null;
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

async function tg<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<T> {
  // Up to 2 attempts so a single 429 (rate limit) can be honored with the
  // server-specified backoff instead of hammering straight back into the limit.
  for (let attempt = 0; attempt < 2; attempt++) {
    // AbortSignal.timeout guarantees the await settles — a dead TCP connection
    // (no RST) would otherwise leave fetch hanging forever and silently wedge
    // the long-poll loop with no error and no recovery.
    const res = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let data: { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
    try {
      data = await res.json() as typeof data;
    } catch {
      // Non-JSON body (e.g. 502 HTML from a proxy) — don't throw an opaque
      // "Unexpected token" from res.json(); surface the status instead.
      throw new Error(`tg ${method}: HTTP ${res.status} (non-JSON response)`);
    }
    if (data.ok) return data.result as T;
    const retryAfter = data.parameters?.retry_after;
    if (res.status === 429 && retryAfter && attempt === 0) {
      await Bun.sleep((retryAfter + 1) * 1000);
      continue;
    }
    throw new Error(`tg ${method}: ${data.description ?? `HTTP ${res.status}`}`);
  }
  throw new Error(`tg ${method}: retries exhausted`);
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
  if (!text) text = M.emptyResponse;
  const html = markdownToTelegramHtml(text);
  await sendChunkedHtml(chatId, html, text);
  audit.write({ chatId, type: "msg_out", data: { len: text.length } });
}

async function sendChunkedHtml(chatId: number, html: string, plainFallback: string): Promise<void> {
  for (let i = 0; i < html.length; i += MAX_LEN) {
    const chunk = html.slice(i, i + MAX_LEN);
    try {
      await tg("sendMessage", { chat_id: chatId, text: chunk, parse_mode: "HTML" });
    } catch (err) {
      // The model can produce HTML the parser doesn't accept (mismatched tags,
      // odd entities). HTML and the plain fallback have DIFFERENT lengths, so
      // the HTML offset `i` cannot index plainFallback — doing so sent the wrong
      // slice (or an empty string → "message text is empty" → silent drop of the
      // rest). Fall back by re-chunking the FULL plain text independently, then
      // stop. (A multi-chunk partial failure may re-send an already-sent prefix
      // as plain — acceptable vs. losing the answer.)
      log("error", `sendMessage HTML failed, falling back to plain: ${err}`);
      audit.write({ chatId, type: "error", data: { op: "sendMessage", err: String(err) } });
      await sendChunkedPlain(chatId, plainFallback);
      return;
    }
  }
}

async function sendChunkedPlain(chatId: number, text: string): Promise<void> {
  for (let j = 0; j < text.length; j += MAX_LEN) {
    try {
      await tg("sendMessage", { chat_id: chatId, text: text.slice(j, j + MAX_LEN) });
    } catch (err) {
      log("error", `sendMessage plain failed: ${err}`);
      return;
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

// ---------- chat policy ----------
// cliclaw only supports 1:1 chats — group/supergroup/channel chats never
// get a working agent session (D1's per-chat isolation assumes exactly one
// human per chat). Tracks which non-private chats already got the "1:1
// only" notice so a chatty group doesn't get it repeated on every message.
const nonPrivateChatsWarned = new Set<number>();

// ---------- confirm gate ----------
interface ConfirmMsgRecord { messageId: number; chatId: number; }
const confirmMessages = new Map<string, ConfirmMsgRecord>();
let confirmServer: ConfirmServer | null = null;

function findDangerPattern(id: string): DangerPattern | undefined {
  return DEFAULT_DANGER_PATTERNS.find((p) => p.id === id);
}

function confirmMessageText(req: ConfirmRequest): string {
  return M.confirmMessageText({
    agent: req.agent,
    patternId: req.patternId,
    reason: req.reason,
    command: req.command,
    justification: findDangerPattern(req.patternId)?.justification,
  });
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
    confirmServer?.respond(req.requestId, "allow", M.confirmReasonSafetyOff);
    audit.write({
      chatId: req.chatId, type: "confirm_decision", agent: req.agent,
      data: { requestId: req.requestId, patternId: req.patternId, decision: "allow", reason: "safety_off" },
    });
    return;
  }

  // Policy-level forbidden patterns (decision: "forbidden") skip the
  // inline-keyboard prompt entirely. The user gets a one-shot rejection
  // notice with the policy's justification — no ambiguity, no waiting.
  const pattern = findDangerPattern(req.patternId);
  if (pattern?.decision === "forbidden") {
    const why = pattern.justification ?? pattern.reason;
    confirmServer?.respond(req.requestId, "deny", M.confirmReasonForbidden(why));
    audit.write({
      chatId: req.chatId, type: "confirm_decision", agent: req.agent,
      data: {
        requestId: req.requestId,
        patternId: req.patternId,
        decision: "deny",
        reason: "forbidden_by_policy",
        justification: why,
      },
    });
    try {
      const cmd = req.command.length > 200 ? req.command.slice(0, 200) + "…" : req.command;
      await sendMessage(req.chatId, M.forbiddenCommandNotice(req.patternId, why, cmd));
    } catch (err) {
      log("error", `forbidden notice failed: ${err}`);
    }
    return;
  }
  try {
    const msg = await tg<TgMessage>("sendMessage", {
      chat_id: req.chatId,
      text: confirmMessageText(req),
      reply_markup: {
        inline_keyboard: [[
          { text: M.confirmAllowButton, callback_data: `confirm:${req.requestId}:allow` },
          { text: M.confirmDenyButton, callback_data: `confirm:${req.requestId}:deny` },
        ]],
      },
    });
    confirmMessages.set(req.requestId, { messageId: msg.message_id, chatId: req.chatId });
  } catch (err) {
    log("error", `confirm prompt failed: ${err}`);
    confirmServer?.respond(req.requestId, "deny", M.confirmReasonPromptFailed);
  }
}

async function handleCallbackQuery(q: TgCallbackQuery): Promise<void> {
  if (q.message && isNonPrivateChat(q.message.chat.type)) return;
  const userId = q.from.id;
  if (!config.allowedUserIds.includes(userId)) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: M.callbackUnauthorized });
    return;
  }
  const data = q.data ?? "";
  const m = data.match(/^confirm:([0-9a-f-]+):(allow|deny)$/);
  if (!m) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: M.callbackInvalid });
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
    text: handled ? (decision === "allow" ? M.callbackAllowed : M.callbackDenied) : M.callbackExpired,
  });
  if (rec && handled) {
    confirmMessages.delete(requestId);
    try {
      await tg("editMessageText", {
        chat_id: rec.chatId,
        message_id: rec.messageId,
        text: M.confirmOutcomeText(decision),
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
  model: string,
  planMode: boolean,
): Promise<AgentResult> {
  const c = config.agents.claude;
  // Per-chat cwd so concurrent chats don't share Claude's --continue session
  // (same rationale as runGemini's sessionDir below — Claude resumes "the
  // most-recent session in cwd", so a shared cwd has every chat stomp the
  // same session). The confirm-gate hook + safety deny rules must follow
  // this move (D2) — Claude reads .claude/settings.json from its own cwd,
  // so re-ensure them here on every call rather than only once at boot
  // against the old shared config.cwd.
  const claudeSessionDir = agentSessionDir("claude", chatId);
  installClaudeSettingsInto(claudeSessionDir);
  // bypassPermissions: headless 모드에서 권한 ask 프롬프트는 자동 거절로
  // 끝나 사용자 응답을 받을 수 없다. Bash 도구는 PreToolUse confirm 훅이
  // 텔레그램으로 다시 묻고, 그 외 도구(WebFetch 등)는 allowedUserIds로
  // 차단된 단일 채널이라는 봇 신뢰 경계에 위임한다.
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
    "--permission-mode", planMode ? "plan" : "bypassPermissions",
  ];
  if (stream && claudePartialMessages) args.push("--include-partial-messages");
  // --continue resumes the most-recent session in cwd. More robust than
  // --resume <id>, which suffers ID drift between the stream's emitted
  // session_id and the on-disk session file name.
  const isContinuation = !!(session && session.turnCount > 0);
  if (isContinuation) args.push("--continue");

  log("debug", `claude args: --model ${model} plan=${planMode} ${isContinuation ? "--continue" : "(new)"} stream=${!!stream}`);

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
    cwd: claudeSessionDir,
    env: confirmGateEnv(chatId, "claude"),
    timeoutMs,
    idleTimeoutMs,
    signal: abort,
    onStdoutLine: onLine,
  });

  if (killedReason === "abort") {
    return { sessionId, text: "", error: M.userStoppedError };
  }
  if (killedReason === "timeout") {
    return { sessionId, text: "", error: M.timeoutError(timeoutMs) };
  }
  if (killedReason === "idle") {
    return { sessionId, text: "", error: M.idleTimeoutError(idleTimeoutMs) };
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
  model: string | null,
): Promise<AgentResult> {
  const c = config.agents.codex;
  const codexHome = agentSessionDir("codex", chatId);
  ensureCodexSharedFiles(codexHome);
  const outFile = join(codexHome, "last_message.txt");
  const isResume = !!(session && session.turnCount > 0);

  const args: string[] = ["exec"];
  if (isResume) {
    args.push("resume", "--last");
    if (model) args.push("-m", model);
    args.push("--skip-git-repo-check");
    args.push("-o", outFile);
    args.push(prompt);
  } else {
    args.push("-s", c.sandbox);
    if (model) args.push("-m", model);
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

  if (killedReason === "abort") return { sessionId: null, text: "", error: M.userStoppedError };
  if (killedReason === "timeout") return { sessionId: null, text: "", error: M.timeoutError(timeoutMs) };
  if (killedReason === "idle") return { sessionId: null, text: "", error: M.idleTimeoutError(idleTimeoutMs) };

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
  model: string | null,
): Promise<AgentResult> {
  const c = config.agents.pi;
  const sessionDir = agentSessionDir("pi", chatId);
  const args = [
    "-p",
    "--mode", "text",
    "--session-dir", sessionDir,
  ];
  if (c.provider) args.push("--provider", c.provider);
  if (model) args.push("--model", model);
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

  if (killedReason === "abort") return { sessionId: null, text: "", error: M.userStoppedError };
  if (killedReason === "timeout") return { sessionId: null, text: "", error: M.timeoutError(timeoutMs) };
  if (killedReason === "idle") return { sessionId: null, text: "", error: M.idleTimeoutError(idleTimeoutMs) };

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
  stream: StreamingMessage | null,
  model: string | null,
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
  // stream-json gives us per-token "delta:true" assistant messages; if the
  // caller wants live streaming we ask for that format, otherwise stick
  // with plain text so the consumer doesn't have to reassemble.
  const useStreamJson = !!stream;
  const args = [
    "-p", prompt,
    "--approval-mode", approval,
    "-o", useStreamJson ? "stream-json" : "text",
  ];
  if (model) args.push("-m", model);
  if (session && session.turnCount > 0) args.push("-r", "latest");

  log("debug", `gemini args: --approval-mode ${approval} ${session && session.turnCount > 0 ? "-r latest" : "(new)"} model=${model ?? "default"} stream=${useStreamJson}`);

  // Buffer the assistant text deltas; we keep them so the final
  // returned text matches what the user already saw streamed.
  let streamedText = "";
  const onLine = (line: string): void => {
    if (useStreamJson) {
      const evt = parseGeminiStreamLine(line);
      if (evt?.kind === "text-delta") {
        streamedText += evt.text;
        stream!.append(evt.text);
        return;
      }
      if (evt?.kind === "result" || evt?.kind === "other") return;
      // Fall through to heuristic on non-JSON lines (rare — banner output).
    }
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

  if (killedReason === "abort") return { sessionId: null, text: "", error: M.userStoppedError };
  if (killedReason === "timeout") return { sessionId: null, text: "", error: M.timeoutError(timeoutMs) };
  if (killedReason === "idle") return { sessionId: null, text: "", error: M.idleTimeoutError(idleTimeoutMs) };

  // When streaming via stream-json, `streamedText` is the canonical
  // answer (it's what the user already saw). Plain stdout contains the
  // raw newline-delimited JSON which we never want to send back.
  const text = useStreamJson ? streamedText.trim() : stripAnsi(stdout).trim();
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
  chat: ChatState,
): Promise<AgentResult> {
  const model = effectiveModel(chat, agent);
  if (agent === "claude") return runClaude(prompt, session, chatId, abort, onProgress, stream, model ?? config.agents.claude.model, !!chat.planMode);
  if (agent === "codex")  return runCodex(prompt, chatId, session, abort, onProgress, model);
  if (agent === "pi")     return runPi(prompt, chatId, session, abort, onProgress, model);
  if (agent === "gemini") return runGemini(prompt, chatId, session, abort, onProgress, stream, model);
  throw new Error(`unknown agent: ${agent}`);
}

// ---------- workspace settings (Claude project hook) ----------
/**
 * Install (or refresh) the bash-confirm hook + safety deny rules into a
 * single Claude working directory's settings.json. Both writes are
 * idempotent (see lib/hook-installer.ts), so calling this repeatedly for
 * the same dir is cheap and safe. Called for config.cwd at boot and for
 * each chat's per-chat claude session dir (D1/D2: moving Claude's cwd
 * without moving these settings would silently disable the confirm gate
 * and deny rules for that chat).
 */
function installClaudeSettingsInto(dir: string): void {
  if (!confirmGateEnabled) return;
  const settingsPath = join(dir, ".claude", "settings.json");
  try { installBashConfirmHook(settingsPath, `bun ${HOOK_SCRIPT}`); }
  catch (err) { log("error", `install claude hook (${dir}) failed: ${err}`); }
  try {
    if (safetyEnabled) installSafetyDeny(settingsPath);
    else uninstallSafetyDeny(settingsPath);
  } catch (err) {
    log("error", `apply safety deny rules (${dir}) failed: ${err}`);
  }
}

function ensureWorkspaceClaudeSettings(): void {
  installClaudeSettingsInto(config.cwd);
}

/**
 * Apply (or remove) Claude's permissions.deny rules for sensitive paths.
 * Mirrors the live `safetyEnabled` flag, so toggling /safety on|off in
 * Telegram updates settings.json without a bot restart — for config.cwd
 * AND every chat's per-chat claude session dir (D1 moved Claude's cwd
 * per-chat, so a toggle must reach all of them immediately, not just
 * lazily at each chat's next message). Confirm gate must be enabled at
 * boot — when it isn't the hook isn't installed and these deny rules
 * wouldn't be enforced by anyone either.
 */
function applySafetyDenyRules(): void {
  installClaudeSettingsInto(config.cwd);
  const claudeSessionsRoot = join(SESSION_ROOT, "claude");
  let chatDirNames: string[] = [];
  try {
    chatDirNames = readdirSync(claudeSessionsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { /* no per-chat claude sessions yet — fine */ }
  for (const name of chatDirNames) {
    installClaudeSettingsInto(join(claudeSessionsRoot, name));
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
  if (!confirmGateEnabled) return M.safetyDisabledLabel;
  return safetyEnabled ? "ON" : "OFF";
}

async function handleSafetyCommand(chatId: number, arg: string): Promise<void> {
  // When the hook was disabled at boot via config, the toggle is inert —
  // the wired pre-tool hook simply isn't there to ask in the first place.
  if (!confirmGateEnabled) {
    await sendMessage(chatId, M.safetyDisabledNotice);
    return;
  }
  if (arg === "" || arg === "status") {
    const state = safetyEnabled ? "ON" : "OFF";
    const detail = safetyEnabled ? M.safetyStatusDetailOn : M.safetyStatusDetailOff;
    await sendMessage(chatId, M.safetyStatusMessage(state, detail));
    return;
  }
  if (arg === "on") {
    if (safetyEnabled) { await sendMessage(chatId, M.safetyAlreadyOn); return; }
    safetyEnabled = true;
    saveSafety(true);
    applySafetyDenyRules();
    log("info", `safety: ON (chat=${chatId})`);
    await sendMessage(chatId, M.safetyOnNotice);
    return;
  }
  if (arg === "off") {
    if (!safetyEnabled) { await sendMessage(chatId, M.safetyAlreadyOff); return; }
    safetyEnabled = false;
    saveSafety(false);
    applySafetyDenyRules();
    log("info", `safety: OFF (chat=${chatId})`);
    await sendMessage(chatId, M.safetyOffNotice);
    return;
  }
  await sendMessage(chatId, M.safetyUsage);
}

async function handleModelCommand(chatId: number, chat: ChatState, text: string): Promise<void> {
  const parsed = parseModelCommand(text);
  const agent = chat.active;
  if (parsed.kind === "show") {
    const eff = effectiveModel(chat, agent) ?? M.modelDefaultLabel;
    await sendMessage(chatId, M.modelShow(agent, eff));
    return;
  }
  if (parsed.kind === "clear") {
    if (chat.modelOverride) delete chat.modelOverride[agent];
    saveStore(store);
    await sendMessage(chatId, M.modelCleared(agent));
    return;
  }
  if (!chat.modelOverride) chat.modelOverride = {};
  chat.modelOverride[agent] = parsed.model;
  saveStore(store);
  await sendMessage(chatId, M.modelSet(agent, parsed.model));
}

async function handlePlanCommand(chatId: number, chat: ChatState, text: string): Promise<void> {
  const parsed = parsePlanCommand(text);
  if (parsed === null) {
    await sendMessage(chatId, M.planUsage);
    return;
  }
  if (parsed === "show") {
    await sendMessage(chatId, M.planShow(chat.planMode ? "ON" : "OFF"));
    return;
  }
  const turningOn = parsed === "on";
  chat.planMode = turningOn;
  saveStore(store);
  if (chat.active !== "claude") {
    await sendMessage(chatId, M.planClaudeOnly);
    return;
  }
  await sendMessage(chatId, turningOn ? M.planOnNotice : M.planOffNotice);
}

function helpText(active: Agent): string {
  return M.helpText({
    active,
    agentNames: AGENT_NAMES,
    cwd: config.cwd,
    safetyLabel: safetyLabel(),
    streamingLabel: streamingEnabled ? "ON (claude)" : "OFF",
  });
}

function fmtMs(ms: number | undefined): string {
  if (!ms) return "—";
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

const BOOT_AT = Date.now();

/** Format milliseconds as a human-readable duration ("3m 12s"). */
function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${rest}s`);
  return parts.join(" ");
}

/** Format byte count compactly (KB / MB / GB). */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** System-wide health snapshot: uptime, memory, log sizes, active chats. */
function healthText(): string {
  const uptime = fmtUptime(Date.now() - BOOT_AT);
  const mem = process.memoryUsage();
  const rss = fmtBytes(mem.rss);
  const heap = `${fmtBytes(mem.heapUsed)} / ${fmtBytes(mem.heapTotal)}`;

  let logSize = 0, auditSize = 0, errSize = 0;
  try { logSize = statSync(LOG_FILE).size; } catch { /* missing — fine */ }
  try { auditSize = statSync(AUDIT_FILE).size; } catch { /* missing — fine */ }
  try { errSize = statSync(join(HOME, "logs", "bot.err")).size; } catch { /* missing — fine */ }

  const activeChats = Object.keys(store).length;
  const inFlight = jobs.size();

  return M.healthText({
    uptime,
    rss,
    heap,
    agentNames: AGENT_NAMES,
    totalAgents: ALL_AGENTS.length,
    activeChats,
    inFlight,
    logSize: fmtBytes(logSize),
    auditSize: fmtBytes(auditSize),
    errSize: fmtBytes(errSize),
    safetyLabel: safetyLabel(),
    confirmPending: confirmServer ? confirmServer.pendingCount() : null,
  });
}

function statusText(chat: ChatState, chatId: number): string {
  const rows = AGENT_NAMES.map((a) => {
    const s = chat.agents[a];
    return {
      agent: a,
      hasSession: !!s,
      mode: agentModeLabel(a),
      timeoutStr: fmtMs(agentTimeoutMs(a)),
      idleStr: fmtMs(agentIdleTimeoutMs(a)),
      turnCount: s?.turnCount,
      sessionIdShort: s ? (s.sessionId ? s.sessionId.slice(0, 8) : "—") : undefined,
      lastUsedAt: s?.lastUsedAt,
    };
  });
  const inFlight = jobs.get(chatId);
  return M.statusText({
    activeAgent: chat.active,
    rows,
    inProgress: inFlight
      ? { agent: inFlight.agent, elapsedSec: Math.round((Date.now() - inFlight.startedAt.getTime()) / 1000) }
      : null,
    confirmGatePending: confirmServer ? confirmServer.pendingCount() : null,
  });
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

  if (isNonPrivateChat(msg.chat.type)) {
    if (!nonPrivateChatsWarned.has(chatId)) {
      nonPrivateChatsWarned.add(chatId);
      await sendMessage(chatId, M.groupChatOnly);
    }
    return;
  }
  if (!userId) return;

  if (config.allowedUserIds.length === 0) {
    log("info", `UNAUTH msg from user_id=${userId} (@${msg.from?.username}) chat_id=${chatId}: "${text.slice(0, 80)}"`);
    log("info", `→ add ${userId} to config.allowedUserIds to allow this user`);
    await sendMessage(chatId, M.unauthorizedWithId(userId));
    return;
  }
  if (!config.allowedUserIds.includes(userId)) {
    log("info", `denied user_id=${userId}`);
    audit.write({ chatId, userId, type: "error", data: { kind: "unauthorized" } });
    await sendMessage(chatId, M.unauthorized);
    return;
  }

  // Rate limit BEFORE any expensive work (typing indicator, downloads,
  // agent spawn). A runaway sender hits the limiter and gets a polite
  // wait estimate without ever touching the agent dispatcher.
  const decision = rateLimiter.check(chatId);
  if (!decision.ok) {
    const seconds = Math.ceil(decision.retryAfterMs / 1000);
    log("info", `rate limited chat=${chatId} retry_in=${seconds}s`);
    audit.write({ chatId, userId, type: "error", data: { kind: "rate_limited", retry_after_ms: decision.retryAfterMs } });
    await sendMessage(chatId, M.rateLimited(seconds));
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
      await sendMessage(chatId, M.attachmentDownloadFailed(err));
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
    await sendMessage(chatId, M.switchedAgent(switchTo, s ? s.turnCount : null));
    return;
  }

  if (text === "/safety" || text.startsWith("/safety ")) {
    audit.write({ chatId, userId, type: "cmd", data: { cmd: "safety", arg: text.slice(7).trim() } });
    await handleSafetyCommand(chatId, text.slice(7).trim().toLowerCase());
    return;
  }

  if (text === "/model" || text.startsWith("/model ")) {
    audit.write({ chatId, userId, type: "cmd", data: { cmd: "model", arg: text.slice(6).trim() } });
    await handleModelCommand(chatId, chat, text);
    return;
  }

  if (text === "/plan" || text.startsWith("/plan ")) {
    audit.write({ chatId, userId, type: "cmd", data: { cmd: "plan", arg: text.slice(5).trim() } });
    await handlePlanCommand(chatId, chat, text);
    return;
  }

  if (text === "/status") {
    audit.write({ chatId, userId, type: "cmd", data: { cmd: "status" } });
    await sendMessage(chatId, statusText(chat, chatId));
    return;
  }

  if (text === "/health") {
    audit.write({ chatId, userId, type: "cmd", data: { cmd: "health" } });
    await sendMessage(chatId, healthText());
    return;
  }

  if (text === "/stop") {
    const cancelled = jobs.cancel(chatId);
    audit.write({ chatId, userId, type: "stop", data: { hadJob: !!cancelled, agent: cancelled?.agent } });
    if (cancelled) {
      const elapsed = Math.round((Date.now() - cancelled.startedAt.getTime()) / 1000);
      await sendMessage(chatId, M.stopCancelled(cancelled.agent, elapsed));
    } else {
      await sendMessage(chatId, M.noJobInProgress);
    }
    return;
  }

  if (text === "/reset" || text === "/reset all") {
    audit.write({ chatId, userId, type: "cmd", data: { cmd: text } });
    if (text === "/reset all") {
      chat.agents = {};
      saveStore(store);
      await sendMessage(chatId, M.resetAllDone);
    } else {
      delete chat.agents[chat.active];
      saveStore(store);
      await sendMessage(chatId, M.resetAgentDone(chat.active));
    }
    return;
  }

  if (mediaPaths.length > 0) {
    // An image-bearing message is always a prompt — never a command — and
    // we prepend the file paths so Claude can pick them up via Read.
    if (!text) text = M.defaultImagePrompt;
    const refs = mediaPaths.map((p) => `- ${p}`).join("\n");
    text = `${text}${M.imageAttachmentNote(refs)}`;
  }

  if (isPassthrough(text)) {
    // Native slash-command passthrough (D3): strip one leading slash and
    // send the remainder verbatim as a prompt through the normal job
    // pipeline. Must run BEFORE the unknown-command rejection below since
    // the resulting prompt itself starts with "/" (e.g. "//compact" -> "/compact").
    audit.write({ chatId, userId, type: "cmd", data: { cmd: "passthrough", raw: text.slice(0, 200) } });
    text = passthroughPrompt(text);
  } else if (!text || text.startsWith("/")) {
    if (text.startsWith("/")) await sendMessage(chatId, M.unknownCommand(text, helpText(chat.active)));
    return;
  }

  const existing = jobs.get(chatId);
  if (existing) {
    const elapsed = Math.round((Date.now() - existing.startedAt.getTime()) / 1000);
    audit.write({ chatId, userId, type: "lock_reject", data: { agent: existing.agent, elapsedSec: elapsed } });
    await sendMessage(chatId, M.jobInProgressLock(existing.agent, elapsed));
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
    await sendMessage(chatId, M.autoResetTurns(agent, maxTurns));
  }

  let job: Job;
  try {
    job = jobs.register(chatId, agent);
  } catch {
    await sendMessage(chatId, M.jobAlreadyRegistered(agent));
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
          const html = markdownToTelegramHtml(autoCloseUnfinished(t));
          try {
            const m = await tg<TgMessage>("sendMessage", { chat_id: cid, text: html, parse_mode: "HTML" });
            return { message_id: m.message_id };
          } catch {
            const m = await tg<TgMessage>("sendMessage", { chat_id: cid, text: t });
            return { message_id: m.message_id };
          }
        },
        edit: async (cid, id, t) => {
          const html = markdownToTelegramHtml(autoCloseUnfinished(t));
          try { await tg("editMessageText", { chat_id: cid, message_id: id, text: html, parse_mode: "HTML" }); }
          catch { await tg("editMessageText", { chat_id: cid, message_id: id, text: t }); }
        },
        minIntervalMs: streamMinIntervalMs,
        onError: (err) => log("error", `stream: ${err instanceof Error ? err.message : err}`),
        fallbackSend: async (t) => {
          try {
            await sendMessage(chatId, t);
            return true;
          } catch {
            return false;
          }
        },
        measure: (t) => markdownToTelegramHtml(autoCloseUnfinished(t)).length,
      })
    : null;

  try {
    let result = await runAgent(agent, text, chatId, sessionBefore, job.abort.signal, onProgress, stream, chat);

    // --continue can fail if the cwd has no prior session OR if Claude can't
    // locate one. In that case, retry once as a fresh conversation.
    if (
      agent === "claude" &&
      result.error &&
      result.error !== M.userStoppedError &&
      sessionBefore && sessionBefore.turnCount > 0 &&
      /no conversation|session|continue|resume/i.test(result.error)
    ) {
      log("info", `claude --continue failed for chat=${chatId}, retrying fresh`);
      delete chat.agents.claude;
      result = await runClaude(text, undefined, chatId, job.abort.signal, onProgress, stream, effectiveModel(chat, "claude") ?? config.agents.claude.model, !!chat.planMode);
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
      if (result.error) await sendMessage(chatId, M.agentError(agent, result.error));
    } else if (result.error) {
      await sendMessage(chatId, M.agentError(agent, result.error));
    } else {
      await sendMessage(chatId, M.agentReply(agent, result.text || M.emptyResponse));
    }
    // Move the rolling tool bubble below the answer (or remove it if nothing was used).
    await toolIndicator.finalize();
  } catch (err) {
    log("error", `handler failed: ${err instanceof Error ? err.stack : err}`);
    audit.write({ chatId, userId, type: "error", agent, data: { err: err instanceof Error ? err.message : String(err) } });
    await sendMessage(chatId, M.internalError(err instanceof Error ? err.message : String(err)));
    // Best effort: clean up any rolling bubble so it doesn't linger over the error.
    try { await toolIndicator.clear(); } catch { /* swallow */ }
  } finally {
    clearInterval(typingHandle);
    jobs.clear(chatId);
  }
}

// ---------- polling loop ----------
let running = true;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Drain in-flight jobs before exiting: cancel each (SIGTERMs its process
// group via the abort-signal listener already wired in runAgent) and fire a
// best-effort restart notice to its chat. The whole notify phase is bounded
// at 3s so a stuck Telegram call can never delay shutdown, and every step is
// wrapped so shutdown() itself can never throw or reject.
const shutdown = (signal: string): void => {
  log("info", signal);
  running = false;
  void (async () => {
    try {
      const sends = jobs.entries().map(async (job) => {
        jobs.cancel(job.chatId);
        try {
          await sendMessage(job.chatId, M.shutdownRestartNotice);
        } catch { /* best effort — never block shutdown on a failed notify */ }
      });
      await Promise.race([Promise.allSettled(sends), sleep(3000)]);
    } catch (err) {
      log("error", `shutdown drain failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Best-effort: stop confirm server so the socket file is cleaned up.
      void confirmServer?.stop().catch(() => {});
      try { releaseInstanceLock(HOME); } catch (err) { log("error", `releaseInstanceLock failed: ${err instanceof Error ? err.message : String(err)}`); }
    }
  })();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function pollLoop(): Promise<void> {
  let offset = 0;
  try {
    const me = await tg<TgUser & { username: string }>("getMe");
    log("info", `bot started: @${me.username} (id=${me.id})`);
    if (_strippedEnv.length > 0) {
      log("info", `process-hardening: stripped env [${_strippedEnv.join(", ")}]`);
    }
  } catch (err) {
    log("error", `getMe failed — check token: ${err}`);
    process.exit(1);
  }

  // Register the slash-command menu so Telegram shows the "/" autocomplete list.
  // Persisted server-side; refreshed each boot so it tracks installed agents.
  try {
    await tg("setMyCommands", {
      commands: [
        ...AGENT_NAMES.map((a) => ({ command: a, description: M.commandDescAgent(a) })),
        { command: "status", description: M.commandDescStatus },
        { command: "reset", description: M.commandDescReset },
        { command: "health", description: M.commandDescHealth },
        { command: "stop", description: M.commandDescStop },
        { command: "safety", description: M.commandDescSafety },
        { command: "model", description: M.commandDescModel },
        { command: "plan", description: M.commandDescPlan },
        { command: "help", description: M.commandDescHelp },
      ],
    });
    log("info", "setMyCommands registered");
  } catch (err) {
    log("error", `setMyCommands failed: ${err}`);
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
      }, (config.pollTimeoutSec + 10) * 1000);  // client timeout > server long-poll
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

// ---------- startup housekeeping ----------
// launchd appends to bot.err across restarts, with no rotation hook of
// its own. We truncate it ourselves on every boot so a one-time crash
// loop doesn't leave the user with a GB-sized error log forever.
const STDERR_FILE = join(HOME, "logs", "bot.err");
if (truncateIfLarge(STDERR_FILE, STDERR_TRUNCATE_BYTES)) {
  log("info", `bot.err truncated (was > ${STDERR_TRUNCATE_BYTES} bytes)`);
}

// Sweep stale uploads at boot, then again periodically while the bot
// is alive. Photo attachments can balloon the workspace dir for chatty
// users with image-heavy prompts; without this the directory grows
// unbounded.
function sweepStaleUploads(): void {
  const retentionDays = config.uploadsRetentionDays ?? 7;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removedFiles = 0;
  let removedBytes = 0;
  try {
    const chatDirs = readdirSync(UPLOADS_ROOT, { withFileTypes: true });
    for (const dir of chatDirs) {
      if (!dir.isDirectory()) continue;
      const chatDir = join(UPLOADS_ROOT, dir.name);
      for (const f of readdirSync(chatDir, { withFileTypes: true })) {
        if (!f.isFile()) continue;
        const path = join(chatDir, f.name);
        try {
          const st = statSync(path);
          if (st.mtimeMs < cutoff) {
            unlinkSync(path);
            removedFiles++;
            removedBytes += st.size;
          }
        } catch { /* ignore — best effort */ }
      }
    }
  } catch { /* UPLOADS_ROOT may not exist yet — fine */ }
  if (removedFiles > 0) {
    log("info", `uploads sweep: removed ${removedFiles} files (${Math.round(removedBytes / 1024)} KB) older than ${retentionDays}d`);
  }
}
sweepStaleUploads();
// Re-sweep once a day so a long-running bot doesn't accumulate
// week-old photos between restarts.
setInterval(sweepStaleUploads, 24 * 60 * 60 * 1000).unref?.();

// Sweep stale per-chat session dirs (sessions/<agent>/<chatId>) the same way.
// Skipped entirely while any job is running — a running job's dir mtime is
// always fresh anyway (jobs are bounded by agentTimeoutMs, far under any
// practical retention window), so this is a no-op cost, not a lost sweep.
function sweepStaleSessions(): void {
  const retentionDays = config.sessionRetentionDays ?? 30;
  if (jobs.size() > 0) return;
  const removed = sweepStaleSessionDirs(SESSION_ROOT, retentionDays);
  if (removed.length > 0) {
    log("info", `session sweep: removed ${removed.length} stale chat dirs older than ${retentionDays}d`);
  }
}
sweepStaleSessions();
setInterval(sweepStaleSessions, 24 * 60 * 60 * 1000).unref?.();

// ---------- startup ----------
ensureWorkspaceClaudeSettings();
if (confirmServer) await confirmServer.start();

await pollLoop();
