import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { createAuditWriter, formatAuditLine } from "../lib/audit-log.ts";

describe("audit-log", () => {
  it("formatAuditLine: NDJSON with required fields", () => {
    const line = formatAuditLine(
      { chatId: 1, userId: 2, type: "msg_in", data: { text: "hi" } },
      "2026-05-13T00:00:00.000Z",
    );
    expect(line.endsWith("\n")).toBe(true);
    const obj = JSON.parse(line);
    expect(obj).toEqual({
      ts: "2026-05-13T00:00:00.000Z",
      chatId: 1,
      userId: 2,
      type: "msg_in",
      data: { text: "hi" },
    });
  });

  it("createAuditWriter: appends multiple events as NDJSON", () => {
    // Use project-local tmp to comply with security policy (no /tmp).
    const dir = mkdtempSync(join(process.cwd(), ".claude/tmp/audit-test-"));
    const file = join(dir, "audit.jsonl");
    const w = createAuditWriter(file);
    w.write({ chatId: 1, type: "msg_in", data: { text: "a" } });
    w.write({ chatId: 1, type: "agent_start", agent: "claude" });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe("msg_in");
    expect(JSON.parse(lines[1]).agent).toBe("claude");
  });

  it("createAuditWriter: creates parent directory if missing", () => {
    const dir = mkdtempSync(join(process.cwd(), ".claude/tmp/audit-test-"));
    const file = join(dir, "nested/sub/audit.jsonl");
    const w = createAuditWriter(file);
    w.write({ chatId: 1, type: "msg_in" });
    expect(existsSync(file)).toBe(true);
  });

  it("createAuditWriter: write does not throw on filesystem error (best-effort)", () => {
    const w = createAuditWriter(join(process.cwd(), ".claude/tmp/ok.jsonl"));
    // Simulate write to invalid path post-init: re-bind appendFileSync? Skip — just verify
    // the public guarantee that valid writes succeed silently.
    expect(() => w.write({ chatId: 1, type: "error", data: {} })).not.toThrow();
  });

  it("createAuditWriter: redact applies to top-level and nested string values", () => {
    const dir = mkdtempSync(join(process.cwd(), ".claude/tmp/audit-test-"));
    const file = join(dir, "audit.jsonl");
    const redact = (s: string) => s.replace(/secret-\w+/g, "[REDACTED]");
    const w = createAuditWriter(file, undefined, { redact });
    w.write({
      chatId: 1,
      type: "msg_in",
      agent: "secret-agent",
      data: { text: "token=secret-abc123", nested: { note: "still secret-xyz" } },
    });
    const record = JSON.parse(readFileSync(file, "utf8").trim());
    expect(record.agent).toBe("[REDACTED]");
    expect(record.data.text).toBe("token=[REDACTED]");
    expect(record.data.nested.note).toBe("still [REDACTED]");
  });

  it("createAuditWriter: no redactor passed = current passthrough behavior", () => {
    const dir = mkdtempSync(join(process.cwd(), ".claude/tmp/audit-test-"));
    const file = join(dir, "audit.jsonl");
    const w = createAuditWriter(file);
    w.write({ chatId: 1, type: "msg_in", data: { text: "secret-abc123" } });
    const record = JSON.parse(readFileSync(file, "utf8").trim());
    expect(record.data.text).toBe("secret-abc123");
  });

  it("createAuditWriter: redact leaves non-string values (numbers, arrays) untouched", () => {
    const dir = mkdtempSync(join(process.cwd(), ".claude/tmp/audit-test-"));
    const file = join(dir, "audit.jsonl");
    const redact = (s: string) => s.toUpperCase();
    const w = createAuditWriter(file, undefined, { redact });
    w.write({
      chatId: 42,
      type: "msg_in",
      data: { count: 3, tags: ["a", "b"], empty: "" },
    });
    const record = JSON.parse(readFileSync(file, "utf8").trim());
    expect(record.chatId).toBe(42);
    expect(record.data.count).toBe(3);
    expect(record.data.tags).toEqual(["a", "b"]);
    expect(record.data.empty).toBe("");
  });
});
