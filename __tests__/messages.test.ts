import { describe, it, expect } from "vitest";
import { getMessages, type Messages } from "../lib/messages.ts";

const HANGUL = /[ㄱ-힝]/;

// Dummy args for every function member of Messages, keyed by member name.
// Shapes match each function's real parameter types so the walk below
// exercises the actual string-building logic, not just placeholder text.
const sampleArgs: Record<string, unknown[]> = {
  unauthorizedWithId: [12345],
  rateLimited: [5],
  attachmentDownloadFailed: ["boom"],
  imageAttachmentNote: ["- /tmp/img.jpg"],
  helpText: [
    {
      active: "claude",
      agentNames: ["claude", "codex"],
      cwd: "/tmp/workspace",
      safetyLabel: "ON",
      streamingLabel: "ON (claude)",
    },
  ],
  agentLabel: ["claude"],
  statusText: [
    {
      activeAgent: "claude",
      rows: [
        {
          agent: "claude",
          hasSession: true,
          mode: "headless",
          timeoutStr: "30m",
          idleStr: "—",
          turnCount: 3,
          sessionIdShort: "abcd1234",
          lastUsedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      inProgress: { agent: "claude", elapsedSec: 5 },
      confirmGatePending: 2,
    },
  ],
  healthText: [
    {
      uptime: "3m",
      rss: "10 MB",
      heap: "5 MB / 10 MB",
      agentNames: ["claude"],
      totalAgents: 4,
      activeChats: 2,
      inFlight: 1,
      logSize: "1 KB",
      auditSize: "2 KB",
      errSize: "0 B",
      safetyLabel: "ON",
      confirmPending: 1,
    },
  ],
  unknownCommand: ["/foo", "help text"],
  switchedAgent: ["codex", 3],
  resetAgentDone: ["claude"],
  autoResetTurns: ["claude", 100],
  stopCancelled: ["claude", 10],
  jobInProgressLock: ["claude", 10],
  jobAlreadyRegistered: ["claude"],
  agentError: ["claude", "boom"],
  agentReply: ["claude", "hi"],
  internalError: ["boom"],
  timeoutError: [30000],
  idleTimeoutError: [30000],
  agentModeLabel: [
    "claude",
    { confirmGateEnabled: true, safetyEnabled: true, codexSandbox: "workspace-write", geminiApprovalMode: "auto_edit" },
  ],
  safetyStatusMessage: ["ON", "detail text"],
  modelShow: ["claude", "claude-sonnet-4"],
  modelSet: ["claude", "claude-sonnet-4"],
  modelCleared: ["claude"],
  planShow: ["ON"],
  confirmMessageText: [{ agent: "claude", patternId: "p1", reason: "danger", command: "rm -rf /", justification: "because" }],
  confirmOutcomeText: ["allow", "reason"],
  confirmReasonForbidden: ["bad"],
  forbiddenCommandNotice: ["p1", "bad", "rm -rf /"],
  commandDescAgent: ["claude"],
};

/** Resolve every member of a Messages instance to a string, invoking
 *  function members with their dummy args. */
function walk(messages: Messages): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value === "function") {
      const args = sampleArgs[key];
      if (!args) throw new Error(`no sample args registered for function member "${key}"`);
      out[key] = (value as (...a: unknown[]) => string)(...args);
    } else {
      out[key] = value as string;
    }
  }
  return out;
}

describe("getMessages", () => {
  it("returns the en table for locale 'en' and the ko table for locale 'ko' with distinct, non-empty strings", () => {
    const en = getMessages("en");
    const ko = getMessages("ko");

    for (const key of ["confirmAllowButton", "confirmDenyButton", "groupChatOnly", "safetyUsage", "unauthorized"] as const) {
      expect(en[key]).toBeTruthy();
      expect(ko[key]).toBeTruthy();
      expect(en[key]).not.toBe(ko[key]);
    }

    expect(en.confirmAllowButton).toBe("✅ Allow");
    expect(en.confirmDenyButton).toBe("❌ Deny");
    expect(ko.confirmAllowButton).toBe("✅ 허용");
    expect(ko.confirmDenyButton).toBe("❌ 거부");
  });

  it("undefined locale resolves to the ko table, and an unknown locale resolves to the en table", () => {
    expect(getMessages(undefined)).toBe(getMessages("ko"));
    expect(getMessages("fr")).toBe(getMessages("en"));
    expect(getMessages("fr")).not.toBe(getMessages("ko"));
  });

  it("every en table member (including function members invoked with real-shaped args) contains no Hangul", () => {
    const en = getMessages("en");
    const resolved = walk(en);

    expect(Object.keys(resolved).length).toBeGreaterThan(30);
    for (const [key, value] of Object.entries(resolved)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
      expect(value, `en.${key} should contain no Hangul but was: ${JSON.stringify(value)}`).not.toMatch(HANGUL);
    }
  });
});
