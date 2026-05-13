/// <reference types="node" />
/**
 * Download a Telegram file (photo or document) to a local path.
 *
 * Telegram's API doesn't stream files directly: we first call `getFile` to
 * obtain a `file_path`, then GET it from the file CDN. The bot token is in
 * the URL — never log the full URL.
 *
 * Pure path/extension helpers are exported separately so they can be unit-
 * tested without making network calls.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface TgFileResult {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

/** Minimum fetch shape used by this module — keeps fetchImpl injectable in tests
 *  without dragging the full lib.dom `typeof fetch` signature (Bun adds extras
 *  like `preconnect` that don't matter here). */
export type FetchLike = (input: string) => Promise<Response>;

export interface DownloadOptions {
  /** Bot token — used to build the file CDN URL. Treated as secret. */
  token: string;
  /** Telegram file_id from a photo/document message. */
  fileId: string;
  /** Where to write the downloaded bytes. */
  outputPath: string;
  /** Max bytes accepted. Default 20MB (Telegram bot API hard cap). */
  maxBytes?: number;
  /** Override the `getFile` call — injectable for tests. */
  getFile?: (fileId: string) => Promise<TgFileResult>;
  /** Override fetch — injectable for tests. */
  fetchImpl?: FetchLike;
}

const TG_API = "https://api.telegram.org";
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20MB

/**
 * Compute a safe local path. The extension is sanitized (alphanumerics only,
 * truncated). Slashes inside the file_name are stripped so user-supplied
 * names can't escape the chat-scoped uploads dir.
 */
export function makeMediaPath(uploadsRoot: string, chatId: number, messageId: number, ext: string): string {
  const safeExt = ext.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "bin";
  return join(uploadsRoot, String(chatId), `${messageId}.${safeExt}`);
}

/** Pull a file extension from a Telegram document filename or mime type. */
export function inferExtension(fileName?: string, mimeType?: string): string {
  if (fileName) {
    const dot = fileName.lastIndexOf(".");
    if (dot !== -1 && dot < fileName.length - 1) {
      return fileName.slice(dot + 1);
    }
  }
  if (mimeType) {
    // image/jpeg → jpeg, image/png → png, application/pdf → pdf
    const slash = mimeType.indexOf("/");
    if (slash !== -1) return mimeType.slice(slash + 1).split(";")[0].trim();
  }
  return "bin";
}

export async function downloadTelegramFile(opts: DownloadOptions): Promise<{ path: string; size: number }> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input: string) => fetch(input));

  const getFile = opts.getFile ?? (async (fileId: string): Promise<TgFileResult> => {
    const res = await fetchImpl(`${TG_API}/bot${opts.token}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const data = await res.json() as { ok: boolean; result?: TgFileResult; description?: string };
    if (!data.ok || !data.result) throw new Error(`getFile failed: ${data.description ?? "no result"}`);
    return data.result;
  });

  const file = await getFile(opts.fileId);
  if (!file.file_path) throw new Error("getFile returned no file_path");
  if (typeof file.file_size === "number" && file.file_size > maxBytes) {
    throw new Error(`file too large: ${file.file_size}B > ${maxBytes}B cap`);
  }

  const url = `${TG_API}/file/bot${opts.token}/${file.file_path}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`download exceeded cap: ${buf.length}B > ${maxBytes}B`);

  mkdirSync(dirname(opts.outputPath), { recursive: true });
  writeFileSync(opts.outputPath, buf);
  return { path: opts.outputPath, size: buf.length };
}
