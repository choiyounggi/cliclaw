import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { ConfirmServer } from "../lib/confirm-server.ts";

const HOOK_SCRIPT = join(process.cwd(), "bin/bash-confirm.ts");

function makeSocketPath(): string {
  const dir = mkdtempSync(join(process.cwd(), ".claude/tmp/hook-e2e-"));
  return join(dir, "confirm.sock");
}

interface SpawnResult { exitCode: number; stdout: string; stderr: string; }

async function spawnHook(
  payload: object,
  env: Record<string, string>,
): Promise<SpawnResult> {
  const proc = Bun.spawn(["bun", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { exitCode: proc.exitCode ?? -1, stdout, stderr };
}

describe("bash-confirm hook (e2e)", () => {
  let server: ConfirmServer;
  let socketPath: string;
  let lastRequestId: string | null;

  beforeEach(async () => {
    socketPath = makeSocketPath();
    lastRequestId = null;
    server = new ConfirmServer({
      socketPath,
      pendingTimeoutMs: 3000,
      onRequest: (req) => { lastRequestId = req.requestId; },
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("exits 0 silently when BOT_CONFIRM_SOCKET / TG_CHAT_ID env missing", async () => {
    const r = await spawnHook({ tool_input: { command: "rm -rf /" } }, {});
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("exits 0 silently on safe command", async () => {
    const r = await spawnHook(
      { tool_input: { command: "ls -la" } },
      { BOT_CONFIRM_SOCKET: socketPath, TG_CHAT_ID: "1", BOT_AGENT: "claude" },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("on dangerous command + allow → exit 0 with no block output", async () => {
    const hookPromise = spawnHook(
      { tool_input: { command: "git push --force origin main" } },
      { BOT_CONFIRM_SOCKET: socketPath, TG_CHAT_ID: "1", BOT_AGENT: "claude" },
    );
    // wait for the request to land
    await new Promise((r) => setTimeout(r, 200));
    expect(lastRequestId).not.toBeNull();
    server.respond(lastRequestId!, "allow");
    const r = await hookPromise;
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("on dangerous command + deny → emits block JSON, exit 0", async () => {
    const hookPromise = spawnHook(
      { tool_input: { command: "rm -rf /var/log" } },
      { BOT_CONFIRM_SOCKET: socketPath, TG_CHAT_ID: "1", BOT_AGENT: "claude" },
    );
    await new Promise((r) => setTimeout(r, 200));
    server.respond(lastRequestId!, "deny", "사용자가 거부");
    const r = await hookPromise;
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('"decision":"block"');
    expect(r.stdout).toContain("사용자가 거부");
  });

  it("fail-closed: socket missing → block", async () => {
    const r = await spawnHook(
      { tool_input: { command: "git push --force" } },
      {
        BOT_CONFIRM_SOCKET: join(process.cwd(), ".claude/tmp/nonexistent.sock"),
        TG_CHAT_ID: "1",
        BOT_AGENT: "claude",
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('"decision":"block"');
    expect(r.stdout).toContain("봇 통신 실패");
  });

  it("matches command from alternate JSON shapes (arguments.command)", async () => {
    const hookPromise = spawnHook(
      { arguments: { command: "kubectl delete pod foo" } },
      { BOT_CONFIRM_SOCKET: socketPath, TG_CHAT_ID: "1", BOT_AGENT: "codex" },
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(lastRequestId).not.toBeNull();
    server.respond(lastRequestId!, "allow");
    const r = await hookPromise;
    expect(r.exitCode).toBe(0);
  });
});
