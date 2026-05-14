import { describe, it, expect } from "vitest";
import { renderPlist } from "../lib/launchd.ts";

const BASE = {
  entryTs: "/usr/local/lib/node_modules/@younggichoi/cliclaw/bot.ts",
  bunPath: "/Users/me/.bun/bin/bun",
  cliclawHome: "/Users/me/.cliclaw",
};

describe("renderPlist — base structure", () => {
  it("writes Label, ProgramArguments, and base env vars", () => {
    const out = renderPlist("com.me.cliclaw", BASE);
    expect(out).toContain("<key>Label</key>");
    expect(out).toContain("<string>com.me.cliclaw</string>");
    expect(out).toContain(`<string>${BASE.bunPath}</string>`);
    expect(out).toContain(`<string>${BASE.entryTs}</string>`);
    expect(out).toContain("<key>PATH</key>");
    expect(out).toContain("<key>HOME</key>");
    expect(out).toContain("<key>CLICLAW_HOME</key>");
  });

  it("prepends bun's dir to PATH", () => {
    const out = renderPlist("com.me.cliclaw", BASE);
    expect(out).toMatch(/<string>\/Users\/me\/\.bun\/bin:/);
  });
});

describe("renderPlist — extraEnv", () => {
  it("omits extra env block when no extras given", () => {
    const out = renderPlist("com.me.cliclaw", BASE);
    expect(out).not.toContain("NODE_EXTRA_CA_CERTS");
    // EnvironmentVariables dict ends cleanly right after CLICLAW_HOME.
    expect(out).toMatch(/<key>CLICLAW_HOME<\/key>\s*<string>[^<]+<\/string>\s*<\/dict>/);
  });

  it("writes NODE_EXTRA_CA_CERTS when provided", () => {
    const out = renderPlist("com.me.cliclaw", {
      ...BASE,
      extraEnv: { NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-root.pem" },
    });
    expect(out).toContain("<key>NODE_EXTRA_CA_CERTS</key>");
    expect(out).toContain("<string>/etc/ssl/corp-root.pem</string>");
  });

  it("writes multiple extras in order", () => {
    const out = renderPlist("com.me.cliclaw", {
      ...BASE,
      extraEnv: { A_KEY: "/a", B_KEY: "/b" },
    });
    const aIdx = out.indexOf("A_KEY");
    const bIdx = out.indexOf("B_KEY");
    expect(aIdx).toBeGreaterThan(0);
    expect(bIdx).toBeGreaterThan(aIdx);
  });

  it("escapes XML metacharacters in extra env values", () => {
    const out = renderPlist("com.me.cliclaw", {
      ...BASE,
      extraEnv: { WEIRD: "<one> & </two>" },
    });
    expect(out).toContain("&lt;one&gt; &amp; &lt;/two&gt;");
    expect(out).not.toContain("<one>");
  });
});
