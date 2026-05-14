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

    // ── Step 4: Corporate TLS CA (optional) ───────────────────────────
    section("Step 4/5 — Corporate TLS interceptor (선택)");
    info("회사망에서 Zscaler / Forticlient / Cisco Umbrella 등이 HTTPS 를 가로채면");
    info("Node 가 Telegram 인증서를 신뢰하지 못해 봇이 메시지를 받을 수 없습니다.");
    info("해당 환경이면 CA 인증서(.pem) 경로를 알려주세요 — 봇 LaunchAgent 에만 적용됩니다.");
    const caCert = await detectCaCert(rl);

    // ── Write config.json ─────────────────────────────────────────────
    writeConfig(opts.home, {
      token,
      allowedUserIds: [userId],
      defaultAgent,
      detected,
      caCert,
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
      warn(`${c.source}: 잘못된 placeholder가 포함된 경로라 건너뜁니다 (${c.value})`);
      continue;
    }
    if (!existsSync(c.value)) {
      warn(`${c.source}: 파일이 존재하지 않아 건너뜁니다 (${c.value})`);
      continue;
    }
    info(`${c.source}: ${c.value}`);
    if (await yesNo(rl, "이 CA 인증서를 봇의 LaunchAgent 환경에 적용할까요?", true)) {
      return c.value;
    }
    return null;
  }

  const manual = (await rl.question("CA 경로 (없으면 Enter): ")).trim();
  if (!manual) return null;
  if (/[<>]/.test(manual)) {
    warn("경로에 placeholder 문자(< 또는 >)가 있어 적용하지 않습니다.");
    return null;
  }
  if (!existsSync(manual)) {
    warn(`파일을 찾을 수 없습니다: ${manual} — 적용하지 않습니다.`);
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

async function tg<T>(token: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
  return data.result as T;
}

async function getMe(token: string): Promise<TgUser> {
  try {
    return await tg<TgUser>(token, "getMe");
  } catch (e) {
    fail(`Bot token rejected by Telegram: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function waitForFirstMessage(token: string): Promise<number> {
  // Drain any backlog so we only capture a *new* message after this prompt.
  // getUpdates returns the queue; we ack everything past the highest id.
  const drained = await tg<TgUpdate[]>(token, "getUpdates", { timeout: 0 });
  let offset = drained.length ? drained[drained.length - 1].update_id + 1 : 0;

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const updates = await tg<TgUpdate[]>(token, "getUpdates", {
      offset,
      timeout: 25,
    });
    for (const u of updates) {
      offset = u.update_id + 1;
      const from = u.message?.from;
      if (from && !from.is_bot) {
        // Acknowledge so the message isn't redelivered to the running bot.
        await tg(token, "getUpdates", { offset });
        return from.id;
      }
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
