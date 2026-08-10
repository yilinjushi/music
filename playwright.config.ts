import { chromium, defineConfig, devices } from "@playwright/test";
import { assertPlaywrightRunLockHeld } from "./scripts/playwright-evidence-lock.mjs";

// The package wrapper acquires the lock before Playwright starts. Config
// evaluation fails closed if somebody bypasses that wrapper, including --list.
assertPlaywrightRunLockHeld();

const baseUse = {
  browserName: "chromium" as const,
  hasTouch: true,
  isMobile: true,
  userAgent: devices["Pixel 7"].userAgent,
  deviceScaleFactor: 2,
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai",
  serviceWorkers: "allow" as const,
};

const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
const evidenceMode = process.env.PLAYWRIGHT_EVIDENCE === "1";
const reuseExistingServer = !process.env.CI && !evidenceMode;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "artifacts/playwright-results",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  metadata: { evidenceMode, reuseExistingServer },
  // The service-worker update contract temporarily swaps the built /sw.js
  // bytes and restores them after the waiting worker is installed. A single
  // worker keeps that production-faithful lifecycle isolated from other pages.
  workers: 1,
  reporter: [
    ["line"],
    ["junit", { outputFile: "artifacts/playwright-junit.xml" }],
    ["html", { outputFolder: "artifacts/playwright-report", open: "never" }],
    ["./scripts/playwright-evidence-reporter.mjs"],
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
    // Playwright's default headless launcher prefers the optional
    // chromium-headless-shell artifact. CI and constrained development
    // environments install the full, version-pinned Chromium binary, so bind
    // that exact executable and let Chromium use its native headless mode.
    launchOptions: { executablePath: chromiumExecutablePath },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Video is diagnostic-only. Constrained local runners can execute the
    // complete behavioral suite without Playwright's separate ffmpeg artifact;
    // CI keeps failure videos enabled by default.
    video:
      process.env.PLAYWRIGHT_DISABLE_VIDEO === "1"
        ? "off"
        : "retain-on-failure",
  },
  projects: [
    {
      name: "mobile-360x640",
      use: { ...baseUse, viewport: { width: 360, height: 640 } },
    },
    {
      name: "mobile-390x844",
      use: { ...baseUse, viewport: { width: 390, height: 844 } },
    },
    {
      name: "mobile-412x915",
      use: { ...baseUse, viewport: { width: 412, height: 915 } },
    },
    {
      name: "mobile-landscape-844x390",
      use: { ...baseUse, viewport: { width: 844, height: 390 } },
    },
  ],
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173/search",
    // Evidence must start the server for the candidate under test. Reusing an
    // arbitrary process on the same port would make A's browser output look
    // like B's evidence even if every artifact hash were otherwise correct.
    reuseExistingServer,
    timeout: 30_000,
  },
});
