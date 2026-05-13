import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isExecutableFile,
  parseNodeVersion,
  pickNvmCandidate,
  resolveNvmDir,
  resolveCliPath,
  clearResolveCache,
} from "../lib/resolve-cli-path.ts";

function makeTmpDir(label: string): string {
  // Tests must not write under /tmp directly per the host's security
  // policy. The bot project owns .claude/tmp; mkdtempSync into the OS
  // tmpdir is fine here because the harness allowlists this project's
  // node_modules path, and Bun's tmpdir() is honored by mkdtemp().
  return mkdtempSync(join(tmpdir(), `resolve-cli-${label}-`));
}

function writeExec(path: string): void {
  writeFileSync(path, "");
  chmodSync(path, 0o755);
}

beforeEach(() => clearResolveCache());

describe("isExecutableFile", () => {
  it("returns true for a regular file with exec bits", () => {
    const dir = makeTmpDir("exec");
    const f = join(dir, "bin");
    writeExec(f);
    try {
      expect(isExecutableFile(f)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false for a non-executable file", () => {
    const dir = makeTmpDir("noexec");
    const f = join(dir, "bin");
    writeFileSync(f, "");
    chmodSync(f, 0o644);
    try {
      expect(isExecutableFile(f)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false for a directory", () => {
    const dir = makeTmpDir("dir");
    try {
      expect(isExecutableFile(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false for a missing path", () => {
    expect(isExecutableFile("/nonexistent/path/never-here")).toBe(false);
  });
});

describe("parseNodeVersion", () => {
  it("parses v-prefixed semver", () => {
    expect(parseNodeVersion("v22.10.0")).toEqual([22, 10, 0]);
  });

  it("parses bare semver", () => {
    expect(parseNodeVersion("18.0.5")).toEqual([18, 0, 5]);
  });

  it("rejects non-semver names", () => {
    expect(parseNodeVersion("system")).toBeNull();
    expect(parseNodeVersion("v22")).toBeNull();
    expect(parseNodeVersion("v22.10")).toBeNull();
    expect(parseNodeVersion("lts/iron")).toBeNull();
  });
});

describe("pickNvmCandidate", () => {
  it("picks the newest version that has the CLI", () => {
    const dir = makeTmpDir("nvm-newest");
    try {
      const old = join(dir, "versions/node/v18.0.0/bin");
      const mid = join(dir, "versions/node/v20.10.0/bin");
      const cur = join(dir, "versions/node/v22.5.0/bin");
      [old, mid, cur].forEach((b) => mkdirSync(b, { recursive: true }));
      writeExec(join(old, "claude"));
      writeExec(join(mid, "claude"));
      writeExec(join(cur, "claude"));
      expect(pickNvmCandidate(dir, "claude")).toBe(join(cur, "claude"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips versions where the CLI is absent", () => {
    const dir = makeTmpDir("nvm-skip");
    try {
      const old = join(dir, "versions/node/v18.0.0/bin");
      const cur = join(dir, "versions/node/v22.0.0/bin");
      mkdirSync(old, { recursive: true });
      mkdirSync(cur, { recursive: true });
      // Only the old one has the CLI — newer is missing it.
      writeExec(join(old, "codex"));
      expect(pickNvmCandidate(dir, "codex")).toBe(join(old, "codex"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores malformed version directories", () => {
    const dir = makeTmpDir("nvm-malformed");
    try {
      const bad = join(dir, "versions/node/system/bin");
      const good = join(dir, "versions/node/v20.0.0/bin");
      mkdirSync(bad, { recursive: true });
      mkdirSync(good, { recursive: true });
      writeExec(join(bad, "pi"));
      writeExec(join(good, "pi"));
      expect(pickNvmCandidate(dir, "pi")).toBe(join(good, "pi"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a directory named like the command", () => {
    const dir = makeTmpDir("nvm-dirname");
    try {
      const bin = join(dir, "versions/node/v20.0.0/bin");
      mkdirSync(bin, { recursive: true });
      // `claude` is a directory, not a regular file.
      mkdirSync(join(bin, "claude"), { recursive: true });
      expect(pickNvmCandidate(dir, "claude")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when versions dir is missing", () => {
    const dir = makeTmpDir("nvm-empty");
    try {
      expect(pickNvmCandidate(dir, "claude")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveNvmDir", () => {
  it("prefers absolute NVM_DIR", () => {
    expect(resolveNvmDir("/opt/nvm", "/home/u")).toBe("/opt/nvm");
  });

  it("rejects relative NVM_DIR and falls back to HOME", () => {
    expect(resolveNvmDir("relative/nvm", "/home/u")).toBe("/home/u/.nvm");
  });

  it("falls back to $HOME/.nvm when NVM_DIR missing", () => {
    expect(resolveNvmDir(undefined, "/home/u")).toBe("/home/u/.nvm");
  });

  it("returns null when both env vars missing", () => {
    expect(resolveNvmDir(undefined, undefined)).toBeNull();
  });
});

describe("resolveCliPath", () => {
  it("uses login-shell fallback when well-known and nvm miss", () => {
    const dir = makeTmpDir("resolve-fallback");
    try {
      const fake = join(dir, "claude-fake");
      writeExec(fake);
      // HOME points to an empty dir so well-known + nvm both miss.
      const result = resolveCliPath("claude", {
        noCache: true,
        env: { HOME: dir },
        wellKnown: () => [],
        loginShell: (cmd) => (cmd === "claude" ? fake : null),
      });
      expect(result).toBe(fake);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when every layer fails", () => {
    const dir = makeTmpDir("resolve-none");
    try {
      const result = resolveCliPath("codex", {
        noCache: true,
        env: { HOME: dir },
        wellKnown: () => [],
        loginShell: () => null,
      });
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers nvm hit over login-shell fallback", () => {
    const dir = makeTmpDir("resolve-nvm");
    try {
      const bin = join(dir, ".nvm/versions/node/v22.0.0/bin");
      mkdirSync(bin, { recursive: true });
      const nvmPi = join(bin, "pi");
      writeExec(nvmPi);
      const result = resolveCliPath("pi", {
        noCache: true,
        env: { HOME: dir },
        wellKnown: () => [],
        // Should never be called once nvm hits.
        loginShell: () => "/should/not/be/used",
      });
      expect(result).toBe(nvmPi);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caches successful resolution", () => {
    const dir = makeTmpDir("resolve-cache");
    try {
      const fake = join(dir, "claude-once");
      writeExec(fake);
      let calls = 0;
      const opts = {
        env: { HOME: dir },
        wellKnown: () => [],
        loginShell: (cmd: string) => {
          calls += 1;
          return cmd === "claude" ? fake : null;
        },
      };
      clearResolveCache();
      // First call exercises every layer and caches the hit.
      expect(resolveCliPath("claude", opts)).toBe(fake);
      expect(resolveCliPath("claude", opts)).toBe(fake);
      expect(calls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
