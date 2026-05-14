/**
 * Vitest setup hook: ensure `<repo>/.claude/tmp/` exists before any
 * test runs. Most tests in this repo park their per-case scratch
 * directories there (via `mkdtempSync(join(cwd, ".claude/tmp/..."))`)
 * because the host's security policy forbids writes under /tmp.
 *
 * Locally `.claude/tmp/` accumulates naturally, but CI checkouts start
 * empty and `mkdtempSync` errors out with ENOENT — surfacing as the
 * media-download / hook-installer test failures seen on macos-latest.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

mkdirSync(join(process.cwd(), ".claude", "tmp"), { recursive: true });
