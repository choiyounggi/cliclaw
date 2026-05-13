/**
 * Streaming Telegram message: appends text incrementally, debounces edits to
 * stay under Telegram's edit rate limit (~1 edit/sec safe), and rolls over to
 * a new message when the buffer approaches the 4096-char per-message cap.
 *
 * Designed to be transport-agnostic for testability — the caller injects send
 * and edit functions instead of having us hard-wire to fetch().
 *
 * Model:
 *  - `buffer` holds the entire accumulated text across all messages.
 *  - `messages[]` is the chain of telegram messages we own. messages[i] displays
 *    buffer.slice(messages[i].start, messages[i+1]?.start ?? buffer.length).
 *  - Each flush computes what each message *should* contain right now and
 *    sends/edits accordingly.
 */

export interface SendFn {
  (chatId: number, text: string): Promise<{ message_id: number }>;
}
export interface EditFn {
  (chatId: number, messageId: number, text: string): Promise<void>;
}

export interface StreamOptions {
  chatId: number;
  send: SendFn;
  edit: EditFn;
  /** Min time between successive transport calls. Default 1500ms. */
  minIntervalMs?: number;
  /** Max chars per Telegram message before rolling over. Default 3800 (cushion under 4096). */
  rolloverChars?: number;
  /** Placeholder shown in an empty bubble (rare — only if we must edit before any text exists). */
  placeholder?: string;
  /** Logger for transport errors. Default no-op. */
  onError?: (err: unknown) => void;
}

export interface StreamingMessage {
  /** Append text. Triggers a debounced edit. */
  append(chunk: string): void;
  /** Force final flush. Resolves once all transport calls land. */
  close(): Promise<void>;
  /** Whether anything has been appended yet. */
  hasContent(): boolean;
}

const DEFAULT_INTERVAL = 1500;
const DEFAULT_ROLLOVER = 3800;
const DEFAULT_PLACEHOLDER = "…";

interface Slot { id: number | null; start: number; lastSentText: string; }

export function createStreamingMessage(opts: StreamOptions): StreamingMessage {
  const minInterval = opts.minIntervalMs ?? DEFAULT_INTERVAL;
  const rolloverChars = opts.rolloverChars ?? DEFAULT_ROLLOVER;
  const placeholder = opts.placeholder ?? DEFAULT_PLACEHOLDER;
  const onError = opts.onError ?? (() => {});

  let buffer = "";
  const slots: Slot[] = []; // first slot allocated lazily on first flush
  let lastFlushAt = 0;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let hasAppended = false;
  let closed = false;

  /**
   * Reconcile slots[] with the current buffer:
   *   - Ensure each slot's content (computed from buffer + start offsets)
   *     is no larger than rolloverChars.
   *   - If the trailing slot would overflow, split it at a sensible boundary
   *     and add a new slot for the remainder.
   * Then send/edit each slot whose computed text differs from lastSentText.
   */
  const flushNow = async (): Promise<void> => {
    // Plan: ensure slot list covers the whole buffer with no overflow.
    if (slots.length === 0) {
      slots.push({ id: null, start: 0, lastSentText: "" });
    }
    // Roll over any trailing slot that overflows.
    while (true) {
      const last = slots[slots.length - 1];
      const text = buffer.slice(last.start);
      if (text.length <= rolloverChars) break;
      // Pick a split point: rolloverChars, but back up to the previous newline
      // if one exists within the last 200 chars (nicer reading).
      let split = rolloverChars;
      const newlineHint = text.lastIndexOf("\n", rolloverChars);
      if (newlineHint > 0 && newlineHint >= rolloverChars - 200) split = newlineHint + 1;
      slots.push({ id: null, start: last.start + split, lastSentText: "" });
    }
    // Now send/edit each slot in order.
    for (const slot of slots) {
      const idx = slots.indexOf(slot);
      const nextStart = slots[idx + 1]?.start ?? buffer.length;
      const text = buffer.slice(slot.start, nextStart);
      if (text === slot.lastSentText) continue;
      const display = text || placeholder;
      try {
        if (slot.id === null) {
          const r = await opts.send(opts.chatId, display);
          slot.id = r.message_id;
        } else {
          await opts.edit(opts.chatId, slot.id, display);
        }
        slot.lastSentText = text;
      } catch (err) { onError(err); }
    }
    lastFlushAt = Date.now();
  };

  // Serialize all transport calls so we never overlap edits on the same message.
  const enqueue = (fn: () => Promise<void>): void => {
    inFlight = inFlight.then(fn, fn);
  };

  const scheduleFlush = (): void => {
    if (closed || scheduled) return;
    const wait = Math.max(0, lastFlushAt + minInterval - Date.now());
    scheduled = setTimeout(() => {
      scheduled = null;
      enqueue(flushNow);
    }, wait);
  };

  return {
    append(chunk: string): void {
      if (!chunk || closed) return;
      hasAppended = true;
      buffer += chunk;
      scheduleFlush();
    },
    async close(): Promise<void> {
      closed = true;
      if (scheduled) { clearTimeout(scheduled); scheduled = null; }
      if (hasAppended) enqueue(flushNow);
      await inFlight;
    },
    hasContent(): boolean {
      return hasAppended;
    },
  };
}
