import { describe, it, expect } from "vitest";
import {
  isNonPrivateChat,
  ConfigFatalError,
  isConfigFatalError,
  parseModelCommand,
  parsePlanCommand,
  isPassthrough,
  passthroughPrompt,
} from "../lib/chat-policy.ts";

describe("isNonPrivateChat", () => {
  it("returns false for a private chat (normal case)", () => {
    expect(isNonPrivateChat("private")).toBe(false);
  });

  it("returns true for a group chat", () => {
    expect(isNonPrivateChat("group")).toBe(true);
  });

  it("returns true for a supergroup or channel (other non-private types)", () => {
    expect(isNonPrivateChat("supergroup")).toBe(true);
    expect(isNonPrivateChat("channel")).toBe(true);
  });

  it("returns true for an empty string (boundary case)", () => {
    expect(isNonPrivateChat("")).toBe(true);
  });
});

describe("isConfigFatalError", () => {
  it("returns true for a ConfigFatalError instance (normal case)", () => {
    expect(isConfigFatalError(new ConfigFatalError("token not set"))).toBe(true);
  });

  it("returns false for a plain Error (error/other-type case)", () => {
    expect(isConfigFatalError(new Error("unexpected"))).toBe(false);
  });

  it("returns false for a TypeError (a genuine crash should propagate, not retry)", () => {
    expect(isConfigFatalError(new TypeError("boom"))).toBe(false);
  });

  it("returns false for non-Error thrown values like undefined or a string (boundary case)", () => {
    expect(isConfigFatalError(undefined)).toBe(false);
    expect(isConfigFatalError("plain string throw")).toBe(false);
    expect(isConfigFatalError(null)).toBe(false);
  });
});

describe("parseModelCommand", () => {
  it("parses '/model <name>' as a set, trimming surrounding whitespace (normal case)", () => {
    expect(parseModelCommand("/model  sonnet ")).toEqual({ kind: "set", model: "sonnet" });
  });

  it("parses '/model default' (any case) as a clear (normal case)", () => {
    expect(parseModelCommand("/model default")).toEqual({ kind: "clear" });
    expect(parseModelCommand("/model DEFAULT")).toEqual({ kind: "clear" });
  });

  it("does not validate the model name against any list — an unrecognized-looking name is still a valid set (error/no-validation case)", () => {
    expect(parseModelCommand("/model not-a-real-model-xyz")).toEqual({ kind: "set", model: "not-a-real-model-xyz" });
  });

  it("bare '/model' with no argument is a show (boundary case)", () => {
    expect(parseModelCommand("/model")).toEqual({ kind: "show" });
    expect(parseModelCommand("/model   ")).toEqual({ kind: "show" });
  });
});

describe("parsePlanCommand", () => {
  it("parses '/plan on' and '/plan off' (normal case)", () => {
    expect(parsePlanCommand("/plan on")).toBe("on");
    expect(parsePlanCommand("/plan off")).toBe("off");
  });

  it("returns null for an unrecognized argument (error case)", () => {
    expect(parsePlanCommand("/plan maybe")).toBe(null);
  });

  it("bare '/plan' with no argument is a show (boundary case)", () => {
    expect(parsePlanCommand("/plan")).toBe("show");
    expect(parsePlanCommand("/plan  ")).toBe("show");
  });

  it("is case-insensitive on the on/off argument", () => {
    expect(parsePlanCommand("/plan ON")).toBe("on");
    expect(parsePlanCommand("/plan Off")).toBe("off");
  });
});

describe("isPassthrough / passthroughPrompt", () => {
  it("recognizes '//<cmd>' and strips exactly one leading slash (normal case)", () => {
    expect(isPassthrough("//compact")).toBe(true);
    expect(passthroughPrompt("//compact")).toBe("/compact");
  });

  it("'//' alone (empty remainder) is NOT a passthrough (boundary case)", () => {
    expect(isPassthrough("//")).toBe(false);
  });

  it("a single leading slash is not a passthrough (error/non-match case)", () => {
    expect(isPassthrough("/compact")).toBe(false);
    expect(isPassthrough("plain text")).toBe(false);
  });

  it("passthroughPrompt strips verbatim without trimming inner content", () => {
    expect(passthroughPrompt("//  spaced out")).toBe("/  spaced out");
  });
});
