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

export interface AuditWriterOptions {
  /** Applied to every string value in a record before it's written (recurses into nested objects). No redactor = write as-is. */
  redact?: (s: string) => string;
}

export function createAuditWriter(
  filePath: string,
  rotate?: RotateOptions,
  opts?: AuditWriterOptions,
): AuditWriter {
  mkdirSync(dirname(filePath), { recursive: true });
  return {
    write(event) {
      let record: Record<string, unknown> = { ts: new Date().toISOString(), ...event };
      if (opts?.redact) record = redactStrings(record, opts.redact) as Record<string, unknown>;
      const line = JSON.stringify(record) + "\n";
      // Size-check before append. NDJSON traffic from a chatty bot can
      // accumulate fast, so without rotation the file grows unbounded.
      if (rotate) rotateIfLarge(filePath, rotate);
      try { appendFileSync(filePath, line); } catch { /* swallow — never break the bot */ }
    },
  };
}

// Walks a record's own enumerable properties, applying `redact` to every
// string value; nested plain objects are handled by recursing into them.
function redactStrings(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactStrings(v, redact);
    }
    return out;
  }
  return value;
}

// Exposed for tests: serialize without writing.
export function formatAuditLine(event: Omit<AuditEvent, "ts">, ts = new Date().toISOString()): string {
  return JSON.stringify({ ts, ...event }) + "\n";
}
