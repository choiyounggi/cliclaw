import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mergeBashConfirmHook, installBashConfirmHook } from "../lib/hook-installer.ts";

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
