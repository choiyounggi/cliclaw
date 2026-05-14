import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    environment: "node",
    // `__tests__/setup.ts` creates `.claude/tmp/` before any test
    // touches it. CI runners check the repo out fresh and would
    // otherwise fail on the first mkdtempSync.
    setupFiles: ["./__tests__/setup.ts"],
  },
});
