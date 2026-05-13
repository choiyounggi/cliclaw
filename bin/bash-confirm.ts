#!/usr/bin/env bun
/// <reference types="bun" />
/// <reference types="node" />
/**
 * PreToolUse hook for Bash — invoked by claude / codex per command.
 * Behavior:
 *   1. Read JSON tool payload from stdin.
 *   2. If env BOT_CONFIRM_SOCKET / TG_CHAT_ID missing → exit 0 silently
 *      (so the same hook can stay in user-global settings without affecting
 *      normal sessions outside the bot).
 *   3. If command does not match any danger pattern → exit 0 silently.
 *   4. Otherwise connect to the bot's confirm socket, await the user's
 *      decision, and emit the Claude/Codex hook JSON to allow or block.
 */

import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { matchDanger, compileExtraPatterns, DEFAULT_DANGER_PATTERNS } from "../lib/danger-patterns.ts";

const ENV_SOCKET = "BOT_CONFIRM_SOCKET";
const ENV_CHAT = "TG_CHAT_ID";
const ENV_AGENT = "BOT_AGENT";
const ENV_EXTRA_PATTERNS_FILE = "BOT_DANGER_PATTERNS_FILE";

interface HookInput {
  tool_input?: Record<string, unknown>;
  input?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
}

function extractCommand(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as HookInput;
  const candidates = [
    p.tool_input?.command,
    p.tool_input?.cmd,
    p.input?.command,
    p.arguments?.command,
    p.arguments?.cmd,
  ];
  for (const v of candidates) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

function loadExtraPatterns(): ReturnType<typeof compileExtraPatterns>["patterns"] {
  const file = process.env[ENV_EXTRA_PATTERNS_FILE];
  if (!file) return [];
  try {
    const sources = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(sources)) return [];
    return compileExtraPatterns(sources.filter((s): s is string => typeof s === "string")).patterns;
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const socketPath = process.env[ENV_SOCKET];
  const chatIdRaw = process.env[ENV_CHAT];
  const agent = process.env[ENV_AGENT] ?? "unknown";
  if (!socketPath || !chatIdRaw) {
    // Hook installed globally but bot context absent — be a no-op.
    process.exit(0);
  }
  const chatId = Number(chatIdRaw);
  if (!Number.isFinite(chatId)) process.exit(0);

  const stdinText = await Bun.stdin.text();
  let payload: unknown;
  try { payload = JSON.parse(stdinText); }
  catch { process.exit(0); /* not a JSON tool payload — let it pass */ }
  const command = extractCommand(payload);
  if (!command) process.exit(0);

  const patterns = [...DEFAULT_DANGER_PATTERNS, ...loadExtraPatterns()];
  const hit = matchDanger(command, patterns);
  if (!hit) process.exit(0);

  // Connect to bot.
  const decision = await askBot(socketPath, {
    chatId, agent, command, patternId: hit.id, reason: hit.reason,
  });

  if (decision.decision === "allow") {
    process.exit(0);
  }
  // Emit Claude/Codex hook JSON to actively block (more informative than exit 2).
  const reason = `위험명령 확인 게이트: ${decision.reason ?? "거부됨"}`;
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  process.exit(0);
}

interface AskPayload {
  chatId: number;
  agent: string;
  command: string;
  patternId: string;
  reason: string;
}

function askBot(socketPath: string, payload: AskPayload): Promise<{ decision: "allow" | "deny"; reason?: string }> {
  return new Promise((resolve) => {
    let buf = "";
    const sock = connect(socketPath);
    const failClosed = (why: string): void => {
      try { sock.destroy(); } catch { /* */ }
      // Treat any IPC failure as DENY — safer default for an absent operator.
      resolve({ decision: "deny", reason: `봇 통신 실패: ${why}` });
    };
    sock.on("connect", () => {
      sock.write(JSON.stringify(payload) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        try {
          const r = JSON.parse(buf.slice(0, nl));
          resolve(r.decision === "allow" ? { decision: "allow" } : { decision: "deny", reason: r.reason });
        } catch (err) {
          failClosed(`parse: ${err instanceof Error ? err.message : err}`);
        }
        sock.destroy();
      }
    });
    sock.on("error", (err) => failClosed(err.message));
    sock.on("close", () => {
      if (!buf) failClosed("응답 전 연결 종료");
    });
  });
}

await main();
