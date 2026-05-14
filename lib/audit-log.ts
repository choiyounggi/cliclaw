import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { rotateIfLarge, type RotateOptions } from "./log-rotate.ts";

export type AuditEventType =
  | "msg_in"
  | "cmd"
  | "agent_start"
  | "tool_use"
  | "agent_exit"
  | "msg_out"
  | "stop"
  | "lock_reject"
  | "confirm_ask"
  | "confirm_decision"
  | "error";

export interface AuditEvent {
  ts: string;
  chatId: number;
  userId?: number;
  type: AuditEventType;
  agent?: string;
  data?: Record<string, unknown>;
}

export interface AuditWriter {
  write(event: Omit<AuditEvent, "ts">): void;
}

export function createAuditWriter(
  filePath: string,
  rotate?: RotateOptions,
): AuditWriter {
  mkdirSync(dirname(filePath), { recursive: true });
  return {
    write(event) {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
      // Size-check before append. NDJSON traffic from a chatty bot can
      // accumulate fast, so without rotation the file grows unbounded.
      if (rotate) rotateIfLarge(filePath, rotate);
      try { appendFileSync(filePath, line); } catch { /* swallow — never break the bot */ }
    },
  };
}

// Exposed for tests: serialize without writing.
export function formatAuditLine(event: Omit<AuditEvent, "ts">, ts = new Date().toISOString()): string {
  return JSON.stringify({ ts, ...event }) + "\n";
}
