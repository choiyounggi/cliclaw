/// <reference types="node" />
/**
 * Tiny size-based log rotator with `keep` generations.
 *
 * Why not logrotate(8)?  Because the bot is shipped as a single-binary
 * npm package and we can't assume the user has system tools wired up.
 * Bun's stdlib gives us everything we need: stat, rename, unlink.
 *
 * The rotator is deliberately stat-on-every-call rather than caching a
 * size estimate — file growth is usually slow compared to a fs.statSync
 * (~µs on macOS), and the alternative (every-N-writes counter) loses
 * accuracy if multiple processes share the file.
 */

import { statSync, renameSync, unlinkSync, existsSync, truncateSync } from "node:fs";

export interface RotateOptions {
  /** Trigger rotation when the file reaches this size in bytes. */
  maxBytes: number;
  /** How many `<file>.1 ... <file>.N` rotated copies to keep on disk. */
  keep: number;
}

/**
 * If `file` exceeds `maxBytes`, rotate it: `file` → `file.1`, the old
 * `file.1` → `file.2`, etc., evicting anything past `file.keep`.
 * No-op when the file is missing or under the threshold.
 */
export function rotateIfLarge(file: string, opts: RotateOptions): boolean {
  let size: number;
  try { size = statSync(file).size; }
  catch { return false; }
  if (size < opts.maxBytes) return false;

  // Drop the oldest generation, then shift every other one up by 1.
  // Done from the end so we never clobber a file we still need.
  const oldest = `${file}.${opts.keep}`;
  if (existsSync(oldest)) {
    try { unlinkSync(oldest); } catch { /* ignore — best effort */ }
  }
  for (let i = opts.keep - 1; i >= 1; i--) {
    const src = `${file}.${i}`;
    const dst = `${file}.${i + 1}`;
    if (existsSync(src)) {
      try { renameSync(src, dst); } catch { /* ignore */ }
    }
  }
  try { renameSync(file, `${file}.1`); }
  catch { return false; }
  return true;
}

/**
 * Trim `file` to zero length if it exceeds `maxBytes`. Used for
 * launchd's `bot.err`, where rotation would orphan the open file
 * descriptor — truncate keeps launchd's handle valid and just resets
 * the contents.
 */
export function truncateIfLarge(file: string, maxBytes: number): boolean {
  let size: number;
  try { size = statSync(file).size; }
  catch { return false; }
  if (size < maxBytes) return false;
  try { truncateSync(file, 0); return true; }
  catch { return false; }
}
