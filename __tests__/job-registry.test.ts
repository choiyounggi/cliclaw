import { describe, it, expect } from "vitest";
import { JobRegistry } from "../lib/job-registry.ts";

describe("JobRegistry", () => {
  it("register: returns job with abort controller and timestamp", () => {
    const r = new JobRegistry();
    const job = r.register(1, "claude");
    expect(job.chatId).toBe(1);
    expect(job.agent).toBe("claude");
    expect(job.abort.signal.aborted).toBe(false);
    expect(job.startedAt).toBeInstanceOf(Date);
  });

  it("register: throws when chatId already has an in-flight job", () => {
    const r = new JobRegistry();
    r.register(1, "claude");
    expect(() => r.register(1, "codex")).toThrow(/already in flight/);
  });

  it("cancel: signals abort and returns the job", () => {
    const r = new JobRegistry();
    const job = r.register(1, "claude");
    const cancelled = r.cancel(1);
    expect(cancelled).toBe(job);
    expect(job.abort.signal.aborted).toBe(true);
  });

  it("cancel: returns undefined for unknown chatId", () => {
    const r = new JobRegistry();
    expect(r.cancel(99)).toBeUndefined();
  });

  it("clear: removes job, register again succeeds", () => {
    const r = new JobRegistry();
    r.register(1, "claude");
    r.clear(1);
    expect(r.get(1)).toBeUndefined();
    expect(() => r.register(1, "codex")).not.toThrow();
  });

  it("size: tracks active job count across chats", () => {
    const r = new JobRegistry();
    expect(r.size()).toBe(0);
    r.register(1, "claude");
    r.register(2, "pi");
    expect(r.size()).toBe(2);
    r.clear(1);
    expect(r.size()).toBe(1);
  });

  it("abort.signal listeners receive cancellation event", () => {
    const r = new JobRegistry();
    const job = r.register(1, "claude");
    let fired = false;
    job.abort.signal.addEventListener("abort", () => { fired = true; });
    r.cancel(1);
    expect(fired).toBe(true);
  });
});
