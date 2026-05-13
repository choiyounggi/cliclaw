import { describe, it, expect } from "vitest";
import { createToolIndicator, type SendFn, type EditFn, type DeleteFn } from "../lib/tool-indicator.ts";

interface Recorder {
  ops: string[]; // ordered transcript of "send:101=text" / "edit:101=text" / "delete:101"
  send: SendFn;
  edit: EditFn;
  delete: DeleteFn;
}

function makeRecorder(): Recorder {
  const ops: string[] = [];
  let nextId = 100;
  return {
    ops,
    send: async (_cid, text) => {
      const id = nextId++;
      ops.push(`send:${id}=${text}`);
      return { message_id: id };
    },
    edit: async (_cid, id, text) => {
      ops.push(`edit:${id}=${text}`);
    },
    delete: async (_cid, id) => {
      ops.push(`delete:${id}`);
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createToolIndicator", () => {
  it("first update sends a single bubble; subsequent updates edit it in place", async () => {
    const r = makeRecorder();
    const t = createToolIndicator({ chatId: 1, send: r.send, edit: r.edit, delete: r.delete, minIntervalMs: 30 });
    t.update("🔧 step 1");
    await sleep(60);
    t.update("🔧 step 2");
    await sleep(60);
    await t.flush();
    expect(r.ops[0]).toBe("send:100=🔧 step 1");
    expect(r.ops[1]).toBe("edit:100=🔧 step 2");
    expect(r.ops).toHaveLength(2);
  });

  it("rapid updates within debounce window collapse into one transport call", async () => {
    const r = makeRecorder();
    const t = createToolIndicator({ chatId: 1, send: r.send, edit: r.edit, delete: r.delete, minIntervalMs: 100 });
    t.update("🔧 1");
    t.update("🔧 2");
    t.update("🔧 3");
    t.update("🔧 4");
    await sleep(150);
    await t.flush();
    // Only one transport call carries the *latest* text.
    expect(r.ops).toEqual(["send:100=🔧 4"]);
  });

  it("finalize() deletes the in-progress bubble and re-sends the final text", async () => {
    const r = makeRecorder();
    const t = createToolIndicator({ chatId: 1, send: r.send, edit: r.edit, delete: r.delete, minIntervalMs: 20 });
    t.update("🔧 first");
    await sleep(40);
    t.update("🔧 last");
    await sleep(40);
    await t.finalize();
    // Visible flow: send 100, edit 100, delete 100, send 101 (the new final bubble below the answer).
    expect(r.ops).toEqual([
      "send:100=🔧 first",
      "edit:100=🔧 last",
      "delete:100",
      "send:101=🔧 last",
    ]);
  });

  it("finalize() is a no-op when no update was ever called", async () => {
    const r = makeRecorder();
    const t = createToolIndicator({ chatId: 1, send: r.send, edit: r.edit, delete: r.delete });
    await t.finalize();
    expect(r.ops).toEqual([]);
    expect(t.lastText()).toBeNull();
  });

  it("clear() deletes the bubble without re-sending", async () => {
    const r = makeRecorder();
    const t = createToolIndicator({ chatId: 1, send: r.send, edit: r.edit, delete: r.delete, minIntervalMs: 20 });
    t.update("🔧 x");
    await sleep(40);
    await t.clear();
    expect(r.ops).toEqual(["send:100=🔧 x", "delete:100"]);
    expect(t.lastText()).toBeNull();
  });

  it("transport errors are reported via onError but never thrown", async () => {
    const errs: unknown[] = [];
    const send: SendFn = async () => { throw new Error("offline"); };
    const edit: EditFn = async () => { throw new Error("offline"); };
    const del: DeleteFn = async () => { throw new Error("offline"); };
    const t = createToolIndicator({
      chatId: 1, send, edit, delete: del, minIntervalMs: 10, onError: (e) => errs.push(e),
    });
    t.update("🔧 x");
    await sleep(40);
    await t.finalize();
    expect(errs.length).toBeGreaterThan(0);
    expect((errs[0] as Error).message).toBe("offline");
  });

  it("lastText() returns the most recent update", () => {
    const r = makeRecorder();
    const t = createToolIndicator({ chatId: 1, send: r.send, edit: r.edit, delete: r.delete });
    expect(t.lastText()).toBeNull();
    t.update("🔧 a");
    expect(t.lastText()).toBe("🔧 a");
    t.update("🔧 b");
    expect(t.lastText()).toBe("🔧 b");
  });

  it("identical consecutive updates skip the redundant edit", async () => {
    const r = makeRecorder();
    const t = createToolIndicator({ chatId: 1, send: r.send, edit: r.edit, delete: r.delete, minIntervalMs: 20 });
    t.update("🔧 same");
    await sleep(40);
    t.update("🔧 same"); // identical — should not generate a new edit
    await sleep(40);
    await t.flush();
    expect(r.ops).toEqual(["send:100=🔧 same"]);
  });
});
