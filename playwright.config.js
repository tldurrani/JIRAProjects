// playwright.config.js
// Regression suite for the Riverside Q2 Tracker.
// Target URL comes from TEST_URL env var so the same suite can run against
// a Netlify deploy-preview, production, or localhost.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 45_000,
  expect: {
    timeout: 10_000,
    // How different a pixel can be (0-1) before it's counted as "changed".
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, threshold: 0.25 },
  },
  fullyParallel: false, // the app shares Firebase/Jira state across tabs; run serially
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'tests/report', open: 'never' }],
  ],
  use: {
    baseURL: process.env.TEST_URL || 'http://localhost:8888',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
});
