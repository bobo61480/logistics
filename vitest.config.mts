import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Playwright specs live in e2e/ and must not be picked up by vitest.
    exclude: ["**/node_modules/**", "e2e/**", "archive/**", "backup/**", "out/**"],
  },
});
