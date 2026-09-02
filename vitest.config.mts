import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Playwright specs live in e2e/ and must not be picked up by vitest.
    // *.verify.test.ts files hit live production endpoints for manual QA and
    // must not gate CI (see tests/live-cms-kpi.verify.test.ts).
    exclude: [
      "**/node_modules/**",
      "e2e/**",
      "archive/**",
      "backup/**",
      "out/**",
      "**/*.verify.test.ts",
    ],
  },
});
