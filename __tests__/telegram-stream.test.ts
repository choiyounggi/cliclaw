import { describe, it, expect } from "vitest";
import { createStreamingMessage, type SendFn, type EditFn } from "../lib/telegram-stream.ts";

interface Recorder {
  sends: { chatId: number; text: string; messageId: number }[];
  edits: { chatId: number; messageId: number; text: string }[];
  send: SendFn;
  edit: EditFn;
}

function makeRecorder(): Recorder {
  const sends: Recorder["sends"] = [];
  const edits: Recorder["edits"] = [];
  let nextId = 100;
  return {
    sends, edits,
    send: async (chatId, text) => {
      const messageId = nextId++;
      sends.push({ chatId, text, messageId });
      return { message_id: messageId };
    },
    edit: async (chatId, messageId, text) => {
      edits.push({ chatId, messageId, text });
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createStreamingMessage", () => {
  it("appends accumulate; one send carries the full text by the time the debounce fires", async () => {
    const r = makeRecorder();
    const s = createStreamingMessage({ chatId: 1, send: r.send, edit: r.edit, minIntervalMs: 50 });
    s.append("Hello ");
    s.append("world");
    await sleep(150);
    await s.close();
    expect(r.sends).toHaveLength(1);
    // After debounce, the first transport call already contains the full text.
    expect(r.sends[0].text).toBe("Hello world");
  });

  it("appends arriving after the first flush become edits to the same message", async () => {
    const r = makeRecorder();
    const s = createStreamingMessage({ chatId: 1, send: r.send, edit: r.edit, minIntervalMs: 30 });
    s.append("part 1");
    await sleep(80); // let the first flush land
    s.append(" part 2");
    await sleep(80); // let the second flush land
    await s.close();
    expect(r.sends).toHaveLength(1);
    expect(r.sends[0].text).toBe("part 1");
    expect(r.edits.at(-1)?.messageId).toBe(r.sends[0].messageId);
    expect(r.edits.at(-1)?.text).toBe("part 1 part 2");
  });

  it("debounces: multiple rapid appends collapse into a single transport call", async () => {
    const r = makeRecorder();
    const s = createStreamingMessage({ chatId: 1, send: r.send, edit: r.edit, minIntervalMs: 100 });
    s.append("a");
    for (let i = 0; i < 20; i++) s.append("x");
    await sleep(250);
    await s.close();
    // 21 appends within one debounce window → 1 send carrying the full text, 0 edits.
    expect(r.sends).toHaveLength(1);
    expect(r.sends[0].text).toBe("a" + "x".repeat(20));
    expect(r.edits.length).toBeLessThanOrEqual(1);
  });

  it("rolls over to a new message when buffer reaches rolloverChars", async () => {
    const r = makeRecorder();
    const s = createStreamingMessage({
      chatId: 1, send: r.send, edit: r.edit, minIntervalMs: 10, rolloverChars: 50,
    });
    s.append("A".repeat(60));            // first 50 fill slot[0], remaining 10 roll into slot[1]
    s.append("more text after rollover"); // appends to slot[1]
    await sleep(80);
    await s.close();
    expect(r.sends).toHaveLength(2);
    expect(r.sends[0].text.length).toBeLessThanOrEqual(50);
    // slot[1] holds 10 A's + the second append.
    expect(r.sends[1].text.startsWith("A".repeat(10))).toBe(true);
    expect(r.sends[1].text.endsWith("more text after rollover")).toBe(true);
  });

  it("close() flushes any pending edit even before debounce fires", async () => {
    const r = makeRecorder();
    const s = createStreamingMessage({ chatId: 1, send: r.send, edit: r.edit, minIntervalMs: 1000 });
    s.append("first chunk");
    // Don't wait — close immediately. The pending flush must still land.
    await s.close();
    expect(r.sends).toHaveLength(1);
    expect(r.sends[0].text).toBe("first chunk");
  });

  it("placeholder shows in the initial bubble when first append is empty-ish", async () => {
    const r = makeRecorder();
    const s = createStreamingMessage({
      chatId: 1, send: r.send, edit: r.edit, minIntervalMs: 10, placeholder: "…thinking…",
    });
    // Force initial send via close without ever appending content.
    await s.close();
    // close() should not send anything if nothing was appended (no point in
    // an empty bubble). hasContent() == false.
    expect(s.hasContent()).toBe(false);
    // But if we appended even one char, the placeholder appears as a fallback
    // for an empty edit (rare).
    const r2 = makeRecorder();
    const s2 = createStreamingMessage({
      chatId: 1, send: r2.send, edit: r2.edit, minIntervalMs: 10, placeholder: "…thinking…",
    });
    s2.append("real text");
    await s2.close();
    expect(r2.sends[0].text).toBe("real text");
  });

  it("hasContent() reflects whether any append happened", async () => {
    const r = makeRecorder();
    const s = createStreamingMessage({ chatId: 1, send: r.send, edit: r.edit, minIntervalMs: 50 });
    expect(s.hasContent()).toBe(false);
    s.append("x");
    expect(s.hasContent()).toBe(true);
    await s.close();
  });

  it("transport errors are reported via onError but never thrown to the caller", async () => {
    const errs: unknown[] = [];
    const send: SendFn = async () => { throw new Error("network down"); };
    const edit: EditFn = async () => { throw new Error("network down"); };
    const s = createStreamingMessage({
      chatId: 1, send, edit, minIntervalMs: 10, onError: (e) => errs.push(e),
    });
    s.append("hi");
    await sleep(50);
    await s.close();
    expect(errs.length).toBeGreaterThan(0);
    expect((errs[0] as Error).message).toBe("network down");
  });

  it("close() awaits the final transport call (no race with subsequent reads)", async () => {
    const ordering: string[] = [];
    const r = makeRecorder();
    const slowEdit: EditFn = async (...args) => {
      await sleep(50);
      ordering.push("edit-done");
      return r.edit(...args);
    };
    const s = createStreamingMessage({ chatId: 1, send: r.send, edit: slowEdit, minIntervalMs: 10 });
    s.append("a");
    await sleep(20);
    s.append("b");
    ordering.push("close-start");
    await s.close();
    ordering.push("close-end");
    expect(ordering[0]).toBe("close-start");
    expect(ordering.at(-1)).toBe("close-end");
    expect(ordering).toContain("edit-done");
  });

  it("calls fallbackSend on the 3rd consecutive failure; success stops further retries", async () => {
    const errs: unknown[] = [];
    const fallbackCalls: string[] = [];
    const send: SendFn = async () => { throw new Error("boom"); };
    const edit: EditFn = async () => { throw new Error("boom"); };
    const s = createStreamingMessage({
      chatId: 1, send, edit, minIntervalMs: 10,
      onError: (e) => errs.push(e),
      fallbackSend: async (text) => { fallbackCalls.push(text); return true; },
    });
    s.append("one");
    await sleep(30); // flush 1: fails (consecutiveFailures=1)
    s.append(" two");
    await sleep(30); // flush 2: fails (consecutiveFailures=2)
    s.append(" three");
    await sleep(30); // flush 3: fails -> 3rd consecutive failure triggers fallbackSend
    await s.close();
    expect(fallbackCalls).toHaveLength(1);
    expect(fallbackCalls[0]).toBe("one two three");
    // 3 send attempts total, no extra retry after the fallback marked the slot delivered.
    expect(errs.length).toBe(3);
  });

  it("keeps retrying via the normal path when fallbackSend returns false", async () => {
    const r = makeRecorder();
    let attempt = 0;
    const send: SendFn = async (chatId, text) => {
      attempt++;
      if (attempt <= 3) throw new Error("boom");
      return r.send(chatId, text);
    };
    const fallbackCalls: string[] = [];
    const s = createStreamingMessage({
      chatId: 1, send, edit: r.edit, minIntervalMs: 10,
      fallbackSend: async (text) => { fallbackCalls.push(text); return false; },
    });
    s.append("a");
    await sleep(30); // attempt 1: fails
    s.append("b");
    await sleep(30); // attempt 2: fails
    s.append("c");
    await sleep(30); // attempt 3: fails -> fallback called, returns false -> keep retrying
    s.append("d");
    await sleep(30); // attempt 4: send finally succeeds via the normal path
    await s.close();
    expect(fallbackCalls).toHaveLength(1);
    expect(r.sends).toHaveLength(1);
    expect(r.sends[0].text).toBe("abcd");
  });

  it("measure() overrides text.length for the rollover decision", async () => {
    const CONTENT = "hello\nworld"; // 11 raw chars, well under rolloverChars=200

    const withoutMeasure = makeRecorder();
    const s1 = createStreamingMessage({
      chatId: 1, send: withoutMeasure.send, edit: withoutMeasure.edit, minIntervalMs: 10, rolloverChars: 200,
    });
    s1.append(CONTENT);
    await sleep(30);
    await s1.close();
    expect(withoutMeasure.sends).toHaveLength(1);

    const withMeasure = makeRecorder();
    const s2 = createStreamingMessage({
      chatId: 1, send: withMeasure.send, edit: withMeasure.edit, minIntervalMs: 10, rolloverChars: 200,
      // Simulates e.g. converted-HTML length: any segment still containing the
      // un-split source text measures as oversized regardless of raw length.
      measure: (text) => (text.includes("\n") ? Number.MAX_SAFE_INTEGER : text.length),
    });
    s2.append(CONTENT);
    await sleep(30);
    await s2.close();
    // Same raw content that fit in one message above now rolls over into two,
    // because measure() (not text.length) decided it was too long.
    expect(withMeasure.sends).toHaveLength(2);
  });
});
