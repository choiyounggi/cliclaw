/// <reference types="node" />
/**
 * Pixel-style banner shown at the top of interactive `cliclaw` commands.
 *
 * The art was generated with the "ANSI Shadow" font (same family Claude
 * Code uses) and embedded inline so the package has zero runtime deps.
 * Output is gated on `process.stdout.isTTY` so we never write escape codes
 * into a piped log file or launchd's bot.log.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// One block of art per row, joined with newlines at print time so it's
// trivial to swap fonts later without re-escaping a multiline template.
const ART = [
  " ██████╗██╗     ██╗ ██████╗██╗      █████╗ ██╗    ██╗",
  "██╔════╝██║     ██║██╔════╝██║     ██╔══██╗██║    ██║",
  "██║     ██║     ██║██║     ██║     ███████║██║ █╗ ██║",
  "██║     ██║     ██║██║     ██║     ██╔══██║██║███╗██║",
  "╚██████╗███████╗██║╚██████╗███████╗██║  ██║╚███╔███╔╝",
  " ╚═════╝╚══════╝╚═╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ",
];

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
// 6-step blue → cyan gradient applied row by row so the art reads like one
// solid mark rather than a striped rainbow.
const GRADIENT = [
  "\x1b[38;5;75m",
  "\x1b[38;5;81m",
  "\x1b[38;5;87m",
  "\x1b[38;5;87m",
  "\x1b[38;5;81m",
  "\x1b[38;5;75m",
];

function colorize(line: string, idx: number): string {
  return `${GRADIENT[idx] ?? ""}${line}${RESET}`;
}

function readVersion(rootDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "?";
  } catch {
    return "?";
  }
}

export function printBanner(metaUrl: string): void {
  // Caller is expected to suppress the banner for non-interactive entry
  // points (the bot daemon under launchd, etc.) by simply not calling
  // printBanner there. We intentionally do NOT gate on stdout.isTTY: when
  // users run `cliclaw doctor` through pipes (`| less`, `| pbcopy`) they
  // still want the visual identity, and ANSI escapes are widely tolerated.
  const rootDir = dirname(new URL(metaUrl).pathname);
  const version = readVersion(rootDir);

  process.stdout.write("\n");
  for (let i = 0; i < ART.length; i++) {
    process.stdout.write("  " + colorize(ART[i], i) + "\n");
  }
  process.stdout.write("\n");
  process.stdout.write(
    `  ${BOLD}Telegram bridge for local coding CLIs${RESET} ` +
      `${DIM}— Claude Code · Codex · Pi${RESET}\n`,
  );
  process.stdout.write(
    `  ${DIM}v${version}  ·  https://github.com/choiyounggi/cliclaw${RESET}\n\n`,
  );
}
