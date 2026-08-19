import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  utimesSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { sweepStaleSessionDirs } from "../lib/session-sweep.ts";

function tmpDir(label: string): string {
  return mkdtempSync(join(process.cwd(), `.claude/tmp/${label}-`));
}

const DAY = 24 * 60 * 60 * 1000;

function makeChatDir(root: string, agent: string, chatId: string, fileMtimeMs: number): string {
  const dir = join(root, agent, chatId);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "session.json");
  writeFileSync(f, "{}");
  const t = fileMtimeMs / 1000;
  utimesSync(f, t, t);
  return dir;
}

describe("sweepStaleSessionDirs", () => {
  it("removes <agent>/<chatId> dirs whose newest file is older than retentionDays, keeps fresh ones", () => {
    const root = tmpDir("sweep-normal");
    const now = Date.now();
    const oldDir = makeChatDir(root, "claude", "111", now - 40 * DAY);
    const freshDir = makeChatDir(root, "claude", "222", now - 1 * DAY);

    const removed = sweepStaleSessionDirs(root, 30, now);

    expect(removed).toEqual([oldDir]);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
  });

  it("retentionDays <= 0 disables the sweep (no-op, even for very old dirs)", () => {
    const root = tmpDir("sweep-disabled");
    const now = Date.now();
    const oldDir = makeChatDir(root, "claude", "111", now - 400 * DAY);

    expect(sweepStaleSessionDirs(root, 0, now)).toEqual([]);
    expect(existsSync(oldDir)).toBe(true);

    expect(sweepStaleSessionDirs(root, -5, now)).toEqual([]);
    expect(existsSync(oldDir)).toBe(true);
  });

  it("returns [] for an empty root and for a root that does not exist", () => {
    const root = tmpDir("sweep-empty");
    expect(sweepStaleSessionDirs(root, 30)).toEqual([]);
    expect(sweepStaleSessionDirs(join(root, "does-not-exist"), 30)).toEqual([]);
  });

  it("skips an unreadable chat dir without throwing, and still sweeps the rest", () => {
    const root = tmpDir("sweep-unreadable");
    const now = Date.now();
    const blockedDir = makeChatDir(root, "claude", "111", now - 40 * DAY);
    const goodDir = makeChatDir(root, "claude", "222", now - 40 * DAY);

    chmodSync(blockedDir, 0o000);
    try {
      let removed: string[] = [];
      expect(() => {
        removed = sweepStaleSessionDirs(root, 30, now);
      }).not.toThrow();
      expect(removed).toContain(goodDir);
      expect(removed).not.toContain(blockedDir);
      expect(existsSync(blockedDir)).toBe(true);
    } finally {
      chmodSync(blockedDir, 0o755);
    }
  });
});
