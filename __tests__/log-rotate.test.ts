import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { rotateIfLarge, truncateIfLarge } from "../lib/log-rotate.ts";

function tmpDir(label: string): string {
  return mkdtempSync(join(process.cwd(), `.claude/tmp/${label}-`));
}

describe("rotateIfLarge", () => {
  it("returns false and leaves the file alone when below threshold", () => {
    const dir = tmpDir("rot-small");
    const f = join(dir, "bot.log");
    writeFileSync(f, "hello\n");
    expect(rotateIfLarge(f, { maxBytes: 1024, keep: 3 })).toBe(false);
    expect(readFileSync(f, "utf8")).toBe("hello\n");
    expect(existsSync(`${f}.1`)).toBe(false);
  });

  it("renames the file to .1 when at threshold", () => {
    const dir = tmpDir("rot-trip");
    const f = join(dir, "bot.log");
    writeFileSync(f, "x".repeat(2048));
    expect(rotateIfLarge(f, { maxBytes: 1024, keep: 3 })).toBe(true);
    expect(existsSync(f)).toBe(false);
    expect(existsSync(`${f}.1`)).toBe(true);
    expect(statSync(`${f}.1`).size).toBe(2048);
  });

  it("shifts existing generations up by one (.1 → .2 → .3)", () => {
    const dir = tmpDir("rot-shift");
    const f = join(dir, "bot.log");
    writeFileSync(`${f}.1`, "gen1");
    writeFileSync(`${f}.2`, "gen2");
    writeFileSync(f, "x".repeat(2048));
    rotateIfLarge(f, { maxBytes: 1024, keep: 3 });
    expect(readFileSync(`${f}.3`, "utf8")).toBe("gen2");
    expect(readFileSync(`${f}.2`, "utf8")).toBe("gen1");
    expect(statSync(`${f}.1`).size).toBe(2048);
  });

  it("evicts the oldest generation past `keep`", () => {
    const dir = tmpDir("rot-evict");
    const f = join(dir, "bot.log");
    writeFileSync(`${f}.1`, "gen1");
    writeFileSync(`${f}.2`, "gen2");
    writeFileSync(`${f}.3`, "gen3-evicted");
    writeFileSync(f, "x".repeat(2048));
    rotateIfLarge(f, { maxBytes: 1024, keep: 3 });
    // .3 was the oldest survivor before rotation; with keep=3 it should
    // be evicted to make room for the new .3 (formerly .2).
    expect(readFileSync(`${f}.3`, "utf8")).toBe("gen2");
    expect(existsSync(`${f}.4`)).toBe(false);
  });

  it("is a no-op when the file does not exist", () => {
    const dir = tmpDir("rot-missing");
    const f = join(dir, "absent.log");
    expect(rotateIfLarge(f, { maxBytes: 1024, keep: 3 })).toBe(false);
    expect(existsSync(`${f}.1`)).toBe(false);
  });
});

describe("truncateIfLarge", () => {
  it("returns false and leaves the file alone when below threshold", () => {
    const dir = tmpDir("trunc-small");
    const f = join(dir, "bot.err");
    writeFileSync(f, "hi\n");
    expect(truncateIfLarge(f, 1024)).toBe(false);
    expect(readFileSync(f, "utf8")).toBe("hi\n");
  });

  it("truncates in place when at threshold (preserves inode/handle)", () => {
    const dir = tmpDir("trunc-big");
    const f = join(dir, "bot.err");
    writeFileSync(f, "x".repeat(2048));
    const before = statSync(f).ino;
    expect(truncateIfLarge(f, 1024)).toBe(true);
    expect(statSync(f).size).toBe(0);
    // Same inode — launchd's open FD remains valid.
    expect(statSync(f).ino).toBe(before);
  });

  it("is a no-op when the file does not exist", () => {
    const dir = tmpDir("trunc-missing");
    const f = join(dir, "absent.err");
    expect(truncateIfLarge(f, 1024)).toBe(false);
    expect(existsSync(f)).toBe(false);
  });
});
