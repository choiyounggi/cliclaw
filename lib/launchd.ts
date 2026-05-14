/// <reference types="node" />
/**
 * macOS LaunchAgent helpers.
 *
 * The bot runs out of a global node_modules path (or a checkout), but each
 * user's runtime state lives under CLICLAW_HOME (~/.cliclaw by default).
 * The plist must point at both: the source ENTRY_TS for ProgramArguments
 * and CLICLAW_HOME for state.
 *
 * We accept that the resulting LaunchAgent is user-scoped — there is no
 * supported way to install a system-wide LaunchDaemon without sudo, and a
 * personal Telegram bot has no business running as root.
 */

import { writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, userInfo } from "node:os";
import { execFileSync } from "node:child_process";

export interface LaunchdOptions {
  /** Absolute path to the bot.ts file. */
  entryTs: string;
  /** Absolute path to the bun binary. */
  bunPath: string;
  /** Absolute path to CLICLAW_HOME for this user. */
  cliclawHome: string;
  /** Additional PATH entries to prepend before the default macOS PATH. */
  extraPath?: string[];
  /**
   * Extra environment variables to write into the plist's
   * EnvironmentVariables dict. Typical usage: a corporate TLS interceptor
   * root CA path via NODE_EXTRA_CA_CERTS, so the bot's getMe call to
   * Telegram doesn't trip "unable to get local issuer certificate".
   */
  extraEnv?: Record<string, string>;
}

export function defaultLabel(): string {
  return `com.${userInfo().username}.cliclaw`;
}

export function plistPath(label: string = defaultLabel()): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export function renderPlist(label: string, opts: LaunchdOptions): string {
  const stateDir = opts.cliclawHome;
  // launchd inherits an extremely minimal PATH — prepend brew/nvm-style
  // locations so spawned children (claude / codex / pi) can be found even
  // if the bot's resolveCliPath cache misses for some reason.
  const path = [
    ...(opts.extraPath ?? []),
    dirname(opts.bunPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]
    .filter((p, i, a) => p && a.indexOf(p) === i)
    .join(":");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escape(label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escape(opts.bunPath)}</string>
        <string>run</string>
        <string>${escape(opts.entryTs)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${escape(stateDir)}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escape(path)}</string>
        <key>HOME</key>
        <string>${escape(homedir())}</string>
        <key>CLICLAW_HOME</key>
        <string>${escape(stateDir)}</string>${renderExtraEnv(opts.extraEnv)}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${escape(join(stateDir, "logs", "bot.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${escape(join(stateDir, "logs", "bot.err"))}</string>
</dict>
</plist>
`;
}

/** Render arbitrary user-supplied env vars as plist key/string pairs.
 *  Returns the empty string when no extras are provided so the template
 *  still produces clean plist output. */
function renderExtraEnv(extra: Record<string, string> | undefined): string {
  if (!extra) return "";
  const entries = Object.entries(extra);
  if (entries.length === 0) return "";
  return "\n" + entries
    .map(([k, v]) => `        <key>${escape(k)}</key>\n        <string>${escape(v)}</string>`)
    .join("\n");
}

/** Escape characters that have meaning inside plist XML strings. */
function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface InstallResult {
  label: string;
  path: string;
  loaded: boolean;
  message: string;
}

export function install(opts: LaunchdOptions): InstallResult {
  const label = defaultLabel();
  const path = plistPath(label);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(join(opts.cliclawHome, "logs"), { recursive: true });
  writeFileSync(path, renderPlist(label, opts), { mode: 0o644 });

  // bootout any existing copy so reinstalls pick up new env vars.
  try {
    execFileSync("launchctl", ["bootout", domainTarget(label)], {
      stdio: "ignore",
    });
  } catch {
    // Not loaded yet — fine.
  }
  try {
    execFileSync("launchctl", ["bootstrap", domain(), path], {
      stdio: "ignore",
    });
  } catch (e) {
    return {
      label,
      path,
      loaded: false,
      message: `wrote ${path} but bootstrap failed: ${(e as Error).message}`,
    };
  }
  return {
    label,
    path,
    loaded: true,
    message: `installed and loaded at ${path}`,
  };
}

export function uninstall(label: string = defaultLabel()): InstallResult {
  const path = plistPath(label);
  try {
    execFileSync("launchctl", ["bootout", domainTarget(label)], {
      stdio: "ignore",
    });
  } catch {
    // Already unloaded.
  }
  if (existsSync(path)) {
    unlinkSync(path);
    return { label, path, loaded: false, message: `removed ${path}` };
  }
  return { label, path, loaded: false, message: `no plist at ${path}` };
}

function uid(): number {
  return userInfo().uid;
}

function domain(): string {
  return `gui/${uid()}`;
}

function domainTarget(label: string): string {
  return `${domain()}/${label}`;
}
