import { defineConfig } from "vitest/config";

// Standalone config for manually running the disposable live-diagnostic
// *.verify.test.ts specs against deployed production endpoints. These are
// excluded from the default `npm test` / CI run (see vitest.config.mts)
// because they depend on live external service state.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.verify.test.ts"],
    exclude: ["**/node_modules/**", "e2e/**", "archive/**", "backup/**", "out/**"],
  },
});
