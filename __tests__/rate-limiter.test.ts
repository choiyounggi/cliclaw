import { describe, it, expect } from "vitest";
import { createRateLimiter } from "../lib/rate-limiter.ts";

describe("createRateLimiter — sliding window semantics", () => {
  it("admits requests up to maxPerWindow", () => {
    const rl = createRateLimiter({ maxPerWindow: 3, windowMs: 1000 });
    const t = 1000;
    expect(rl.check("a", t).ok).toBe(true);
    expect(rl.check("a", t + 1).ok).toBe(true);
    expect(rl.check("a", t + 2).ok).toBe(true);
  });

  it("rejects once the budget is gone", () => {
    const rl = createRateLimiter({ maxPerWindow: 3, windowMs: 1000 });
    const t = 1000;
    rl.check("a", t); rl.check("a", t); rl.check("a", t);
    const d = rl.check("a", t);
    expect(d.ok).toBe(false);
    expect(d.remaining).toBe(0);
    expect(d.retryAfterMs).toBeGreaterThan(0);
    expect(d.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it("recovers after the oldest entry ages out", () => {
    const rl = createRateLimiter({ maxPerWindow: 2, windowMs: 1000 });
    const t = 1000;
    rl.check("a", t);
    rl.check("a", t + 100);
    expect(rl.check("a", t + 200).ok).toBe(false);
    // First entry was at t; at t+1001 it's outside the window.
    expect(rl.check("a", t + 1001).ok).toBe(true);
  });

  it("isolates buckets per key", () => {
    const rl = createRateLimiter({ maxPerWindow: 1, windowMs: 1000 });
    expect(rl.check("a", 1).ok).toBe(true);
    expect(rl.check("a", 1).ok).toBe(false);
    // Different key untouched.
    expect(rl.check("b", 1).ok).toBe(true);
  });

  it("reports remaining accurately", () => {
    const rl = createRateLimiter({ maxPerWindow: 5, windowMs: 1000 });
    expect(rl.check("a", 1).remaining).toBe(4);
    expect(rl.check("a", 1).remaining).toBe(3);
    expect(rl.check("a", 1).remaining).toBe(2);
  });

  it("retryAfterMs counts down as time passes", () => {
    const rl = createRateLimiter({ maxPerWindow: 1, windowMs: 1000 });
    rl.check("a", 1000);
    const d1 = rl.check("a", 1100);
    const d2 = rl.check("a", 1900);
    expect(d1.retryAfterMs).toBeGreaterThan(d2.retryAfterMs);
  });

  it("reset() clears the bucket for that key only", () => {
    const rl = createRateLimiter({ maxPerWindow: 1, windowMs: 1000 });
    rl.check("a", 1);
    rl.check("b", 1);
    rl.reset("a");
    expect(rl.check("a", 1).ok).toBe(true);
    expect(rl.check("b", 1).ok).toBe(false); // b untouched
  });
});
