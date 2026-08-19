/// <reference types="node" />
/**
 * Interactive `cliclaw init` flow.
 *
 * Walks the user through 4 steps that produce a working config.json under
 * $CLICLAW_HOME and (optionally) install a LaunchAgent. The fewer hidden
 * assumptions here the better — every external dependency (telegram API,
 * agent binary discovery, filesystem layout) is validated inline so the
 * user knows immediately what was found.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { resolveCliPath, type SupportedCli } from "./resolve-cli-path.ts";
import * as launchd from "./launchd.ts";

const AGENTS: SupportedCli[] = ["claude", "codex", "pi", "gemini"];
const TELEGRAM_API = "https://api.telegram.org";

export interface SetupOptions {
  /** Path to CLICLAW_HOME for this user. */
  home: string;
  /** Absolute path to bot.ts. */
  entryTs: string;
  /** Absolute path to bun binary. */
  bunPath: string;
}

export async function runInit(opts: SetupOptions): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    section("Welcome to cliclaw setup.");
    info(`State directory: ${opts.home}`);
    info(`Bot source: ${opts.entryTs}`);

    const locale = await promptLocale(rl);

    // ── Step 1: Telegram token ────────────────────────────────────────
    section("Step 1/5 — Telegram bot token");
    info("Get one from @BotFather (/newbot) on Telegram.");
    const token = await promptToken(rl);
    const me = await getMe(token);
    ok(`@${me.username} (id=${me.id}) verified`);

    // ── Step 2: Detect installed agents ───────────────────────────────
    section("Step 2/5 — Detect installed coding agents");
    const detected = detectAgents();
    for (const a of AGENTS) {
      const found = detected[a];
      if (found) ok(`${a.padEnd(7)} ${truncVersion(found.version)} @ ${found.path}`);
      else warn(`${a.padEnd(7)} not installed`);
    }
    const installed = AGENTS.filter((a) => detected[a]);
    if (installed.length === 0) {
      fail("No coding agents found. Install at least one (claude / codex / pi) and rerun.");
      process.exit(1);
    }
    const defaultAgent = await pickDefaultAgent(rl, installed);
    ok(`Default agent: ${defaultAgent}`);

    // ── Step 3: Authorize Telegram account ────────────────────────────
    section("Step 3/5 — Authorize your Telegram account");
    info(`Open Telegram and send any message to @${me.username} now.`);
    info("Waiting up to 5 minutes... press Ctrl-C to abort.");
    const userId = await waitForFirstMessage(token);
    ok(`Received from user_id=${userId}`);
    const authorize = await yesNo(rl, "Authorize this Telegram user?", true);
    if (!authorize) {
      fail("Aborted by user.");
      process.exit(1);
    }
    // Re-running init must not silently drop users authorized by a prior
    // run — merge by default, and only replace on an explicit opt-in.
    const existingUserIds = readExistingAllowedUserIds(opts.home);
    let allowedUserIds: number[];
    if (existingUserIds.length > 0) {
      info(`Existing authorized users kept: [${existingUserIds.join(", ")}]`);
      const replace = await yesNo(rl, "Replace instead of merge?", false);
      allowedUserIds = replace
        ? [userId]
        : mergeAllowedUserIds(existingUserIds, userId);
    } else {
      allowedUserIds = [userId];
    }

    // ── Step 4: Corporate TLS CA (optional) ───────────────────────────
    section("Step 4/5 — Corporate TLS interceptor (optional)");
    info("If your network's Zscaler / Forticlient / Cisco Umbrella (or similar) intercepts HTTPS,");
    info("Node won't trust Telegram's certificate and the bot won't be able to receive messages.");
    info("If that's your environment, provide the CA certificate (.pem) path — applied only to the bot's LaunchAgent.");
    const caCert = await detectCaCert(rl);

    // ── Write config.json ─────────────────────────────────────────────
    writeConfig(opts.home, {
      token,
      allowedUserIds,
      defaultAgent,
      detected,
      caCert,
      locale,
    });
    ok(`Wrote ${join(opts.home, "config.json")} (chmod 600)`);

    // ── Step 5: Auto-start at login (optional) ────────────────────────
    section("Step 5/5 — Auto-start at login (launchd)");
    const wantLaunchd = await yesNo(
      rl,
      "Install LaunchAgent so the bot starts automatically on login?",
      true,
    );
    if (wantLaunchd) {
      const result = launchd.install({
        entryTs: opts.entryTs,
        bunPath: opts.bunPath,
        cliclawHome: opts.home,
        extraEnv: caCert ? { NODE_EXTRA_CA_CERTS: caCert } : undefined,
      });
      if (result.loaded) {
        ok(`Installed ${result.path}`);
        ok("Bot started.");
      } else {
        warn(result.message);
        info(`Run later: launchctl bootstrap gui/$UID ${result.path}`);
      }
    } else {
      info(`Start manually:  CLICLAW_HOME=${opts.home} ${opts.bunPath} run ${opts.entryTs}`);
      info("Or:  cliclaw start");
    }

    section("All set.");
    info(`Logs:  tail -f ${join(opts.home, "logs", "bot.log")}`);
    info("Test:  send /status in Telegram.");
  } finally {
    rl.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────

/** Bot language for Telegram chat UX. Retry-free: anything other than "ko" is "en". */
async function promptLocale(rl: ReturnType<typeof createInterface>): Promise<string> {
  const ans = (await rl.question("Bot language for Telegram chat UX — en/ko [en]: ")).trim().toLowerCase();
  return ans === "ko" ? "ko" : "en";
}

async function promptToken(rl: ReturnType<typeof createInterface>): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const t = (await rl.question("Bot token: ")).trim();
    if (/^\d+:[A-Za-z0-9_-]{20,}$/.test(t)) return t;
    warn("That does not look like a BotFather token. Format: 1234:ABC...");
  }
  fail("Could not read a valid token.");
  process.exit(1);
}

