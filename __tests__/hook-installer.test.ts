import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  mergeBashConfirmHook,
  installBashConfirmHook,
  mergeSafetyDeny,
  mergeSafetyDenyRemoval,
  installSafetyDeny,
  uninstallSafetyDeny,
  SAFETY_DENY_PATTERNS,
} from "../lib/hook-installer.ts";

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(process.cwd(), ".claude/tmp/hook-inst-"));
  return join(dir, name);
}

describe("mergeBashConfirmHook", () => {
  it("creates a fresh config when target file does not exist", () => {
    const merged = JSON.parse(mergeBashConfirmHook(tmpFile("none.json"), "/abs/hook"));
    expect(merged.hooks.PreToolUse).toHaveLength(1);
    expect(merged.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(merged.hooks.PreToolUse[0].hooks[0]).toEqual({
      type: "command", command: "/abs/hook", timeout: 600,
    });
  });

  it("appends to an existing Bash matcher rather than duplicating it", () => {
    const f = tmpFile("with-bash.json");
    writeFileSync(f, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/bin/preexisting" }] }] },
    }));
    const merged = JSON.parse(mergeBashConfirmHook(f, "/abs/hook"));
    expect(merged.hooks.PreToolUse).toHaveLength(1);
    expect(merged.hooks.PreToolUse[0].hooks).toHaveLength(2);
    expect(merged.hooks.PreToolUse[0].hooks[0].command).toBe("/usr/bin/preexisting");
    expect(merged.hooks.PreToolUse[0].hooks[1].command).toBe("/abs/hook");
  });

  it("preserves non-Bash matchers untouched", () => {
    const f = tmpFile("with-other.json");
    writeFileSync(f, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "/usr/bin/lint" }] }],
        PostToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "/usr/bin/format" }] }],
      },
    }));
    const merged = JSON.parse(mergeBashConfirmHook(f, "/abs/hook"));
    expect(merged.hooks.PreToolUse).toHaveLength(2);
    expect(merged.hooks.PreToolUse.find((e: { matcher: string }) => e.matcher === "Edit")).toBeDefined();
    expect(merged.hooks.PreToolUse.find((e: { matcher: string }) => e.matcher === "Bash")).toBeDefined();
    expect(merged.hooks.PostToolUse).toHaveLength(1);
  });

  it("is idempotent: running twice does not duplicate the hook", () => {
    const f = tmpFile("idem.json");
    writeFileSync(f, mergeBashConfirmHook(f, "/abs/hook"));
    const second = mergeBashConfirmHook(f, "/abs/hook");
    const obj = JSON.parse(second);
    expect(obj.hooks.PreToolUse).toHaveLength(1);
    expect(obj.hooks.PreToolUse[0].hooks).toHaveLength(1);
  });

  it("recovers gracefully from a corrupt existing file (overwrites rather than throwing)", () => {
    const f = tmpFile("corrupt.json");
    writeFileSync(f, "this is not json");
    const merged = JSON.parse(mergeBashConfirmHook(f, "/abs/hook"));
    expect(merged.hooks.PreToolUse[0].matcher).toBe("Bash");
  });
});

describe("installBashConfirmHook", () => {
  it("creates parent dirs and writes the merged config", () => {
    const f = join(process.cwd(), ".claude/tmp/hook-install/nested/hooks.json");
    installBashConfirmHook(f, "/abs/hook");
    expect(existsSync(f)).toBe(true);
    const obj = JSON.parse(readFileSync(f, "utf8"));
    expect(obj.hooks.PreToolUse[0].matcher).toBe("Bash");
  });
});

describe("mergeSafetyDeny", () => {
  it("adds every SAFETY_DENY_PATTERNS entry to permissions.deny", () => {
    const merged = JSON.parse(mergeSafetyDeny(tmpFile("safety-fresh.json")));
    for (const p of SAFETY_DENY_PATTERNS) {
      expect(merged.permissions.deny).toContain(p);
    }
  });

  it("preserves user-added deny rules", () => {
    const f = tmpFile("safety-userdeny.json");
    writeFileSync(f, JSON.stringify({
      permissions: { deny: ["Bash(rm -rf /opt/sacred/**)"] },
    }));
    const merged = JSON.parse(mergeSafetyDeny(f));
    expect(merged.permissions.deny).toContain("Bash(rm -rf /opt/sacred/**)");
    for (const p of SAFETY_DENY_PATTERNS) {
      expect(merged.permissions.deny).toContain(p);
    }
  });

  it("is idempotent — running twice produces the same deny set", () => {
    const f = tmpFile("safety-idem.json");
    const once = JSON.parse(mergeSafetyDeny(f));
    writeFileSync(f, JSON.stringify(once));
    const twice = JSON.parse(mergeSafetyDeny(f));
    expect(twice.permissions.deny.length).toBe(once.permissions.deny.length);
  });

  it("survives a corrupt existing file", () => {
    const f = tmpFile("safety-corrupt.json");
    writeFileSync(f, "{ broken: yes");
    const merged = JSON.parse(mergeSafetyDeny(f));
    expect(merged.permissions.deny.length).toBeGreaterThan(0);
  });
});

describe("mergeSafetyDenyRemoval", () => {
  it("removes only managed patterns, keeps user patterns", () => {
    const f = tmpFile("safety-remove.json");
    // First install our rules on top of a user rule.
    writeFileSync(f, JSON.stringify({
      permissions: { deny: ["Bash(rm -rf /opt/sacred/**)"] },
    }));
    writeFileSync(f, mergeSafetyDeny(f));
    // Now remove.
    const after = JSON.parse(mergeSafetyDenyRemoval(f));
    expect(after.permissions.deny).toContain("Bash(rm -rf /opt/sacred/**)");
    for (const p of SAFETY_DENY_PATTERNS) {
      expect(after.permissions.deny ?? []).not.toContain(p);
    }
  });

  it("drops permissions entirely when nothing user-supplied remains", () => {
    const f = tmpFile("safety-empty-after.json");
    writeFileSync(f, mergeSafetyDeny(f));
    const after = JSON.parse(mergeSafetyDenyRemoval(f));
    expect(after.permissions).toBeUndefined();
  });

  it("is a no-op when settings file doesn't exist", () => {
    const f = join(process.cwd(), ".claude/tmp/safety-remove-nonexistent.json");
    expect(() => uninstallSafetyDeny(f)).not.toThrow();
    expect(existsSync(f)).toBe(false);
  });
});

describe("installSafetyDeny → uninstallSafetyDeny round trip", () => {
  it("creates parent dirs, writes, then leaves user state behind", () => {
    const f = join(process.cwd(), ".claude/tmp/safety-roundtrip/nested/settings.json");
    installSafetyDeny(f);
    expect(existsSync(f)).toBe(true);
    const obj = JSON.parse(readFileSync(f, "utf8"));
    expect(obj.permissions.deny.length).toBeGreaterThan(0);

    uninstallSafetyDeny(f);
    const after = JSON.parse(readFileSync(f, "utf8"));
    expect(after.permissions).toBeUndefined();
  });
});
