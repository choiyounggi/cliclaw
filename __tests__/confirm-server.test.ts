import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { connect, type Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { ConfirmServer, type ConfirmRequest, type ConfirmResponse } from "../lib/confirm-server.ts";

function makeSocketPath(): string {
  const dir = mkdtempSync(join(process.cwd(), ".claude/tmp/confirm-srv-"));
  return join(dir, "confirm.sock");
}

function sendAndAwait(socketPath: string, payload: object): Promise<{ resp: ConfirmResponse; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = "";
    sock.on("connect", () => {
      sock.write(JSON.stringify(payload) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        try {
          const resp = JSON.parse(buf.slice(0, nl)) as ConfirmResponse;
          resolve({ resp, socket: sock });
        } catch (err) { reject(err); }
      }
    });
    sock.on("error", reject);
    setTimeout(() => reject(new Error("client recv timeout")), 3000).unref?.();
  });
}

describe("ConfirmServer", () => {
  let server: ConfirmServer;
  let socketPath: string;
  let received: ConfirmRequest[];

  beforeEach(async () => {
    socketPath = makeSocketPath();
    received = [];
    server = new ConfirmServer({
      socketPath,
      pendingTimeoutMs: 1000,
      onRequest: (req) => received.push(req),
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("receives a well-formed request and routes it to onRequest", async () => {
    const clientPromise = sendAndAwait(socketPath, {
      chatId: 42, agent: "claude", command: "rm -rf /tmp/x", patternId: "rm-rf", reason: "rm -rf",
    });
    // wait briefly so onRequest fires
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect(received[0].chatId).toBe(42);
    expect(received[0].command).toBe("rm -rf /tmp/x");
    expect(received[0].requestId).toMatch(/^[0-9a-f-]{36}$/);

    server.respond(received[0].requestId, "allow");
    const { resp } = await clientPromise;
    expect(resp).toEqual({ decision: "allow" });
  });

  it("respond('deny', reason) sends reason to the hook client", async () => {
    const clientPromise = sendAndAwait(socketPath, {
      chatId: 1, agent: "claude", command: "x", patternId: "p", reason: "",
    });
    await new Promise((r) => setTimeout(r, 50));
    server.respond(received[0].requestId, "deny", "user rejected");
    const { resp } = await clientPromise;
    expect(resp).toEqual({ decision: "deny", reason: "user rejected" });
  });

  it("auto-denies after pendingTimeoutMs elapses", async () => {
    const clientPromise = sendAndAwait(socketPath, {
      chatId: 1, agent: "codex", command: "x", patternId: "p", reason: "",
    });
    const { resp } = await clientPromise;
    expect(resp.decision).toBe("deny");
    expect(resp.reason).toMatch(/무응답/);
  });

  it("denies a malformed JSON request", async () => {
    const sock = connect(socketPath);
    const respText = await new Promise<string>((resolve, reject) => {
      let buf = "";
      sock.on("connect", () => sock.write("not-json\n"));
      sock.on("data", (c) => { buf += c.toString("utf8"); if (buf.includes("\n")) resolve(buf); });
      sock.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000).unref?.();
    });
    expect(JSON.parse(respText.trim())).toEqual({ decision: "deny", reason: "bad request" });
    sock.destroy();
    expect(received).toHaveLength(0);
  });

  it("denies a request missing required fields", async () => {
    const sock = connect(socketPath);
    const respText = await new Promise<string>((resolve, reject) => {
      let buf = "";
      sock.on("connect", () => sock.write(JSON.stringify({ chatId: "not-a-number" }) + "\n"));
      sock.on("data", (c) => { buf += c.toString("utf8"); if (buf.includes("\n")) resolve(buf); });
      sock.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000).unref?.();
    });
    expect(JSON.parse(respText.trim())).toEqual({ decision: "deny", reason: "missing fields" });
  });

  it("respond() returns false for unknown requestId", () => {
    expect(server.respond("nonexistent", "allow")).toBe(false);
  });

  it("client closing early removes the pending entry (no leak)", async () => {
    const sock = connect(socketPath);
    await new Promise<void>((r) => sock.on("connect", () => {
      sock.write(JSON.stringify({ chatId: 1, agent: "claude", command: "x" }) + "\n");
      r();
    }));
    await new Promise((r) => setTimeout(r, 50));
    expect(server.pendingCount()).toBe(1);
    sock.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(server.pendingCount()).toBe(0);
  });

  it("stop() denies all outstanding requests", async () => {
    const c1 = sendAndAwait(socketPath, { chatId: 1, agent: "claude", command: "a" });
    const c2 = sendAndAwait(socketPath, { chatId: 2, agent: "codex", command: "b" });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.pendingCount()).toBe(2);
    await server.stop();
    const [r1, r2] = await Promise.all([c1, c2]);
    expect(r1.resp.decision).toBe("deny");
    expect(r2.resp.decision).toBe("deny");
    expect(r1.resp.reason).toMatch(/종료/);
  });
});
