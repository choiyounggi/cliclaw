import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, statSync, existsSync } from "fs";
import { join } from "path";
import { writeFileAtomic } from "../lib/atomic-write.ts";

describe("writeFileAtomic", () => {
  it("writes the full content and it's readable at the target path", () => {
    const dir = mkdtempSync(join(process.cwd(), ".claude/tmp/atomic-write-test-"));
    const file = join(dir, "out.txt");
    writeFileAtomic(file, "hello world");
    expect(readFileSync(file, "utf8")).toBe("hello world");
  });

  it("overwrites an existing file atomically with the new content", () => {
    const dir = mkdtempSync(join(process.cwd(), ".claude/tmp/atomic-write-test-"));
    const file = join(dir, "out.txt");
    writeFileAtomic(file, "v1");
    writeFileAtomic(file, "v2");
    expect(readFileSync(file, "utf8")).toBe("v2");
  });

  it("throws when the parent directory doesn't exist (caller must ensure it)", () => {
    const dir = mkdtempSync(join(process.cwd(), ".claude/tmp/atomic-write-test-"));
    const file = join(dir, "missing-subdir", "out.txt");
    expect(() => writeFileAtomic(file, "x")).toThrow();
  });

  it("mode option creates the file with the given permission bits", () => {
    const dir = mkdtempSync(join(process.cwd(), ".claude/tmp/atomic-write-test-"));
    const file = join(dir, "secret.txt");
    writeFileAtomic(file, "s3cr3t", { mode: 0o600 });
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("no mode option leaves default filesystem permissions unchanged", () => {
    const dir = mkdtempSync(join(process.cwd(), ".claude/tmp/atomic-write-test-"));
    const file = join(dir, "plain.txt");
    writeFileAtomic(file, "plain");
    expect(existsSync(file)).toBe(true);
    // No mode passed → must not be forced to a restrictive mode like 0600.
    const mode = statSync(file).mode & 0o777;
    expect(mode).not.toBe(0o600);
  });
});
