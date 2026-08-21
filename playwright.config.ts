import { defineConfig, devices } from "@playwright/test";

// Some sandboxes ship a pinned Chromium instead of the Playwright-managed
// download; point PLAYWRIGHT_CHROMIUM_EXECUTABLE at it when needed
// (e.g. /opt/pw-browsers/chromium). CI should `npx playwright install chromium`.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // `npm run test:e2e` builds the static export first; this just serves it.
    command: "node e2e/static-server.mjs",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
