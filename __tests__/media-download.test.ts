import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeMediaPath, inferExtension, downloadTelegramFile } from "../lib/media-download.ts";

describe("makeMediaPath", () => {
  it("composes chat-scoped path with sanitized extension", () => {
    const p = makeMediaPath("/tmp/uploads", 42, 7, "jpg");
    expect(p).toBe("/tmp/uploads/42/7.jpg");
  });

  it("strips non-alphanumerics from extension and truncates to 8 chars", () => {
    // "../../etc/passwd" → strip non-alnum → "etcpasswd" → truncate to 8 → "etcpassw"
    expect(makeMediaPath("/u", 1, 2, "../../etc/passwd")).toBe("/u/1/2.etcpassw");
    expect(makeMediaPath("/u", 1, 2, "j/p/g")).toBe("/u/1/2.jpg");
  });

  it("falls back to 'bin' when extension empty after sanitization", () => {
    expect(makeMediaPath("/u", 1, 2, "")).toBe("/u/1/2.bin");
    expect(makeMediaPath("/u", 1, 2, "%%%")).toBe("/u/1/2.bin");
  });

  it("truncates long extensions", () => {
    expect(makeMediaPath("/u", 1, 2, "verylongextension")).toBe("/u/1/2.verylong");
  });
});

describe("inferExtension", () => {
  it("prefers the filename extension when present", () => {
    expect(inferExtension("photo.png")).toBe("png");
    expect(inferExtension("doc.PDF", "application/octet-stream")).toBe("PDF");
  });
  it("falls back to MIME subtype", () => {
    expect(inferExtension(undefined, "image/jpeg")).toBe("jpeg");
    expect(inferExtension(undefined, "application/pdf")).toBe("pdf");
  });
  it("strips MIME charset parameters", () => {
    expect(inferExtension(undefined, "text/plain;charset=utf-8")).toBe("plain");
  });
  it("returns 'bin' when nothing is known", () => {
    expect(inferExtension()).toBe("bin");
    expect(inferExtension("noext")).toBe("bin");
  });
});

describe("downloadTelegramFile", () => {
  it("downloads and writes the file bytes to outputPath", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".claude/tmp/media-test-"));
    const outputPath = join(dir, "img.jpg");
    const body = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]); // tiny "JPEG"
    const fakeFetch = async (input: string): Promise<Response> => {
      // Only the CDN download URL hits the fetch path; getFile is injected separately.
      const url = String(input);
      if (url.includes("/file/bot")) {
        return new Response(body, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const r = await downloadTelegramFile({
      token: "TEST",
      fileId: "fid1",
      outputPath,
      fetchImpl: fakeFetch,
      getFile: async () => ({ file_id: "fid1", file_unique_id: "u", file_size: body.length, file_path: "photos/x.jpg" }),
    });
    expect(r.path).toBe(outputPath);
    expect(r.size).toBe(body.length);
    expect(existsSync(outputPath)).toBe(true);
    expect(Array.from(readFileSync(outputPath))).toEqual(Array.from(body));
  });

  it("rejects when the reported size exceeds maxBytes", async () => {
    await expect(
      downloadTelegramFile({
        token: "TEST",
        fileId: "fid",
        outputPath: join(process.cwd(), ".claude/tmp/_should-not-exist"),
        maxBytes: 100,
        fetchImpl: async () => new Response(),
        getFile: async () => ({ file_id: "fid", file_unique_id: "u", file_size: 1000, file_path: "x" }),
      }),
    ).rejects.toThrow(/too large/);
  });

  it("rejects when getFile returns no file_path", async () => {
    await expect(
      downloadTelegramFile({
        token: "TEST",
        fileId: "fid",
        outputPath: join(process.cwd(), ".claude/tmp/_x"),
        fetchImpl: async () => new Response(),
        getFile: async () => ({ file_id: "fid", file_unique_id: "u" }),
      }),
    ).rejects.toThrow(/no file_path/);
  });

  it("rejects when the CDN download returns non-2xx", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".claude/tmp/media-test-"));
    await expect(
      downloadTelegramFile({
        token: "TEST",
        fileId: "fid",
        outputPath: join(dir, "x.jpg"),
        fetchImpl: async () => new Response("", { status: 503 }),
        getFile: async () => ({ file_id: "fid", file_unique_id: "u", file_path: "x" }),
      }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("creates the parent directory if missing", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".claude/tmp/media-test-"));
    const outputPath = join(dir, "deep/nested/subdir/img.jpg");
    await downloadTelegramFile({
      token: "TEST",
      fileId: "fid",
      outputPath,
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3])),
      getFile: async () => ({ file_id: "fid", file_unique_id: "u", file_path: "x" }),
    });
    expect(existsSync(outputPath)).toBe(true);
  });
});
