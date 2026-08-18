import { describe, it, expect } from "vitest";
import {
  parseLaunchctlPrintPid,
  describeTokenCheck,
  describeLaunchdCheck,
  describeAgentCheck,
  describeTlsCheck,
} from "../cli.ts";

describe("parseLaunchctlPrintPid", () => {
  it("extracts the pid from a loaded service's print output", () => {
    const out = `com.me.cliclaw = {
\tactive count = 1
\tpath = /Users/me/Library/LaunchAgents/com.me.cliclaw.plist
\ttype = LaunchAgent
\tstate = running

\tpid = 12345
\tlast exit code = 0
}`;
    expect(parseLaunchctlPrintPid(out)).toBe(12345);
  });

  it("returns null when the output has no pid line (not loaded)", () => {
    const out = 'Could not find service "com.me.cliclaw" in domain for user gui: 501';
    expect(parseLaunchctlPrintPid(out)).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(parseLaunchctlPrintPid("")).toBeNull();
  });
});

describe("describeTokenCheck", () => {
  const classify = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const isRejection = (e: unknown) => e instanceof RangeError;

  it("reports ok with the verified username when there is no error", () => {
    const r = describeTokenCheck(true, null, "mybot", classify, isRejection);
    expect(r).toEqual({ level: "ok", message: "verified (@mybot)" });
  });

  it("reports FAIL with a BotFather hint for a token-rejection error", () => {
    const r = describeTokenCheck(true, new RangeError("Unauthorized"), undefined, classify, isRejection);
    expect(r.level).toBe("FAIL");
    expect(r.message).toContain("Unauthorized");
    expect(r.message).toContain("BotFather");
  });

  it("reports FAIL without the BotFather hint for a non-rejection (network) error", () => {
    const r = describeTokenCheck(true, new TypeError("fetch failed"), undefined, classify, isRejection);
    expect(r.level).toBe("FAIL");
    expect(r.message).not.toContain("BotFather");
  });

  it("skips cleanly (warn, not FAIL) when there is no config.json", () => {
    const r = describeTokenCheck(false, null, undefined, classify, isRejection);
    expect(r.level).toBe("warn");
    expect(r.message).toContain("cliclaw init");
  });
});

describe("describeLaunchdCheck", () => {
  it("reports ok with the pid when loaded", () => {
    expect(describeLaunchdCheck(true, 42, true)).toEqual({ level: "ok", message: "loaded (pid=42)" });
  });

  it("reports warn when a plist exists on disk but isn't loaded", () => {
    const r = describeLaunchdCheck(false, null, true);
    expect(r.level).toBe("warn");
    expect(r.message).toContain("install-launchd");
  });

  it("reports ok (not a failure) when launchd was never installed at all", () => {
    const r = describeLaunchdCheck(false, null, false);
    expect(r.level).toBe("ok");
  });
});

describe("describeAgentCheck", () => {
  it("reports ok with the version and path when executable", () => {
    expect(describeAgentCheck("claude", "/usr/local/bin/claude", "1.2.3")).toEqual({
      level: "ok",
      message: "1.2.3 @ /usr/local/bin/claude",
    });
  });

  it("reports FAIL when the resolved path fails to execute", () => {
    const r = describeAgentCheck("claude", "/usr/local/bin/claude", null);
    expect(r.level).toBe("FAIL");
    expect(r.message).toContain("not executable");
  });

  it("reports warn (not FAIL) when the agent isn't installed at all", () => {
    const r = describeAgentCheck("codex", null, null);
    expect(r.level).toBe("warn");
    expect(r.message).toContain("not found");
  });
});

describe("describeTlsCheck", () => {
  it("reports ok with the cert path when configured and present", () => {
    expect(describeTlsCheck("/etc/ssl/corp.pem", true)).toEqual({
      level: "ok",
      message: "CA cert found at /etc/ssl/corp.pem",
    });
  });

  it("reports FAIL with a re-init hint when configured but the file is missing", () => {
    const r = describeTlsCheck("/etc/ssl/corp.pem", false);
    expect(r.level).toBe("FAIL");
    expect(r.message).toContain("/etc/ssl/corp.pem");
    expect(r.message).toContain("cliclaw init");
  });

  it("reports ok (not a failure) when no CA is configured", () => {
    const r = describeTlsCheck(undefined, false);
    expect(r.level).toBe("ok");
  });
});
