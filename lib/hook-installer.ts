/// <reference types="node" />
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Generate a Claude/Codex-compatible hooks.json fragment for the bash-confirm hook. */
export function buildBashConfirmHookEntry(hookCommand: string): {
  matcher: string;
  hooks: { type: "command"; command: string; timeout?: number }[];
} {
  return {
    matcher: "Bash",
    hooks: [
      { type: "command", command: hookCommand, timeout: 600 },
    ],
  };
}

interface HookConfig {
  hooks?: {
    PreToolUse?: { matcher: string; hooks: { type: string; command: string; timeout?: number }[] }[];
    PostToolUse?: unknown[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * Read existing hooks JSON (if any) and merge in the bash-confirm hook for Bash.
 * Idempotent — running twice does not duplicate the entry.
 *
 * @param existingPath  Path to read existing config from. May not exist.
 * @param hookCommand   Absolute command to invoke (e.g. `bun /abs/path/bash-confirm.ts`).
 * @returns merged JSON string ready to write.
 */
export function mergeBashConfirmHook(existingPath: string, hookCommand: string): string {
  let existing: HookConfig = {};
  if (existsSync(existingPath)) {
    try { existing = JSON.parse(readFileSync(existingPath, "utf8")); }
    catch { existing = {}; }
  }
  const cfg: HookConfig = { ...existing };
  cfg.hooks = { ...(cfg.hooks ?? {}) };
  const pre = [...(cfg.hooks.PreToolUse ?? [])];

  // If a Bash matcher already lists our hookCommand, leave it alone.
  const alreadyInstalled = pre.some((entry) =>
    entry.matcher === "Bash" &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => h.command === hookCommand),
  );
  if (alreadyInstalled) {
    return JSON.stringify(cfg, null, 2);
  }

  // If a Bash matcher exists, append our hook to it. Otherwise add a new matcher entry.
  const bashEntry = pre.find((e) => e.matcher === "Bash");
  if (bashEntry) {
    bashEntry.hooks = [
      ...bashEntry.hooks,
      { type: "command", command: hookCommand, timeout: 600 },
    ];
  } else {
    pre.push(buildBashConfirmHookEntry(hookCommand));
  }
  cfg.hooks.PreToolUse = pre;
  return JSON.stringify(cfg, null, 2);
}

/** Write the merged config to disk, creating parent dirs. */
export function installBashConfirmHook(targetPath: string, hookCommand: string): void {
  const merged = mergeBashConfirmHook(targetPath, hookCommand);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, merged);
}
