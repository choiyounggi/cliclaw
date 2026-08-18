import { describe, it, expect } from "vitest";
import { runSubprocessStream } from "../lib/subprocess-stream.ts";

// These tests rely on /bin/sh and standard unix tools — fine on macOS/Linux CI.
describe("runSubprocessStream", () => {
  it("captures full stdout and emits one callback per line", async () => {
    const lines: string[] = [];
    const r = await runSubprocessStream("/bin/sh", ["-c", "printf 'a\\nb\\nc\\n'"], {
      cwd: process.cwd(),
      timeoutMs: 5000,
      onStdoutLine: (l) => lines.push(l),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("a\nb\nc\n");
    expect(lines).toEqual(["a", "b", "c"]);
    expect(r.killedReason).toBeNull();
  });

  it("captures stderr separately", async () => {
    const errs: string[] = [];
    const r = await runSubprocessStream(
      "/bin/sh",
      ["-c", "printf 'oops\\n' 1>&2; exit 3"],
      {
        cwd: process.cwd(),
        timeoutMs: 5000,
        onStderrLine: (l) => errs.push(l),
      },
    );
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toBe("oops\n");
    expect(errs).toEqual(["oops"]);
  });

  it("flushes a trailing line that has no terminating newline", async () => {
    const lines: string[] = [];
    const r = await runSubprocessStream("/bin/sh", ["-c", "printf 'no-newline'"], {
      cwd: process.cwd(),
      timeoutMs: 5000,
      onStdoutLine: (l) => lines.push(l),
    });
    expect(r.exitCode).toBe(0);
    expect(lines).toEqual(["no-newline"]);
  });

  it("AbortSignal triggers SIGTERM and reports killedReason='abort'", async () => {
    const ctrl = new AbortController();
    const p = runSubprocessStream("/bin/sh", ["-c", "sleep 30"], {
      cwd: process.cwd(),
      timeoutMs: 60_000,
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 100);
    const r = await p;
    expect(r.killedReason).toBe("abort");
    // sh exits non-zero when killed by signal.
    expect(r.exitCode).not.toBe(0);
  });

  it("timeoutMs triggers SIGTERM and reports killedReason='timeout'", async () => {
    const r = await runSubprocessStream("/bin/sh", ["-c", "sleep 30"], {
      cwd: process.cwd(),
      timeoutMs: 200,
    });
    expect(r.killedReason).toBe("timeout");
    expect(r.exitCode).not.toBe(0);
  });

  it("idleTimeoutMs fires when the process emits no stdout for the window", async () => {
    const r = await runSubprocessStream("/bin/sh", ["-c", "sleep 30"], {
      cwd: process.cwd(),
      timeoutMs: 60_000,
      idleTimeoutMs: 200,
    });
    expect(r.killedReason).toBe("idle");
    expect(r.exitCode).not.toBe(0);
  });

  it("idleTimeoutMs is reset by stdout activity (process emitting lines stays alive)", async () => {
    // Print every 100ms for ~500ms; idle timeout 300ms — process should finish normally.
    const r = await runSubprocessStream(
      "/bin/sh",
      ["-c", "for i in 1 2 3 4 5; do printf 'tick %s\\n' $i; sleep 0.1; done"],
      { cwd: process.cwd(), timeoutMs: 10_000, idleTimeoutMs: 300 },
    );
    expect(r.killedReason).toBeNull();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("tick 5");
  });

  it("a throwing onStdoutLine callback does not halt the stream drain", async () => {
    let count = 0;
    const r = await runSubprocessStream("/bin/sh", ["-c", "printf 'a\\nb\\nc\\n'"], {
      cwd: process.cwd(),
      timeoutMs: 5000,
      onStdoutLine: () => { count++; throw new Error("boom"); },
    });
    expect(r.exitCode).toBe(0);
    expect(count).toBe(3);
    expect(r.stdout).toBe("a\nb\nc\n");
  });

  it("env is merged into the child process environment", async () => {
    const r = await runSubprocessStream("/bin/sh", ["-c", "printf '%s' \"$MY_TEST_VAR\""], {
      cwd: process.cwd(),
      timeoutMs: 5000,
      env: { MY_TEST_VAR: "hello" },
    });
    expect(r.stdout).toBe("hello");
  });

  // Polls for a pid to disappear from the process table instead of asserting
  // immediately after kill — signal delivery + reaping isn't synchronous.
  async function pollUntilDead(pid: number, maxMs = 3000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  it("group-kills a backgrounded grandchild process on abort", async () => {
    const ctrl = new AbortController();
    let grandchildPid = "";
    const p = runSubprocessStream(
      "/bin/sh",
      ["-c", "sleep 30 & echo $!; wait"],
      {
        cwd: process.cwd(),
        timeoutMs: 60_000,
        signal: ctrl.signal,
        onStdoutLine: (l) => { grandchildPid = l.trim(); },
      },
    );
    // Let the shell background `sleep 30` and print its pid before we abort.
    await new Promise((r) => setTimeout(r, 200));
    ctrl.abort();
    const r = await p;
    expect(r.killedReason).toBe("abort");
    expect(grandchildPid).toMatch(/^\d+$/);
    expect(await pollUntilDead(Number(grandchildPid))).toBe(true);
  });

  it("escalates to SIGKILL after ~5s when the child traps and ignores SIGTERM", async () => {
    const ctrl = new AbortController();
    const start = Date.now();
    const p = runSubprocessStream(
      "/bin/sh",
      ["-c", "trap '' TERM; while true; do :; done"],
      { cwd: process.cwd(), timeoutMs: 60_000, signal: ctrl.signal },
    );
    setTimeout(() => ctrl.abort(), 100);
    const r = await p;
    const elapsedMs = Date.now() - start;
    expect(r.killedReason).toBe("abort");
    expect(r.exitCode).not.toBe(0);
    // SIGTERM alone was ignored — only the 5s SIGKILL escalation could have ended it.
    expect(elapsedMs).toBeGreaterThanOrEqual(4900);
  }, 15_000);
});
