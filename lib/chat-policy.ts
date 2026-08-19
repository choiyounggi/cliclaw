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

export type ModelCommand =
  | { kind: "show" }
  | { kind: "set"; model: string }
  | { kind: "clear" };

/**
 * Parse a `/model` command (input already confirmed to start with "/model").
 * No argument -> show the active agent's effective model. `default` (any
 * case) -> clear the override. Anything else is taken verbatim as the model
 * name to set — deliberately unvalidated: model names change too fast to
 * pin to a list the repo doesn't own, so a bad name surfaces naturally when
 * the underlying CLI errors on its next run.
 */
export function parseModelCommand(text: string): ModelCommand {
  const rest = text.slice("/model".length).trim();
  if (rest === "") return { kind: "show" };
  if (rest.toLowerCase() === "default") return { kind: "clear" };
  return { kind: "set", model: rest };
}

/**
 * Parse a `/plan` command (input already confirmed to start with "/plan").
 * No argument -> show current state. "on"/"off" (any case) -> toggle.
 * Anything else -> null (caller replies with usage).
 */
export function parsePlanCommand(text: string): "show" | "on" | "off" | null {
  const rest = text.slice("/plan".length).trim().toLowerCase();
  if (rest === "") return "show";
  if (rest === "on") return "on";
  if (rest === "off") return "off";
  return null;
}

/**
 * True iff `text` is a `//`-prefixed native slash-command passthrough with
 * a non-empty remainder. `//` alone (nothing after the two slashes) is NOT
 * a passthrough — it falls through to the normal unknown-command path.
 */
export function isPassthrough(text: string): boolean {
  return text.startsWith("//") && text.slice(2).trim().length > 0;
}

/** Strip exactly one leading slash from a passthrough message, so `//compact`
 *  becomes the verbatim prompt `/compact` sent to the active agent. */
export function passthroughPrompt(text: string): string {
  return text.slice(1);
}
