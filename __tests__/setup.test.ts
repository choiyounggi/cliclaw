import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeAllowedUserIds,
  readExistingAllowedUserIds,
  classifyGetMeError,
  TelegramApiError,
  shouldPrintWaitNote,
  _internals,
} from "../lib/setup.ts";

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length) {
    rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function tmp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `setup-${label}-`));
  cleanupDirs.push(dir);
  return dir;
}

describe("mergeAllowedUserIds", () => {
  it("dedups the captured id into the existing list", () => {
    expect(mergeAllowedUserIds([1, 2], 3)).toEqual([1, 2, 3]);
  });

  it("does not duplicate a captured id already present", () => {
    expect(mergeAllowedUserIds([1, 2], 2)).toEqual([1, 2]);
  });

  it("handles an empty existing list", () => {
    expect(mergeAllowedUserIds([], 5)).toEqual([5]);
  });
});

describe("readExistingAllowedUserIds", () => {
  it("reads allowedUserIds from an existing config.json", () => {
    const home = tmp("existing");
    writeFileSync(join(home, "config.json"), JSON.stringify({ allowedUserIds: [10, 20] }));
    expect(readExistingAllowedUserIds(home)).toEqual([10, 20]);
  });

  it("returns [] for corrupt JSON instead of throwing", () => {
    const home = tmp("corrupt");
    writeFileSync(join(home, "config.json"), "{not json");
    expect(() => readExistingAllowedUserIds(home)).not.toThrow();
    expect(readExistingAllowedUserIds(home)).toEqual([]);
  });

  it("returns [] when config.json is missing", () => {
    const home = tmp("missing");
    expect(readExistingAllowedUserIds(home)).toEqual([]);
  });

  it("returns [] when the allowedUserIds field is absent", () => {
    const home = tmp("no-field");
    writeFileSync(join(home, "config.json"), JSON.stringify({ token: "x" }));
    expect(readExistingAllowedUserIds(home)).toEqual([]);
  });
});

describe("classifyGetMeError", () => {
  it("attributes a Telegram API rejection to the token", () => {
    const msg = classifyGetMeError(new TelegramApiError("Unauthorized"));
    expect(msg).toBe("Bot token rejected by Telegram: Unauthorized");
  });

  it("attributes a network-layer failure to connectivity, never the token", () => {
    const msg = classifyGetMeError(new TypeError("fetch failed"));
    expect(msg).toBe(
      "Network error reaching api.telegram.org: fetch failed. Check connectivity / proxy / corporate TLS.",
    );
    expect(msg).not.toContain("rejected by Telegram");
  });

  it("handles a non-Error throw as a network error", () => {
    const msg = classifyGetMeError("timeout");
    expect(msg).toContain("Network error reaching api.telegram.org: timeout");
  });
});

describe("shouldPrintWaitNote", () => {
  it("prints on the first failure (lastNoteAt=0)", () => {
    expect(shouldPrintWaitNote(0, Date.now(), 30_000)).toBe(true);
  });

  it("suppresses a note within the throttle window", () => {
    const now = 100_000;
    expect(shouldPrintWaitNote(now - 10_000, now, 30_000)).toBe(false);
  });

  it("allows a note once the window has fully elapsed", () => {
    const now = 100_000;
    expect(shouldPrintWaitNote(now - 30_000, now, 30_000)).toBe(true);
  });
});

describe("waitForFirstMessage", () => {
  const { waitForFirstMessage } = _internals;

  it("returns the first non-bot message's user id", async () => {
    let callCount = 0;
    const userId = await waitForFirstMessage("tok", {
      getUpdates: async () => {
        callCount += 1;
        if (callCount === 1) return []; // drain: empty backlog
        return [{ update_id: 1, message: { from: { id: 42, is_bot: false }, chat: { id: 1 } } }];
      },
      deadlineMs: 5000,
      sleepMs: async () => {},
    });
    expect(userId).toBe(42);
  });

  it("retries past a network hiccup instead of throwing", async () => {
    let callCount = 0;
    const sleeps: number[] = [];
    const userId = await waitForFirstMessage("tok", {
      getUpdates: async () => {
        callCount += 1;
        if (callCount === 1) return []; // drain succeeds
        if (callCount === 2) throw new Error("ECONNRESET"); // first poll fails
        return [{ update_id: 1, message: { from: { id: 7, is_bot: false }, chat: { id: 1 } } }];
      },
      deadlineMs: 5000,
      sleepMs: async (ms) => { sleeps.push(ms); },
    });
    expect(userId).toBe(7);
    expect(sleeps).toEqual([3000]);
  });

  it("exits after the deadline instead of letting a raw error escape", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);
    await expect(
      waitForFirstMessage("tok", {
        getUpdates: async () => {
          throw new Error("network down");
        },
        deadlineMs: 50,
        sleepMs: async () => {},
      }),
    ).rejects.toThrow("__exit_1__");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