async function pickDefaultAgent(
  rl: ReturnType<typeof createInterface>,
  installed: SupportedCli[],
): Promise<SupportedCli> {
  if (installed.length === 1) return installed[0];
  const list = installed.join("/");
  const first = installed[0];
  const ans = (await rl.question(`Default agent? [${first}] (${list}): `)).trim().toLowerCase();
  if (!ans) return first;
  if (installed.includes(ans as SupportedCli)) return ans as SupportedCli;
  warn(`Unknown agent '${ans}', using '${first}'.`);
  return first;
}

async function yesNo(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const ans = (await rl.question(`${question} ${hint} `)).trim().toLowerCase();
  if (!ans) return defaultYes;
  return ans.startsWith("y");
}

/** Dedup existing authorized user ids with the newly captured one, keeping
 *  a re-run of init from silently revoking access for prior users. */
export function mergeAllowedUserIds(existing: number[], captured: number): number[] {
  return Array.from(new Set([...existing, captured]));
}

/**
 * Probe for a TLS interceptor CA cert that the bot's launchd process should
 * trust. Tries in order: $NODE_EXTRA_CA_CERTS, `launchctl getenv …`, then
 * a manual prompt as a final fallback. Paths containing placeholder text
 * like `<username>` are rejected up front — those are a common artifact of
 * a half-customized internal install script and would silently fail at
 * runtime instead of obviously here.
 */
