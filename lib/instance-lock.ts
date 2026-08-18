/// <reference types="node" />
/**
 * Single-instance lock for the bot daemon.
 *
 * Lock file `<home>/bot.pid` holds the holder's PID as decimal text. A fresh
 * acquire creates it exclusively (`wx`); on collision we probe whether the
 * recorded PID is still alive via a signal-0 kill (a pure existence check —
 * no signal is actually delivered). ESRCH ("no such process") is the only
 * outcome that means the holder is gone, so a lock left behind by a crash
 * can be reclaimed; any other outcome (alive, EPERM, or an unreadable/
 * corrupt lock file) is treated as still-held so we never double-acquire.
 *
 * An alive PID isn't proof it's still *our* holder — PIDs get reused, so a
 * crashed bot's PID can end up belonging to an unrelated process by the time
 * we check. Callers may pass `validateHolder` to confirm the live PID is
 * actually still a cliclaw instance; a live-but-invalid holder is reclaimed
 * the same way as a dead one.
 */

import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type AcquireResult = { acquired: true } | { acquired: false; holderPid: number };

function lockPath(home: string): string {
  return join(home, "bot.pid");
}

/** True iff `pid` names a currently-running process. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Read the PID recorded in the lock file. Null if missing, unreadable, or
 *  not a valid positive integer (a corrupt lock file). */
function readHolderPid(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writeOwnPid(path: string): void {
  writeFileSync(path, String(process.pid), { flag: "wx" });
}

/**
 * @param validateHolder  Optional identity check for a holder PID that IS
 *   alive (a plain liveness check can't tell "still our bot" from "PID got
 *   reused by an unrelated process after a crash"). Returning false treats
 *   the lock as stale and reclaims it via the same path as a dead holder.
 */
export function acquireInstanceLock(
  home: string,
  validateHolder?: (pid: number) => boolean,
): AcquireResult {
  const path = lockPath(home);

  try {
    writeOwnPid(path);
    return { acquired: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }

  const holderPid = readHolderPid(path);
  const holderIsStale =
    holderPid !== null &&
    (!isProcessAlive(holderPid) || (validateHolder !== undefined && !validateHolder(holderPid)));
  if (holderIsStale) {
    // Stale — the recorded holder is gone (or alive but not us, e.g. a
    // reused PID). Reclaim by removing the file and retrying the exclusive
    // write exactly once.
    try {
      unlinkSync(path);
    } catch {
      // Another process may have removed it first — fine, retry below.
    }
    try {
      writeOwnPid(path);
      return { acquired: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    // Lost the race to reclaim — whoever won now holds it.
    return { acquired: false, holderPid: readHolderPid(path) ?? -1 };
  }

  return { acquired: false, holderPid: holderPid ?? -1 };
}

export function releaseInstanceLock(home: string): void {
  const path = lockPath(home);
  if (readHolderPid(path) === process.pid) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone — fine.
    }
  }
}
