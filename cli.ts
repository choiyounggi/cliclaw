#!/usr/bin/env bun
/// <reference types="bun" />
/// <reference types="node" />
/**
 * cliclaw CLI entry point.
 *
 * Subcommands:
 *   init                — interactive setup (writes ~/.cliclaw/config.json)
 *   start               — run the bot in the foreground (CLICLAW_HOME-aware)
 *   install-launchd     — write + load LaunchAgent (after manual config edit)
 *   uninstall-launchd   — unload + remove LaunchAgent
 *   doctor              — live checks: token, launchd, agents, TLS CA
 *   help                — usage
 */

import { resolve, dirname, join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { existsSync, readFileSync } from "node:fs";

import * as launchd from "./lib/launchd.ts";
import { resolveCliPath } from "./lib/resolve-cli-path.ts";
import { printBanner } from "./lib/banner.ts";

const ROOT = dirname(Bun.fileURLToPath(import.meta.url));
const ENTRY_TS = resolve(ROOT, "bot.ts");
const BUN_PATH = resolveBunPath();
const HOME = process.env.CLICLAW_HOME
  ? resolve(process.env.CLICLAW_HOME)
  : join(homedir(), ".cliclaw");

function resolveBunPath(): string {
  // process.execPath is the bun binary that is running this script.
  return process.execPath;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  // Skip the banner on `start` because the bot daemon's stdout follows
  // immediately afterward and the art would just push real logs off-screen
  // / mix with launchd's bot.log. Every other command is interactive.
  if (cmd !== "start") printBanner(import.meta.url);
  switch (cmd ?? "help") {
    case "init":
      await cmdInit();
      break;
    case "start":
      cmdStart(rest);
      break;
    case "install-launchd":
      cmdInstallLaunchd();
      break;
    case "uninstall-launchd":
      cmdUninstallLaunchd();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "upgrade":
      await cmdUpgrade();
      break;
    case "logs":
      cmdLogs(rest);
      break;
    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printUsage();
      process.exit(2);
  }
}

async function cmdInit(): Promise<void> {
  const { runInit } = await import("./lib/setup.ts");
  await runInit({ home: HOME, entryTs: ENTRY_TS, bunPath: BUN_PATH });
}

function cmdStart(extra: string[]): void {
  if (!existsSync(join(HOME, "config.json"))) {
    console.error(`No config at ${HOME}/config.json — run \`cliclaw init\` first.`);
    process.exit(1);
  }
  // Foreground spawn so Ctrl-C cleanly stops the bot. The launchd path is
  // separate (install-launchd).
  const child = spawn(BUN_PATH, ["run", ENTRY_TS, ...extra], {
    env: { ...process.env, CLICLAW_HOME: HOME },
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function cmdInstallLaunchd(): void {
  const configPath = join(HOME, "config.json");
  if (!existsSync(configPath)) {
    console.error(`No config at ${configPath} — run \`cliclaw init\` first.`);
    process.exit(1);
  }
  // Pick up any extra env the user configured at init time (NODE_EXTRA_CA_CERTS
  // etc.) so re-installing the LaunchAgent doesn't silently drop them.
  let extraEnv: Record<string, string> | undefined;
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    if (cfg.launchd?.extraEnv && typeof cfg.launchd.extraEnv === "object") {
      extraEnv = cfg.launchd.extraEnv;
    }
  } catch { /* missing or unreadable — proceed with no extras */ }
  const result = launchd.install({
    entryTs: ENTRY_TS,
    bunPath: BUN_PATH,
    cliclawHome: HOME,
    extraEnv,
  });
  console.log(result.message);
  if (!result.loaded) process.exit(1);
}

function cmdUninstallLaunchd(): void {
  const result = launchd.uninstall();
  console.log(result.message);
}

/**
 * One-line upgrade: re-install the npm/bun global package and bounce
 * the LaunchAgent so the new binary takes effect. We detect which
 * package manager the user used by which one's global node_modules
 * currently holds the cliclaw binary — falling back to plain `npm` if
 * neither is obviously the source.
 */
async function cmdUpgrade(): Promise<void> {
  const pkg = "@younggichoi/cliclaw";
  const installer = detectInstaller();
  console.log(`Upgrading ${pkg} via ${installer}…`);
  const installArgs = installer === "bun"
    ? ["add", "-g", `${pkg}@latest`]
    : ["install", "-g", `${pkg}@latest`];
  await new Promise<void>((resolve, reject) => {
    const c = spawn(installer, installArgs, { stdio: "inherit" });
    c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${installer} exited ${code}`))));
  });
  if (!existsSync(join(HOME, "config.json"))) {
    console.log("No config.json yet — run `cliclaw init` to finish setup.");
    return;
  }
  // Reinstall the LaunchAgent so it points at the new package path on
  // disk. The lib/launchd.ts install() now retries on bootout race, so
  // a back-to-back uninstall/install works.
  console.log("Reinstalling LaunchAgent…");
  cmdUninstallLaunchd();
  cmdInstallLaunchd();
}

function detectInstaller(): "bun" | "npm" {
  // ROOT looks like one of:
  //   ~/.bun/install/global/node_modules/@younggichoi/cliclaw   (bun)
  //   <prefix>/lib/node_modules/@younggichoi/cliclaw            (npm)
  return ROOT.includes("/.bun/") ? "bun" : "npm";
}

/**
 * Stream a log file with `tail -f`. Three flags pick which:
 *   default → bot.log     --audit → audit.jsonl    --err → bot.err
 */
function cmdLogs(args: string[]): void {
  let target = "bot.log";
  if (args.includes("--audit")) target = "audit.jsonl";
  else if (args.includes("--err")) target = "bot.err";
  const path = join(HOME, "logs", target);
  if (!existsSync(path)) {
    console.error(`No such log file: ${path}`);
    process.exit(1);
  }
  const child = spawn("tail", ["-F", path], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

type CheckLevel = "ok" | "warn" | "FAIL";
interface CheckResult { level: CheckLevel; message: string; }

/** Read config.json, returning null on missing file or unparsable JSON —
 *  every doctor check treats that the same way: skip cleanly, don't FAIL. */
function readConfigSafe(configPath: string): Record<string, any> | null {
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

/** Extract the `pid = <N>` line `launchctl print` emits for a loaded
 *  service. Null if the service isn't loaded or the line isn't present. */
export function parseLaunchctlPrintPid(output: string): number | null {
  const m = output.match(/^\s*"?pid"?\s*=\s*(\d+)/m);
  return m ? Number(m[1]) : null;
}

export function describeTokenCheck(
  hasConfig: boolean,
  error: unknown,
  username: string | undefined,
  classify: (e: unknown) => string,
  isTokenRejection: (e: unknown) => boolean,
): CheckResult {
  if (!hasConfig) {
    return { level: "warn", message: "no config.json yet — run `cliclaw init` first" };
  }
  if (!error) {
    return { level: "ok", message: `verified (@${username})` };
  }
  const hint = isTokenRejection(error)
    ? ". If it was revoked, generate a new one via @BotFather and re-run `cliclaw init`."
    : "";
  return { level: "FAIL", message: `${classify(error)}${hint}` };
}

export function describeLaunchdCheck(
  loaded: boolean,
  pid: number | null,
  plistExists: boolean,
): CheckResult {
  if (loaded) {
    return { level: "ok", message: pid !== null ? `loaded (pid=${pid})` : "loaded" };
  }
  if (plistExists) {
    return { level: "warn", message: "plist on disk but not loaded — run `cliclaw install-launchd`" };
  }
  return { level: "ok", message: "not installed (optional — run `cliclaw install-launchd` to enable auto-start)" };
}

export function describeAgentCheck(
  agent: string,
  path: string | null,
  version: string | null,
): CheckResult {
  if (!path) {
    return { level: "warn", message: "not found (not installed or not on PATH)" };
  }
  if (version === null) {
    return { level: "FAIL", message: `not executable at ${path} (check permissions / reinstall)` };
  }
  return { level: "ok", message: `${version} @ ${path}` };
}

export function describeTlsCheck(
  extraCaCertsPath: string | undefined,
  fileExists: boolean,
): CheckResult {
  if (!extraCaCertsPath) {
    return { level: "ok", message: "no corporate CA configured (not needed unless behind a TLS-intercepting proxy)" };
  }
  if (!fileExists) {
    return {
      level: "FAIL",
      message: `configured CA cert missing at ${extraCaCertsPath} — re-run \`cliclaw init\` (Step 4/5)`,
    };
  }
  return { level: "ok", message: `CA cert found at ${extraCaCertsPath}` };
}

async function cmdDoctor(): Promise<void> {
  console.log(`cliclaw doctor`);
  console.log(`  ROOT (source):    ${ROOT}`);
  console.log(`  HOME (state):     ${HOME}`);
  console.log(`  bot.ts:           ${ENTRY_TS}`);
  console.log(`  bun:              ${BUN_PATH}`);

  let sawFail = false;
  const report = (label: string, r: CheckResult): void => {
    console.log(`  ${r.level}: ${label} — ${r.message}`);
    if (r.level === "FAIL") sawFail = true;
  };

  const { getMeSafe, classifyGetMeError, TelegramApiError } = await import("./lib/setup.ts");
  const config = readConfigSafe(join(HOME, "config.json"));

  // (a) token
  let tokenError: unknown = null;
  let username: string | undefined;
  if (config) {
    try {
      const me = await getMeSafe(config.token);
      username = me.username;
    } catch (e) {
      tokenError = e;
    }
  }
  report(
    "token",
    describeTokenCheck(
      !!config,
      tokenError,
      username,
      classifyGetMeError,
      (e) => e instanceof TelegramApiError,
    ),
  );

  // (b) launchd
  const label = launchd.defaultLabel();
  const plist = launchd.plistPath(label);
  let loaded = false;
  let pid: number | null = null;
  try {
    const out = execFileSync("launchctl", ["print", `gui/${userInfo().uid}/${label}`], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    loaded = true;
    pid = parseLaunchctlPrintPid(out);
  } catch {
    loaded = false;
  }
  report("launchd", describeLaunchdCheck(loaded, pid, existsSync(plist)));

  // (c) agents — bypass the in-process resolveCliPath cache so doctor
  // reflects the filesystem/PATH right now, not a stale startup lookup.
  for (const a of ["claude", "codex", "pi", "gemini"] as const) {
    const p = resolveCliPath(a, { noCache: true });
    let version: string | null = null;
    if (p) {
      try {
        const v = execFileSync(p, ["--version"], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        version = v.split("\n")[0].trim() || "unknown";
      } catch {
        version = null;
      }
    }
    report(a, describeAgentCheck(a, p, version));
  }

  // (d) TLS
  const extraCaCertsPath: string | undefined = config?.launchd?.extraEnv?.NODE_EXTRA_CA_CERTS;
  report("TLS", describeTlsCheck(extraCaCertsPath, extraCaCertsPath ? existsSync(extraCaCertsPath) : false));

  if (sawFail) process.exit(1);
}

function printUsage(): void {
  console.log(`Usage: cliclaw <command>

Commands:
  init               Interactive setup (token, agents, telegram id, launchd)
  start              Run the bot in the foreground
  install-launchd    Install + load macOS LaunchAgent
  uninstall-launchd  Unload + remove macOS LaunchAgent
  upgrade            Pull @latest from npm and reinstall LaunchAgent
  logs [--audit|--err]
                     tail -F a log file (default: bot.log)
  doctor             Live checks: token, launchd, agents, TLS CA
  help               This message

Env:
  CLICLAW_HOME       State directory (default: ~/.cliclaw)
`);
}

// Guarded so this module can be imported (e.g. from tests, for its
// exported pure `describe*` helpers) without running the CLI itself.
if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
  });
}
