/// <reference types="node" />
/**
 * Retention sweep for the per-chat session workspace tree at
 * `<root>/<agent>/<chatId>`. Mirrors bot.ts's sweepStaleUploads pattern but
 * operates one directory level deeper and keys staleness off the newest
 * mtime found anywhere under the chat dir (not the dir's own mtime, which
 * doesn't update when only nested files change).
 */

import { readdirSync, statSync, rmSync, type Dirent } from "node:fs";
import { join } from "node:path";

// Recursively find the newest file mtime under `dir`. Unreadable entries are
// skipped (best effort) rather than throwing, so one bad subtree can't stop
// the sweep. Returns 0 if nothing readable was found.
function newestMtimeMs(dir: string): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let newest = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        newest = Math.max(newest, newestMtimeMs(path));
      } else if (entry.isFile()) {
        newest = Math.max(newest, statSync(path).mtimeMs);
      }
    } catch {
      // unreadable entry — skip, best effort
    }
  }
  return newest;
}

/**
 * Remove `<root>/<agent>/<chatId>` directories whose newest file (recursive)
 * is older than `retentionDays`. Returns the removed directory paths.
 * `retentionDays <= 0` disables the sweep entirely (returns []).
 */
export function sweepStaleSessionDirs(root: string, retentionDays: number, now: number = Date.now()): string[] {
  if (retentionDays <= 0) return [];
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];

  let agentDirs: Dirent[];
  try {
    agentDirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const agentDir of agentDirs) {
    if (!agentDir.isDirectory()) continue;
    const agentPath = join(root, agentDir.name);
    let chatDirs: Dirent[];
    try {
      chatDirs = readdirSync(agentPath, { withFileTypes: true });
    } catch {
      continue; // unreadable agent dir — skip, best effort
    }
    for (const chatDir of chatDirs) {
      if (!chatDir.isDirectory()) continue;
      const chatPath = join(agentPath, chatDir.name);
      let newest = newestMtimeMs(chatPath);
      if (newest === 0) {
        // Empty (or entirely unreadable) subtree — fall back to the chat
        // dir's own mtime so an unreadable dir defaults to "keep", not
        // "instantly stale".
        try {
          newest = statSync(chatPath).mtimeMs;
        } catch {
          continue;
        }
      }
      if (newest < cutoff) {
        try {
          rmSync(chatPath, { recursive: true, force: true });
          removed.push(chatPath);
        } catch {
          // best effort — leave it for the next sweep
        }
      }
    }
  }
  return removed;
}
