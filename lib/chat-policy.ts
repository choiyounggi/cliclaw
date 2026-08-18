/**
 * Small pure decision helpers pulled out of bot.ts so they're testable
 * without booting the daemon (bot.ts is a top-level-side-effecting script —
 * importing it directly would read config.json, hit the filesystem, and
 * potentially exit the process).
 */

/** True when `chatType` (a Telegram Chat.type) is anything other than a
 *  1:1 DM. cliclaw only supports private chats — group/supergroup/channel
 *  messages must be rejected before allowlist checks, rate limiting, or
 *  agent dispatch. */
export function isNonPrivateChat(chatType: string): boolean {
  return chatType !== "private";
}

/**
 * Marker for a config-class fatal boot error: missing/unparsable
 * config.json, missing token, or zero usable agent CLIs. These should
 * trigger bot.ts's dormant 60s retry loop rather than `process.exit(1)`,
 * so launchd never sees an exit and never crash-loops an unconfigured
 * install. Anything else thrown during boot is a genuine, unexpected crash
 * and should propagate so launchd restarts the process (throttled to 60s).
 */
export class ConfigFatalError extends Error {}

/** True iff `err` is a config-class fatal boot error (see ConfigFatalError). */
export function isConfigFatalError(err: unknown): boolean {
  return err instanceof ConfigFatalError;
}
