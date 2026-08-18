import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { acquireInstanceLock, releaseInstanceLock } from "../lib/instance-lock.ts";

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length) {
    rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
  }
});

function tmp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `instance-lock-${label}-`));
  cleanupDirs.push(dir);
  return dir;
}

/** Spawn and wait for exit synchronously, returning a PID that is
 *  guaranteed to no longer be running by the time this returns. */
function deadPid(): number {
  const r = spawnSync("true", []);
  return r.pid!;
}

describe("acquireInstanceLock", () => {
  it("acquires a fresh lock and writes our own pid", () => {
    const home = tmp("fresh");
    const result = acquireInstanceLock(home);
    expect(result).toEqual({ acquired: true });
    expect(readFileSync(join(home, "bot.pid"), "utf8")).toBe(String(process.pid));
  });

  it("reclaims a stale lock left behind by a dead process", () => {
    const home = tmp("stale");
    writeFileSync(join(home, "bot.pid"), String(deadPid()));
    const result = acquireInstanceLock(home);
    expect(result).toEqual({ acquired: true });
    expect(readFileSync(join(home, "bot.pid"), "utf8")).toBe(String(process.pid));
  });

  it("refuses to acquire while a live process holds the lock", async () => {
    const home = tmp("live");
    const child = spawn("sleep", ["5"]);
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    writeFileSync(join(home, "bot.pid"), String(child.pid));
    try {
      const result = acquireInstanceLock(home);
      expect(result).toEqual({ acquired: false, holderPid: child.pid });
    } finally {
      child.kill();
    }
  });

  it("treats a corrupt lock file as held (fail-safe, never double-acquire)", () => {
    const home = tmp("corrupt");
    writeFileSync(join(home, "bot.pid"), "not-a-pid");
    const result = acquireInstanceLock(home);
    expect(result).toEqual({ acquired: false, holderPid: -1 });
  });
});

describe("releaseInstanceLock", () => {
  it("removes the lock file when we hold it", () => {
    const home = tmp("release-own");
    acquireInstanceLock(home);
    releaseInstanceLock(home);
    expect(existsSync(join(home, "bot.pid"))).toBe(false);
  });

  it("does not remove a lock file held by a different pid", () => {
    const home = tmp("release-other");
    writeFileSync(join(home, "bot.pid"), String(deadPid()));
    releaseInstanceLock(home);
    expect(existsSync(join(home, "bot.pid"))).toBe(true);
  });

  it("is a no-op when no lock file exists", () => {
    const home = tmp("release-missing");
    expect(() => releaseInstanceLock(home)).not.toThrow();
  });
});
