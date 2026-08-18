import { describe, it, expect } from "vitest";
import { isNonPrivateChat, ConfigFatalError, isConfigFatalError } from "../lib/chat-policy.ts";

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
