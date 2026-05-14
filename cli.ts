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
 *   doctor              — print agent paths, config path, plist status
 *   help                — usage
 */

import { resolve, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
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
      cmdDoctor();
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

function cmdDoctor(): void {
  console.log(`cliclaw doctor`);
  console.log(`  ROOT (source):    ${ROOT}`);
  console.log(`  HOME (state):     ${HOME}`);
  console.log(`  bot.ts:           ${ENTRY_TS}`);
  console.log(`  bun:              ${BUN_PATH}`);
  console.log(`  config.json:      ${existsSync(join(HOME, "config.json")) ? "OK" : "missing"}`);
  console.log(`  agents:`);
  for (const a of ["claude", "codex", "pi", "gemini"] as const) {
    const p = resolveCliPath(a);
    console.log(`    ${a.padEnd(7)} ${p ?? "not found"}`);
  }
  const plist = launchd.plistPath();
  console.log(`  launchd plist:    ${existsSync(plist) ? plist : "not installed"}`);
}

function printUsage(): void {
  console.log(`Usage: cliclaw <command>

Commands:
  init               Interactive setup (token, agents, telegram id, launchd)
  start              Run the bot in the foreground
  install-launchd    Install + load macOS LaunchAgent
  uninstall-launchd  Unload + remove macOS LaunchAgent
  doctor             Print resolved paths and agent availability
  help               This message

Env:
  CLICLAW_HOME       State directory (default: ~/.cliclaw)
`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
