/**
 * Per-chat sliding-window rate limiter.
 *
 * The bot accepts free-form Telegram messages and dispatches each to a
 * subprocess. Without a rate limit a runaway script (or a typo'd auto-
 * forwarder) can fire hundreds of agent spawns in a few seconds,
 * exhausting the per-chat lock and stressing the Telegram API. The
 * limiter sits in front of the message handler and returns a wait
 * estimate when a chat is over budget.
 *
 * Sliding window over fixed-size buffers: O(1) per check and bounded
 * memory per chat regardless of message volume. The window is short
 * (60s) and the cap is generous (30/min by default) — this is an
 * abuse circuit-breaker, not a quota system.
 */

export interface RateLimit {
  /** Max accepted requests per `windowMs`. */
  maxPerWindow: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateDecision {
  /** True if the request fits inside the current window. */
  ok: boolean;
  /** Milliseconds until the next allowed request when `ok=false`. */
  retryAfterMs: number;
  /** How many of the budget remain in the current window. */
  remaining: number;
}

export interface RateLimiter {
  check(key: string | number, now?: number): RateDecision;
  reset(key: string | number): void;
}

export function createRateLimiter(limit: RateLimit): RateLimiter {
  const buckets = new Map<string, number[]>();

  function check(key: string | number, now = Date.now()): RateDecision {
    const k = String(key);
    const cutoff = now - limit.windowMs;
    const timestamps = buckets.get(k) ?? [];

    // Drop entries that have aged out of the window. Iteration cost is
    // bounded by limit.maxPerWindow, which is a small constant.
    let firstFresh = 0;
    while (firstFresh < timestamps.length && timestamps[firstFresh] <= cutoff) {
      firstFresh++;
    }
    const fresh = firstFresh > 0 ? timestamps.slice(firstFresh) : timestamps;

    if (fresh.length < limit.maxPerWindow) {
      fresh.push(now);
      buckets.set(k, fresh);
      return {
        ok: true,
        retryAfterMs: 0,
        remaining: limit.maxPerWindow - fresh.length,
      };
    }

    // Oldest timestamp drops out when it ages past the window.
    const retryAfterMs = fresh[0] + limit.windowMs - now;
    buckets.set(k, fresh);
    return { ok: false, retryAfterMs: Math.max(retryAfterMs, 1), remaining: 0 };
  }

  function reset(key: string | number): void {
    buckets.delete(String(key));
  }

  return { check, reset };
}
