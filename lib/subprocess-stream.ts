/// <reference types="bun" />

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
 * the process is still alive.
 */
export async function runSubprocessStream(
  bin: string,
  args: string[],
  opts: StreamSubprocessOptions,
): Promise<StreamSubprocessResult> {
  const proc = Bun.spawn([bin, ...args], {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...(opts.env ?? {}) },
  });

  let killedReason: StreamSubprocessResult["killedReason"] = null;

  const kill = (reason: "timeout" | "abort" | "idle"): void => {
    if (killedReason) return;
    killedReason = reason;
    try { proc.kill("SIGTERM"); } catch { /* already dead */ }
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
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

  const [stdout, stderr] = await Promise.all([
    drainStream(proc.stdout, wrappedStdout),
    drainStream(proc.stderr, opts.onStderrLine),
  ]);

  await proc.exited;
  clearTimeout(timeoutHandle);
  if (idleHandle) clearTimeout(idleHandle);
  if (opts.signal) opts.signal.removeEventListener("abort", abortListener);

  return {
    exitCode: proc.exitCode ?? -1,
    stdout,
    stderr,
    killedReason,
  };
}

async function drainStream(
  stream: ReadableStream<Uint8Array> | null,
  onLine: ((line: string) => void) | undefined,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      full += chunk;
      if (!onLine) continue;
      buf += chunk;
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
  } finally {
    reader.releaseLock();
  }
  return full;
}
