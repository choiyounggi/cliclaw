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
  permissions?: {
    allow?: string[];
    ask?: string[];
    deny?: string[];
    defaultMode?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * Patterns Claude should refuse to read while safety mode is ON. These
 * cover the common credential / secret material a curious agent might
 * sweep up while doing innocent-looking work. The list is intentionally
 * broader than the user's existing global ~/.claude/settings.json so a
 * fresh workspace install gets sane defaults even if the user never
 * customized that file.
 */
export const SAFETY_DENY_PATTERNS: readonly string[] = [
  "Read(~/.ssh/**)",
  "Read(~/.aws/**)",
  "Read(~/.gnupg/**)",
  "Read(~/.netrc)",
  "Read(~/.npmrc)",
  "Read(./**/.env)",
  "Read(./**/.env.*)",
  "Read(./**/*.pem)",
  "Read(./**/*_rsa)",
  "Read(./**/*_dsa)",
  "Read(./**/*_ed25519)",
  "Read(./**/id_rsa*)",
  "Read(./**/id_ed25519*)",
  "Read(./secrets/**)",
];

/** A tag we embed in the workspace settings so we can remove only the
 *  patterns we put there without disturbing anything the user added. */
const SAFETY_MARKER_KEY = "__cliclaw_safety_managed__";

/** Render the merged config that ADDS our safety deny patterns. Idempotent. */
export function mergeSafetyDeny(existingPath: string): string {
  const existing = readJsonSafe(existingPath);
  const cfg: HookConfig = { ...existing };
  const perms = { ...(cfg.permissions ?? {}) };
  const deny = new Set<string>(Array.isArray(perms.deny) ? perms.deny : []);
  for (const p of SAFETY_DENY_PATTERNS) deny.add(p);
  perms.deny = Array.from(deny);
  // Mark which patterns are ours so a later removeSafetyDeny() leaves the
  // user's hand-added deny rules in place.
  (perms as Record<string, unknown>)[SAFETY_MARKER_KEY] = [...SAFETY_DENY_PATTERNS];
  cfg.permissions = perms;
  return JSON.stringify(cfg, null, 2);
}

/** Render the merged config that REMOVES only our marked safety deny
 *  patterns. Anything the user added by hand stays untouched. */
export function mergeSafetyDenyRemoval(existingPath: string): string {
  const existing = readJsonSafe(existingPath);
  const cfg: HookConfig = { ...existing };
  if (!cfg.permissions) return JSON.stringify(cfg, null, 2);
  const perms = { ...cfg.permissions };
  const managed = Array.isArray((perms as Record<string, unknown>)[SAFETY_MARKER_KEY])
    ? ((perms as Record<string, unknown>)[SAFETY_MARKER_KEY] as string[])
    : (SAFETY_DENY_PATTERNS as readonly string[]);
  const managedSet = new Set(managed);
  perms.deny = Array.isArray(perms.deny) ? perms.deny.filter((p) => !managedSet.has(p)) : [];
  if (perms.deny.length === 0) delete perms.deny;
  delete (perms as Record<string, unknown>)[SAFETY_MARKER_KEY];
  cfg.permissions = perms;
  // If `permissions` became an empty object, drop it entirely so the
  // resulting settings.json doesn't carry useless scaffolding.
  if (Object.keys(perms).length === 0) delete cfg.permissions;
  return JSON.stringify(cfg, null, 2);
}

export function installSafetyDeny(targetPath: string): void {
  const merged = mergeSafetyDeny(targetPath);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, merged);
}

export function uninstallSafetyDeny(targetPath: string): void {
  if (!existsSync(targetPath)) return;
  const merged = mergeSafetyDenyRemoval(targetPath);
  writeFileSync(targetPath, merged);
}

/**
 * Read + parse + validate a hook config JSON. On malformed JSON the
 * raw file is backed up to `<path>.corrupt-<timestamp>` and an empty
 * config is returned, so we never silently overwrite a manually-edited
 * settings.json that the user might still be debugging.
 *
 * Validation rejects shapes that would crash the merge step (e.g. a
 * `hooks` field that's a string or an array). Anything that passes is
 * structurally a HookConfig — fields we don't recognize pass through.
 */
function readJsonSafe(path: string): HookConfig {
  if (!existsSync(path)) return {};
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch { return {}; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch {
    // Corrupt JSON: preserve the original under a timestamped suffix
    // so the user can inspect/recover, then start from a clean slate.
    try { writeFileSync(`${path}.corrupt-${Date.now()}`, raw); }
    catch { /* best effort */ }
    return {};
  }
  if (!validateHookConfig(parsed)) return {};
  return parsed as HookConfig;
}

/** Structural validation of a hook config object. Tolerates unknown
 *  top-level keys (we re-serialize them on write) but rejects shapes
 *  that would crash the merge code. */
export function validateHookConfig(obj: unknown): obj is HookConfig {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return false;
  const c = obj as Record<string, unknown>;
  if (c.hooks !== undefined) {
    if (typeof c.hooks !== "object" || c.hooks === null || Array.isArray(c.hooks)) return false;
    const h = c.hooks as Record<string, unknown>;
    if (h.PreToolUse !== undefined) {
      if (!Array.isArray(h.PreToolUse)) return false;
      for (const entry of h.PreToolUse) {
        if (!entry || typeof entry !== "object") return false;
        const e = entry as Record<string, unknown>;
        if (typeof e.matcher !== "string") return false;
        if (!Array.isArray(e.hooks)) return false;
        for (const hk of e.hooks) {
          if (!hk || typeof hk !== "object") return false;
          const hki = hk as Record<string, unknown>;
          if (hki.type !== "command") return false;
          if (typeof hki.command !== "string") return false;
          if (hki.timeout !== undefined && typeof hki.timeout !== "number") return false;
        }
      }
    }
  }
  if (c.permissions !== undefined) {
    if (typeof c.permissions !== "object" || c.permissions === null || Array.isArray(c.permissions)) return false;
    const p = c.permissions as Record<string, unknown>;
    for (const k of ["allow", "ask", "deny"] as const) {
      if (p[k] !== undefined && !Array.isArray(p[k])) return false;
    }
  }
  return true;
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
  // Route through the validated reader so a malformed settings.json
  // gets backed up rather than silently obliterated.
  const existing = readJsonSafe(existingPath);
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