async function detectCaCert(
  rl: ReturnType<typeof createInterface>,
): Promise<string | null> {
  const candidates: { value: string; source: string }[] = [];
  if (process.env.NODE_EXTRA_CA_CERTS) {
    candidates.push({ value: process.env.NODE_EXTRA_CA_CERTS, source: "$NODE_EXTRA_CA_CERTS" });
  }
  try {
    const v = execFileSync("launchctl", ["getenv", "NODE_EXTRA_CA_CERTS"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (v) candidates.push({ value: v, source: "launchctl getenv" });
  } catch { /* not set — fine */ }

  for (const c of candidates) {
    if (/[<>]/.test(c.value)) {
      warn(`${c.source}: skipping — path contains an unresolved placeholder (${c.value})`);
      continue;
    }
    if (!existsSync(c.value)) {
      warn(`${c.source}: skipping — file does not exist (${c.value})`);
      continue;
    }
    info(`${c.source}: ${c.value}`);
    if (await yesNo(rl, "Apply this CA certificate to the bot's LaunchAgent environment?", true)) {
      return c.value;
    }
    return null;
  }

  const manual = (await rl.question("CA path (Enter to skip): ")).trim();
  if (!manual) return null;
  if (/[<>]/.test(manual)) {
    warn("Not applying — path contains a placeholder character (< or >).");
    return null;
  }
  if (!existsSync(manual)) {
    warn(`File not found: ${manual} — not applying.`);
    return null;
  }
  return manual;
}

// ─────────────────────────────────────────────────────────────────────
// Agent detection
// ─────────────────────────────────────────────────────────────────────

interface AgentInfo {
  path: string;
  version: string;
}

function detectAgents(): Partial<Record<SupportedCli, AgentInfo>> {
  const out: Partial<Record<SupportedCli, AgentInfo>> = {};
  for (const a of AGENTS) {
    const path = resolveCliPath(a);
    if (!path) continue;
    out[a] = { path, version: cliVersion(path) };
  }
  return out;
}

function cliVersion(path: string): string {
  try {
    const v = execFileSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return v.split("\n")[0].trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function truncVersion(v: string): string {
  return v.length > 40 ? `${v.slice(0, 37)}...` : v;
}

// ─────────────────────────────────────────────────────────────────────
// Telegram
// ─────────────────────────────────────────────────────────────────────

interface TgUser { id: number; is_bot: boolean; username?: string; }
interface TgMessage { from?: TgUser; chat: { id: number } }
interface TgUpdate { update_id: number; message?: TgMessage; }

/** Thrown when Telegram's API itself rejects the request (`data.ok ===
 *  false`) — as opposed to a network-layer failure reaching it at all. This
 *  distinction is what lets callers attribute a failure correctly instead
 *  of always blaming the bot token. */
export class TelegramApiError extends Error {
  constructor(public readonly description: string) {
    super(description);
  }
}

async function tg<T>(token: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new TelegramApiError(data.description ?? "unknown error");
  return data.result as T;
}

/** Turn a `getMe` failure into an actionable message, distinguishing a
 *  network-layer failure (fetch/DNS/TLS/proxy — never the token's fault)
 *  from Telegram explicitly rejecting the token. */
export function classifyGetMeError(e: unknown): string {
  if (e instanceof TelegramApiError) {
    return `Bot token rejected by Telegram: ${e.description}`;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return `Network error reaching api.telegram.org: ${msg}. Check connectivity / proxy / corporate TLS.`;
}

async function getMe(token: string): Promise<TgUser> {
  try {
    return await tg<TgUser>(token, "getMe");
  } catch (e) {
    fail(classifyGetMeError(e));
    process.exit(1);
  }
}

/** Non-exiting variant of `getMe`, for callers (like `doctor`) that want
 *  to report the outcome themselves instead of aborting the process. */
export async function getMeSafe(token: string): Promise<TgUser> {
  return tg<TgUser>(token, "getMe");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** True once at least `intervalMs` has passed since the last printed retry
 *  note — throttles the "network hiccup" note to at most once per window
 *  instead of once per failed poll. */
export function shouldPrintWaitNote(lastNoteAt: number, now: number, intervalMs: number): boolean {
  return now - lastNoteAt >= intervalMs;
}

export interface WaitForFirstMessageOptions {
  /** Override the getUpdates call, for tests. Defaults to the real `tg()`. */
  getUpdates?: (offset: number, timeoutSec: number) => Promise<TgUpdate[]>;
  /** Override the retry sleep, for tests. */
  sleepMs?: (ms: number) => Promise<void>;
  /** Override the overall wait deadline, for tests. Default: 5 minutes. */
  deadlineMs?: number;
  /** Override the throttle window between retry notes, for tests. Default: 30s. */
  noteIntervalMs?: number;
}

async function waitForFirstMessage(
  token: string,
  opts: WaitForFirstMessageOptions = {},
): Promise<number> {
  const getUpdates = opts.getUpdates
    ?? ((offset: number, timeoutSec: number) => tg<TgUpdate[]>(token, "getUpdates", { offset, timeout: timeoutSec }));
  const sleepMs = opts.sleepMs ?? sleep;
  const deadlineMs = opts.deadlineMs ?? 5 * 60 * 1000;
  const noteIntervalMs = opts.noteIntervalMs ?? 30_000;

  const deadline = Date.now() + deadlineMs;
  let offset = 0;
  let drained = false;
  let lastNoteAt = 0;

  while (Date.now() < deadline) {
    try {
      if (!drained) {
        // Drain any backlog so we only capture a *new* message after this
        // prompt. getUpdates returns the queue; we start polling past the
        // highest id already seen.
        const backlog = await getUpdates(0, 0);
        offset = backlog.length ? backlog[backlog.length - 1].update_id + 1 : 0;
        drained = true;
        continue;
      }
      const updates = await getUpdates(offset, 25);
      for (const u of updates) {
        offset = u.update_id + 1;
        const from = u.message?.from;
        if (from && !from.is_bot) {
          try {
            // Acknowledge so the message isn't redelivered to the running
            // bot. Best-effort: the user id we need is already captured.
            await getUpdates(offset, 0);
          } catch {
            // Ignore — see above.
          }
          return from.id;
        }
      }
    } catch {
      // A network hiccup during the wait must not crash init with a raw
      // stack trace — note it (throttled) and keep retrying until deadline.
      const now = Date.now();
      if (shouldPrintWaitNote(lastNoteAt, now, noteIntervalMs)) {
        info("waiting… (network hiccup, retrying)");
        lastNoteAt = now;
      }
      await sleepMs(3000);
    }
  }
  fail("Timed out waiting for a Telegram message.");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────
// Config file
// ─────────────────────────────────────────────────────────────────────

interface WriteConfigArgs {
  token: string;
  allowedUserIds: number[];
  defaultAgent: SupportedCli;
  detected: Partial<Record<SupportedCli, AgentInfo>>;
  /** Optional NODE_EXTRA_CA_CERTS path for the bot's launchd env. */
  caCert: string | null;
  /** Telegram chat UX locale ("en" | "ko"). */
  locale: string;
}

/** Read `allowedUserIds` from an existing config.json, if any. Missing
 *  file, missing field, or unparsable JSON all read as "no existing
 *  users" — re-init proceeds as a fresh authorization in that case. */
export function readExistingAllowedUserIds(home: string): number[] {
  const configPath = join(home, "config.json");
  if (!existsSync(configPath)) return [];
  try {
    const existing = JSON.parse(readFileSync(configPath, "utf8"));
    return Array.isArray(existing.allowedUserIds) ? existing.allowedUserIds : [];
  } catch {
    return [];
  }
}

function writeConfig(home: string, args: WriteConfigArgs): void {
  mkdirSync(home, { recursive: true });
  const configPath = join(home, "config.json");

  // Preserve existing settings if the file already exists — re-running init
  // should be safe and additive.
  const existing = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : {};

  const config = {
    ...existing,
    token: args.token,
    allowedUserIds: args.allowedUserIds,
    cwd: existing.cwd ?? "./workspace",
    defaultAgent: args.defaultAgent,
    locale: args.locale,
    agents: {
      claude: {
        path: args.detected.claude?.path ?? "",
        model: existing.agents?.claude?.model ?? "sonnet",
        maxTurns: existing.agents?.claude?.maxTurns ?? 100,
      },
      codex: {
        path: args.detected.codex?.path ?? "",
        model: existing.agents?.codex?.model ?? null,
        sandbox: existing.agents?.codex?.sandbox ?? "workspace-write",
        maxTurns: existing.agents?.codex?.maxTurns ?? 50,
      },
      pi: {
        path: args.detected.pi?.path ?? "",
        model: existing.agents?.pi?.model ?? null,
        provider: existing.agents?.pi?.provider ?? null,
        maxTurns: existing.agents?.pi?.maxTurns ?? 50,
      },
      gemini: {
        path: args.detected.gemini?.path ?? "",
        model: existing.agents?.gemini?.model ?? null,
        // Default to auto_edit (auto-approve edit tools, prompt on
        // destructive ones) rather than yolo (auto-approve everything).
        // Gemini does not yet integrate with cliclaw's bash-confirm IPC
        // so a stronger upstream default is the only line of defense
        // for shell-level actions.
        approvalMode: existing.agents?.gemini?.approvalMode ?? "auto_edit",
        maxTurns: existing.agents?.gemini?.maxTurns ?? 50,
      },
    },
    sessionTimeoutMs: existing.sessionTimeoutMs ?? 1_800_000,
    pollTimeoutSec: existing.pollTimeoutSec ?? 30,
    logLevel: existing.logLevel ?? "info",
    confirmGate: existing.confirmGate ?? { enabled: true, pendingTimeoutMs: 300_000 },
    streaming: existing.streaming ?? { enabled: true },
    // launchd.extraEnv persists user choices like NODE_EXTRA_CA_CERTS so a
    // later `cliclaw install-launchd` (after an uninstall, after a version
    // bump, etc.) can recreate the plist with the same env without having
    // to re-run the full `init` wizard.
    launchd: {
      ...(existing.launchd ?? {}),
      extraEnv: args.caCert
        ? { ...(existing.launchd?.extraEnv ?? {}), NODE_EXTRA_CA_CERTS: args.caCert }
        : existing.launchd?.extraEnv,
    },
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(configPath, 0o600);
}

// ─────────────────────────────────────────────────────────────────────
// Pretty output
// ─────────────────────────────────────────────────────────────────────

function section(s: string): void { stdout.write(`\n\x1b[1m${s}\x1b[0m\n`); }
function info(s: string): void    { stdout.write(`  ${s}\n`); }
function ok(s: string): void      { stdout.write(`  \x1b[32m✓\x1b[0m ${s}\n`); }
function warn(s: string): void    { stdout.write(`  \x1b[33m✗\x1b[0m ${s}\n`); }
function fail(s: string): void    { stdout.write(`  \x1b[31m✗\x1b[0m ${s}\n`); }

// Silence the unused-import lint when these helpers are tree-shaken in a
// future build target. They're cheap and keep the API surface stable.
export const _internals = { detectAgents, getMe, waitForFirstMessage, writeConfig };
export type { TgUser, TgMessage, TgUpdate, AgentInfo };
export { dirname, homedir };
