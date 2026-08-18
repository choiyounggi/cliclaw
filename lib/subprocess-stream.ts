import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export interface StreamSubprocessOptions {
  cwd: string;
  env?: Record<string, string>;
  /** Hard cap from the time the process starts. Triggers SIGTERM. */
  timeoutMs: number;
  /** Kill if no stdout activity for this long. Resets on every stdout line. Default off. */
  idleTimeoutMs?: number;
  /** External cancellation (e.g. /stop). Triggers SIGTERM. */
  signal?: AbortSignal;
  /** Called for each complete stdout line (newline-delimited). */
  onStdoutLine?: (line: string) => void;
  /** Called for each complete stderr line (newline-delimited). */
  onStderrLine?: (line: string) => void;
}

export interface StreamSubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  killedReason: "timeout" | "idle" | "abort" | null;
}

/**
 * Spawn a subprocess and stream stdout/stderr line-by-line via callbacks while
 * also accumulating the full output for the caller. Supports external cancellation
 * and a hard timeout — both deliver SIGTERM, then SIGKILL after a grace period if
 * the process is still alive. The child is spawned detached as the leader of its
 * own process group, and kill signals target the whole group (negative pid) so a
 * backgrounded grandchild the child spawns dies with it too.
 */
export async function runSubprocessStream(
  bin: string,
  args: string[],
  opts: StreamSubprocessOptions,
): Promise<StreamSubprocessResult> {
  const proc = spawn(bin, args, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...(opts.env ?? {}) },
  });

  let killedReason: StreamSubprocessResult["killedReason"] = null;

  const killGroup = (signal: NodeJS.Signals): void => {
    if (proc.pid == null) return;
    try {
      process.kill(-proc.pid, signal);
    } catch {
      // ESRCH (process group already gone) or any other kill failure — the
      // group is already unreachable, which is the outcome we wanted anyway.
    }
  };

  const kill = (reason: "timeout" | "abort" | "idle"): void => {
    if (killedReason) return;
    killedReason = reason;
    killGroup("SIGTERM");
    setTimeout(() => {
      killGroup("SIGKILL");
    }, 5000).unref?.();
  };

  const timeoutHandle = setTimeout(() => kill("timeout"), opts.timeoutMs);
  const abortListener = (): void => kill("abort");
  if (opts.signal) {
    if (opts.signal.aborted) kill("abort");
    else opts.signal.addEventListener("abort", abortListener, { once: true });
  }

  let idleHandle: ReturnType<typeof setTimeout> | null = null;
  const resetIdle = (): void => {
    if (!opts.idleTimeoutMs) return;
    if (idleHandle) clearTimeout(idleHandle);
    idleHandle = setTimeout(() => kill("idle"), opts.idleTimeoutMs);
  };
  resetIdle();

  const wrappedStdout = opts.onStdoutLine ? (line: string) => { resetIdle(); opts.onStdoutLine!(line); } : (opts.idleTimeoutMs ? () => resetIdle() : undefined);

  let exitCode: number | null = null;
  const exited = new Promise<void>((resolve) => {
    const done = (code: number | null): void => { exitCode = code; resolve(); };
    proc.once("exit", (code) => done(code));
    proc.once("error", () => done(null));
  });

  let stdout = "";
  let stderr = "";
  try {
    [stdout, stderr] = await Promise.all([
      drainStream(proc.stdout, wrappedStdout),
      drainStream(proc.stderr, opts.onStderrLine),
    ]);
    await exited;
  } finally {
    // Always release timers + the abort listener. Without this, a drain/exit
    // rejection would leak them — keeping a dead process's SIGKILL timer armed
    // and accumulating abort listeners across reused AbortSignals.
    clearTimeout(timeoutHandle);
    if (idleHandle) clearTimeout(idleHandle);
    if (opts.signal) opts.signal.removeEventListener("abort", abortListener);
  }

  return {
    exitCode: exitCode ?? -1,
    stdout,
    stderr,
    killedReason,
  };
}

async function drainStream(
  stream: Readable | null,
  onLine: ((line: string) => void) | undefined,
): Promise<string> {
  if (!stream) return "";
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  try {
    // Async iteration works the same way over Node Readable streams as it did
    // over the Web ReadableStream this replaced.
    for await (const chunk of stream) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      full += text;
      if (!onLine) continue;
      buf += text;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try { onLine(line); } catch { /* never break the drain on a callback error */ }
        nl = buf.indexOf("\n");
      }
    }
    if (onLine && buf.length > 0) {
      try { onLine(buf); } catch { /* swallow */ }
    }
  } catch {
    // Broken pipe on a crashed/killed child — stop draining gracefully.
  }
  return full;
}
