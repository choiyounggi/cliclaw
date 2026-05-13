/// <reference types="node" />
import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Unix-socket-based confirm gate IPC server.
 *
 * Hooks (claude/codex bash) connect, send a JSON line:
 *   {chatId: number, agent: "claude"|"codex", command: string, patternId: string, reason: string}
 *
 * Bot displays the request in Telegram with inline keyboard and resolves with:
 *   {decision: "allow"|"deny", reason?: string}
 *
 * Bot resolves by calling `confirm.respond(requestId, decision, reason?)`.
 */

export interface ConfirmRequest {
  requestId: string;
  chatId: number;
  agent: string;
  command: string;
  patternId: string;
  reason: string;
}

export type ConfirmDecision = "allow" | "deny";

export interface ConfirmResponse {
  decision: ConfirmDecision;
  reason?: string;
}

interface PendingRequest {
  request: ConfirmRequest;
  socket: Socket;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export interface ConfirmServerOptions {
  socketPath: string;
  /** How long to keep a pending request open before auto-denying. */
  pendingTimeoutMs: number;
  /** Called when a hook sends a request — caller is responsible for prompting the user. */
  onRequest: (req: ConfirmRequest) => void;
}

export class ConfirmServer {
  private server: Server | null = null;
  private pending = new Map<string, PendingRequest>();

  constructor(private readonly opts: ConfirmServerOptions) {}

  async start(): Promise<void> {
    if (this.server) throw new Error("confirm server already started");
    mkdirSync(dirname(this.opts.socketPath), { recursive: true });
    // Remove stale socket from a previous run.
    if (existsSync(this.opts.socketPath)) {
      try { unlinkSync(this.opts.socketPath); } catch { /* race — try anyway */ }
    }
    this.server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.socketPath, () => {
        this.server!.removeListener("error", reject);
        try { chmodSync(this.opts.socketPath, 0o600); } catch { /* best effort */ }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    // Deny outstanding requests so hooks exit deterministically.
    for (const id of [...this.pending.keys()]) {
      this.respond(id, "deny", "봇 종료 중");
    }
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
    try { unlinkSync(this.opts.socketPath); } catch { /* already gone */ }
  }

  /** Resolve a pending request and close the hook's socket. Returns whether the request was found. */
  respond(requestId: string, decision: ConfirmDecision, reason?: string): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timeoutHandle);
    this.pending.delete(requestId);
    const payload: ConfirmResponse = reason ? { decision, reason } : { decision };
    try {
      p.socket.write(JSON.stringify(payload) + "\n");
      p.socket.end();
    } catch { /* hook may have gone away; nothing to do */ }
    return true;
  }

  /** Currently-pending request count (mostly for diagnostics + tests). */
  pendingCount(): number {
    return this.pending.size;
  }

  private handleConnection(socket: Socket): void {
    let buf = "";
    let handled = false;

    const cleanup = (): void => {
      socket.removeAllListeners();
    };

    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      handled = true;
      const line = buf.slice(0, nl);
      let parsed: unknown;
      try { parsed = JSON.parse(line); }
      catch {
        socket.write(JSON.stringify({ decision: "deny", reason: "bad request" } satisfies ConfirmResponse) + "\n");
        socket.end();
        cleanup();
        return;
      }
      const req = normalizeRequest(parsed);
      if (!req) {
        socket.write(JSON.stringify({ decision: "deny", reason: "missing fields" } satisfies ConfirmResponse) + "\n");
        socket.end();
        cleanup();
        return;
      }
      const requestId = randomUUID();
      const fullReq: ConfirmRequest = { requestId, ...req };
      const timeoutHandle = setTimeout(() => {
        this.respond(requestId, "deny", `${this.opts.pendingTimeoutMs}ms 무응답으로 자동 거부`);
      }, this.opts.pendingTimeoutMs);
      this.pending.set(requestId, { request: fullReq, socket, timeoutHandle });
      try { this.opts.onRequest(fullReq); }
      catch {
        // Caller blew up — fail safe by denying so the hook doesn't hang.
        this.respond(requestId, "deny", "internal error");
      }
    });

    socket.on("error", () => {
      // The hook may close before we respond if the user takes too long; that's fine.
      cleanup();
    });
    socket.on("close", () => {
      // If the hook hung up before we replied, find and forget the pending entry.
      for (const [id, p] of this.pending) {
        if (p.socket === socket) {
          clearTimeout(p.timeoutHandle);
          this.pending.delete(id);
        }
      }
      cleanup();
    });
  }
}

function normalizeRequest(v: unknown): Omit<ConfirmRequest, "requestId"> | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.chatId !== "number") return null;
  if (typeof o.agent !== "string") return null;
  if (typeof o.command !== "string") return null;
  return {
    chatId: o.chatId,
    agent: o.agent,
    command: o.command,
    patternId: typeof o.patternId === "string" ? o.patternId : "unknown",
    reason: typeof o.reason === "string" ? o.reason : "",
  };
}
