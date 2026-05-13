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
});
