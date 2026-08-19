import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readVersion } from "../lib/banner.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+$/;

function runCli(arg: string): string {
  return execFileSync(process.execPath, ["run", join(ROOT, "cli.ts"), arg], {
    encoding: "utf8",
    timeout: 15000,
  }).trim();
}

describe("cliclaw version command", () => {
  it("`--version` prints the bare package version (no banner)", () => {
    const out = runCli("--version");
    expect(out).toMatch(SEMVER);
    expect(out).toBe(readVersion(ROOT));
  });

  it("`version` and `-v` aliases print the same version", () => {
    const version = readVersion(ROOT);
    expect(runCli("version")).toBe(version);
    expect(runCli("-v")).toBe(version);
  });

  it("readVersion falls back to '?' when package.json is missing", () => {
    expect(readVersion("/nonexistent-dir-for-cliclaw-test")).toBe("?");
  });
});
