/// <reference types="node" />
/**
 * Resolve a CLI binary path across heterogeneous local environments.
 *
 * Ported from dev-rsquare/pr-ai-reviewer's `src-tauri/src/commands.rs`:
 * `resolve_cli_path`. The Rust original handles the same macOS GUI-app
 * problem we have here under launchd — a child process inherits a minimal
 * PATH that often misses npm/brew/nvm shims.
 *
 * Resolution order (first hit wins):
 *   1. Well-known absolute paths per CLI (`~/.local/bin`, Homebrew, etc.).
 *   2. nvm directory scan — newest node version's `bin/<cmd>`.
 *   3. Login-shell fallback — `/bin/zsh -l -i -c 'command -v <cmd>'`,
 *      isolated by a sentinel prefix so `.zshrc` banner output cannot
 *      contaminate the parsed result.
 *
 * Result is cached for the process lifetime. PATH from a login shell
 * rarely changes while the bot is running, and a cold lookup pays for a
 * shell spawn we should not repeat.
 */

import { existsSync, statSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const LOGIN_SHELL_TIMEOUT_MS = 3000;
const WHICH_SENTINEL = "__WHICH__=";

export type SupportedCli = "claude" | "codex" | "pi" | "gemini";

/** Per-process cache so repeated lookups (startup + reload) stay cheap. */
const resolveCache = new Map<string, string>();

/** True iff `p` is a regular file with at least one executable bit set. */
export function isExecutableFile(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    // POSIX execute bits: owner/group/other. Windows always reports 0 here,
    // but Bun on macOS — our only target — behaves as expected.
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function wellKnownCandidates(cmd: SupportedCli): string[] {
  const home = homedir();
  // Order matters: user-local installs (~/.local/bin) precede system-wide
  // ones so a user who pinned a specific version via npm/pip wins over an
  // older brew bottle. Mirrors pr-ai-reviewer's ordering.
  switch (cmd) {
    case "claude":
      return [
        join(home, ".local/bin/claude"),
        join(home, ".claude/local/claude"),
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
      ];
    case "codex":
      return [
        join(home, ".local/bin/codex"),
        "/usr/local/bin/codex",
        "/opt/homebrew/bin/codex",
      ];
    case "pi":
      return [
        join(home, ".local/bin/pi"),
        "/usr/local/bin/pi",
        "/opt/homebrew/bin/pi",
      ];
    case "gemini":
      return [
        join(home, ".local/bin/gemini"),
        "/usr/local/bin/gemini",
        "/opt/homebrew/bin/gemini",
      ];
  }
}

/** Parse `v22.10.0` → `[22, 10, 0]`. Returns null on malformed input so
 *  callers can skip directories like `system` or `lts/*`. */
export function parseNodeVersion(name: string): [number, number, number] | null {
  const m = name.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersion(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Pick the newest nvm-managed node version that has `<cmd>` under its
 *  `bin/` directory. */
export function pickNvmCandidate(nvmDir: string, cmd: string): string | null {
  const versionsDir = join(nvmDir, "versions", "node");
  let entries: Dirent[];
  try {
    entries = readdirSync(versionsDir, { withFileTypes: true }) as Dirent[];
  } catch {
    return null;
  }
  const found: { version: [number, number, number]; path: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const v = parseNodeVersion(entry.name);
    if (!v) continue;
    const candidate = join(versionsDir, entry.name, "bin", cmd);
    if (isExecutableFile(candidate)) found.push({ version: v, path: candidate });
  }
  if (found.length === 0) return null;
  found.sort((a, b) => compareVersion(a.version, b.version));
  return found[found.length - 1].path;
}

/** Resolve `$NVM_DIR`, falling back to `$HOME/.nvm`. A non-absolute
 *  `NVM_DIR` is rejected — relative paths in env vars are nearly always
 *  unintended and would resolve against the bot's cwd. */
export function resolveNvmDir(
  nvmEnv: string | undefined,
  homeEnv: string | undefined,
): string | null {
  if (nvmEnv && nvmEnv.startsWith("/")) return nvmEnv;
  if (homeEnv) return join(homeEnv, ".nvm");
  return null;
}

/** Ask an interactive login shell where `cmd` lives. Sentinel-prefixed so
 *  `.zshrc` banner output (figlet, motd, etc.) is filtered out. Wrapped
 *  in execFileSync's `timeout` so a hung shell can't stall startup. */
export function loginShellWhich(
  cmd: string,
  timeoutMs: number = LOGIN_SHELL_TIMEOUT_MS,
): string | null {
  // Built via concatenation to keep the TS tokenizer out of the nested
  // shell quoting. $1 is the command name, passed positionally so a CLI
  // name containing shell metacharacters could never reach the parser.
  const script =
    "v=$(command -v -- \"$1\"); printf '" + WHICH_SENTINEL + "%s\\n' \"$v\"";
  try {
    const stdout = execFileSync(
      "/bin/zsh",
      ["-l", "-i", "-c", script, "zsh", cmd],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    for (const line of stdout.split("\n")) {
      if (!line.startsWith(WHICH_SENTINEL)) continue;
      const value = line.slice(WHICH_SENTINEL.length).trim();
      if (value && isExecutableFile(value)) return value;
    }
  } catch {
    // SIGTERM from timeout, non-zero exit, or shell not found — all map to "no result".
  }
  return null;
}

export interface ResolveOptions {
  /** Skip the in-process cache (testing only). */
  noCache?: boolean;
  /** Override env vars (testing only). */
  env?: NodeJS.ProcessEnv;
  /** Override the login-shell fallback (testing only). */
  loginShell?: (cmd: string) => string | null;
  /** Override the well-known candidate list (testing only). When provided,
   *  the host's real system binaries are not consulted. */
  wellKnown?: (cmd: SupportedCli) => string[];
}

export function resolveCliPath(
  cmd: SupportedCli,
  opts: ResolveOptions = {},
): string | null {
  if (!opts.noCache) {
    const hit = resolveCache.get(cmd);
    if (hit) return hit;
  }
  const env = opts.env ?? process.env;

  const wellKnown = (opts.wellKnown ?? wellKnownCandidates)(cmd);
  for (const candidate of wellKnown) {
    if (isExecutableFile(candidate)) {
      if (!opts.noCache) resolveCache.set(cmd, candidate);
      return candidate;
    }
  }

  const nvmDir = resolveNvmDir(env.NVM_DIR, env.HOME);
  if (nvmDir && existsSync(nvmDir)) {
    const nvmHit = pickNvmCandidate(nvmDir, cmd);
    if (nvmHit) {
      if (!opts.noCache) resolveCache.set(cmd, nvmHit);
      return nvmHit;
    }
  }

  const shellHit = (opts.loginShell ?? loginShellWhich)(cmd);
  if (shellHit) {
    if (!opts.noCache) resolveCache.set(cmd, shellHit);
    return shellHit;
  }

  return null;
}

/** Clear the resolution cache. Tests use this; production has no reason
 *  to call it — the underlying filesystem rarely changes mid-run. */
export function clearResolveCache(): void {
  resolveCache.clear();
}
