/// <reference types="node" />
import { writeFileSync, renameSync } from "node:fs";

/**
 * Write a file atomically: write to a temp sibling, then rename over the
 * target. `rename` is atomic on the same filesystem, so a crash / ENOSPC /
 * signal mid-write can never leave the live file truncated — readers see
 * either the old contents or the complete new contents, never a partial one.
 *
 * The temp file is created in the SAME directory as `path` (so the rename
 * stays on one filesystem); the caller is responsible for ensuring that
 * directory exists.
 */
export function writeFileAtomic(path: string, data: string, opts?: { mode?: number }): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  if (opts?.mode !== undefined) writeFileSync(tmp, data, { mode: opts.mode });
  else writeFileSync(tmp, data);
  renameSync(tmp, path);
}
