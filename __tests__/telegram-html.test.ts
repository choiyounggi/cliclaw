import { describe, it, expect } from "vitest";
import { markdownToTelegramHtml, autoCloseUnfinished, escapeHtml } from "../lib/telegram-html.ts";

describe("escapeHtml", () => {
  it("escapes & < > but leaves other chars alone", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    expect(escapeHtml("plain")).toBe("plain");
  });
});

describe("markdownToTelegramHtml — bold / italic / strike", () => {
  it("converts **bold** to <b>", () => {
    expect(markdownToTelegramHtml("hello **world** ok")).toBe("hello <b>world</b> ok");
  });
  it("converts __bold__ to <b>", () => {
    expect(markdownToTelegramHtml("__strong__")).toBe("<b>strong</b>");
  });
  it("converts *italic* and _italic_ to <i>", () => {
    expect(markdownToTelegramHtml("a *quick* brown")).toBe("a <i>quick</i> brown");
    expect(markdownToTelegramHtml("a _slow_ tortoise")).toBe("a <i>slow</i> tortoise");
  });
  it("does not mangle bold when emphasized inside (**not _both_**)", () => {
    // Bold first, italic inside should still work.
    const out = markdownToTelegramHtml("**bold _and_ italic**");
    expect(out).toBe("<b>bold <i>and</i> italic</b>");
  });
  it("converts ~~strike~~ to <s>", () => {
    expect(markdownToTelegramHtml("a ~~bad~~ b")).toBe("a <s>bad</s> b");
  });
});

describe("markdownToTelegramHtml — code", () => {
  it("converts inline `code` to <code> and escapes within", () => {
    expect(markdownToTelegramHtml("set `a < b && c > d`")).toBe('set <code>a &lt; b &amp;&amp; c &gt; d</code>');
  });
  it("converts a code fence to <pre><code> with language class", () => {
    const md = "before\n```ts\nconst x = 1;\n```\nafter";
    const out = markdownToTelegramHtml(md);
    expect(out).toContain('<pre><code class="language-ts">const x = 1;\n</code></pre>');
    expect(out.startsWith("before\n")).toBe(true);
    expect(out.endsWith("\nafter")).toBe(true);
  });
  it("does NOT format markdown inside code fences", () => {
    const md = "```\n**not bold** and *not italic*\n```";
    const out = markdownToTelegramHtml(md);
    expect(out).toContain("**not bold**");
    expect(out).toContain("*not italic*");
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("<i>");
  });
  it("escapes HTML special chars inside code", () => {
    const out = markdownToTelegramHtml("```\n<script>alert(1)</script>\n```");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("markdownToTelegramHtml — headers / lists / blockquote / hr", () => {
  it("turns headers into <b>", () => {
    expect(markdownToTelegramHtml("# Title")).toBe("<b>Title</b>");
    expect(markdownToTelegramHtml("### Sub")).toBe("<b>Sub</b>");
  });
  it("preserves bullet structure with •", () => {
    const out = markdownToTelegramHtml("- one\n- two\n  - nested");
    expect(out).toBe("• one\n• two\n  • nested");
  });
  it("preserves ordered list numbers", () => {
    const out = markdownToTelegramHtml("1. first\n2. second");
    expect(out).toBe("1. first\n2. second");
  });
  it("groups consecutive blockquote lines into one <blockquote>", () => {
    const out = markdownToTelegramHtml("> a\n> b\n\nplain");
    expect(out).toContain("<blockquote>a\nb</blockquote>");
    expect(out).toContain("plain");
  });
  it("renders --- as a horizontal rule", () => {
    expect(markdownToTelegramHtml("hi\n\n---\n\nbye")).toContain("—".repeat(20));
  });
});

describe("markdownToTelegramHtml — links", () => {
  it("converts [text](url) to <a>", () => {
    expect(markdownToTelegramHtml("see [docs](https://example.com)")).toBe(
      'see <a href="https://example.com">docs</a>',
    );
  });
  it("escapes URL attribute", () => {
    expect(markdownToTelegramHtml('see [link](https://example.com/?x="y")')).toContain(
      'href="https://example.com/?x=&quot;y&quot;"',
    );
  });
});

describe("markdownToTelegramHtml — HTML escaping in prose", () => {
  it("escapes loose <, >, & in non-code text", () => {
    const out = markdownToTelegramHtml("if a < b && c > d, then ok");
    expect(out).toBe("if a &lt; b &amp;&amp; c &gt; d, then ok");
  });
  it("does not double-escape what was already converted to tags", () => {
    const out = markdownToTelegramHtml("**a < b**");
    expect(out).toBe("<b>a &lt; b</b>");
  });
});

describe("markdownToTelegramHtml — tables", () => {
  it("renders a GFM table as monospace text in <pre>", () => {
    const md = [
      "| col1 | col2 |",
      "|------|------|",
      "| a    | b    |",
      "| ccc  | dd   |",
    ].join("\n");
    const out = markdownToTelegramHtml(md);
    expect(out).toMatch(/<pre>[\s\S]*col1[\s\S]*col2[\s\S]*<\/pre>/);
    // Padded so that 'a' and 'ccc' line up the right column.
    expect(out).toContain("col1");
    expect(out).toContain("ccc");
  });
  it("ignores something that looks like a table but isn't (no separator row)", () => {
    const md = "| a | b |\n| c | d |";
    const out = markdownToTelegramHtml(md);
    expect(out).not.toContain("<pre>");
  });
});

describe("autoCloseUnfinished", () => {
  it("appends closing fence when an opening one is unmatched", () => {
    expect(autoCloseUnfinished("hello\n```ts\nconst x = 1")).toBe("hello\n```ts\nconst x = 1\n```");
  });
  it("leaves balanced text alone", () => {
    expect(autoCloseUnfinished("```\ncode\n```")).toBe("```\ncode\n```");
  });
  it("returns the input untouched when no fence at all", () => {
    expect(autoCloseUnfinished("just text")).toBe("just text");
  });
});

describe("markdownToTelegramHtml — combined regression cases", () => {
  it("handles a typical Claude-style answer with bold + table + code", () => {
    const md = [
      "**나** |----| 이런 거",
      "",
      "| 항목 | 값 |",
      "|------|-----|",
      "| a    | 1  |",
      "",
      "코드: `value` 그리고",
      "```",
      "code\n",
      "```",
    ].join("\n");
    const out = markdownToTelegramHtml(md);
    expect(out).toContain("<b>나</b>");
    expect(out).toContain("<pre>");           // table rendered
    expect(out).toContain("<code>value</code>");
    expect(out).toContain("<pre><code>code\n");
  });

  it("escapes accidental <script> tags inside prose", () => {
    expect(markdownToTelegramHtml("hi <script>alert(1)</script>")).toBe("hi &lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("empty / null input returns empty string", () => {
    expect(markdownToTelegramHtml("")).toBe("");
  });
});
