/**
 * Tool indicator: a single rolling Telegram bubble that shows the agent's
 * current tool call. Edits in place during execution (no flood). When the
 * agent finishes, finalize() deletes the in-progress bubble and re-sends the
 * final state below the answer so chat order reads:
 *
 *   user message
 *   [streamed answer]
 *   🔧 last tool indicator   ← always at the bottom after finalize()
 *
 * Transport-agnostic for testability — caller injects send/edit/delete fns.
 */

export interface SendFn {
  (chatId: number, text: string): Promise<{ message_id: number }>;
}
export interface EditFn {
  (chatId: number, messageId: number, text: string): Promise<void>;
}
export interface DeleteFn {
  (chatId: number, messageId: number): Promise<void>;
}

export interface ToolIndicatorOptions {
  chatId: number;
  send: SendFn;
  edit: EditFn;
  delete: DeleteFn;
  /** Min interval between edits to stay under Telegram rate limit. Default 1500ms. */
  minIntervalMs?: number;
  /** Logger for transport errors. Default no-op. */
  onError?: (err: unknown) => void;
}

export interface ToolIndicator {
  /** Update the visible text (debounced, edits in place). */
  update(text: string): void;
  /** Wait for any in-flight edits to complete. */
  flush(): Promise<void>;
  /**
   * Final flush: delete the in-progress bubble (if any), then re-send the
   * latest text as a fresh message so it sits below anything sent in the
   * meantime (e.g. the streamed answer). No-op if no text was ever appended.
   */
  finalize(): Promise<void>;
  /** Delete the in-progress bubble without re-sending. */
  clear(): Promise<void>;
  /** The most recent text that was passed to update(). */
  lastText(): string | null;
}

const DEFAULT_INTERVAL = 1500;

export function createToolIndicator(opts: ToolIndicatorOptions): ToolIndicator {
  const minInterval = opts.minIntervalMs ?? DEFAULT_INTERVAL;
  const onError = opts.onError ?? (() => {});

  let messageId: number | null = null;
  let latest: string | null = null;
  let lastSentText: string | null = null;
  let lastFlushAt = 0;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const enqueue = (fn: () => Promise<void>): void => {
    inFlight = inFlight.then(fn, fn);
  };

  const flushNow = async (): Promise<void> => {
    if (latest === null || latest === lastSentText) return;
    const text = latest;
    try {
      if (messageId === null) {
        const r = await opts.send(opts.chatId, text);
        messageId = r.message_id;
      } else {
        await opts.edit(opts.chatId, messageId, text);
      }
      lastSentText = text;
    } catch (err) { onError(err); }
    lastFlushAt = Date.now();
  };

  const scheduleFlush = (): void => {
    if (scheduled) return;
    const wait = Math.max(0, lastFlushAt + minInterval - Date.now());
    scheduled = setTimeout(() => {
      scheduled = null;
      enqueue(flushNow);
    }, wait);
  };

  return {
    update(text: string): void {
      if (!text) return;
      latest = text;
      scheduleFlush();
    },
    async flush(): Promise<void> {
      if (scheduled) { clearTimeout(scheduled); scheduled = null; }
      enqueue(flushNow);
      await inFlight;
    },
    async clear(): Promise<void> {
      if (scheduled) { clearTimeout(scheduled); scheduled = null; }
      await inFlight;
      if (messageId !== null) {
        const id = messageId;
        messageId = null;
        try { await opts.delete(opts.chatId, id); } catch (err) { onError(err); }
      }
      latest = null;
      lastSentText = null;
    },
    async finalize(): Promise<void> {
      if (scheduled) { clearTimeout(scheduled); scheduled = null; }
      await inFlight;
      if (latest === null) return; // nothing was ever displayed — nothing to finalize
      const finalText = latest;
      // Delete the in-progress bubble (which may be above the answer).
      if (messageId !== null) {
        const oldId = messageId;
        messageId = null;
        try { await opts.delete(opts.chatId, oldId); } catch (err) { onError(err); }
      }
      // Re-send below the answer.
      try {
        const r = await opts.send(opts.chatId, finalText);
        messageId = r.message_id;
        lastSentText = finalText;
      } catch (err) { onError(err); }
    },
    lastText(): string | null {
      return latest;
    },
  };
}
