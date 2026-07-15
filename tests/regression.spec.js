// tests/regression.spec.js
//
// Regression suite for the Riverside Q2 Tracker.
// Two kinds of checks:
//   1. Smoke tests  - the app loads, tabs switch, API functions respond, no JS errors.
//   2. Visual diffs - each tab is screenshotted and compared against a committed baseline.
//
// Run locally:      npx playwright test
// Run against a URL: TEST_URL=https://deploy-preview--site.netlify.app npx playwright test
// Update baselines:  npx playwright test --update-snapshots

const { test, expect } = require('@playwright/test');

const TABS = [
  { key: 'themes',       label: 'Themes & Epics', panelId: 'tab-themes' },
  { key: 'portfolio',    label: 'Portfolio',       panelId: 'tab-portfolio' },
  { key: 'charts',       label: 'Charts',          panelId: 'tab-charts' },
  { key: 'qsummary',     label: 'Q Summary',       panelId: 'tab-qsummary' },
  { key: 'bugs',         label: 'Bugs',            panelId: 'tab-bugs' },
  { key: 'settings',     label: 'Settings',        panelId: 'tab-settings' },
];

// Collect console errors on every page so each test can assert against them.
async function collectConsoleErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

test.describe('Smoke tests', () => {
  test('site loads and has the right title', async ({ page }) => {
    const errors = await collectConsoleErrors(page);
    await page.goto('/');
    await expect(page).toHaveTitle(/Riverside Q2 Tracker/);
    await expect(page.locator('.h-title')).toHaveText(/Quarterly Tracker/);
    expect(errors, `Console errors on load:\n${errors.join('\n')}`).toEqual([]);
  });

  test('config function returns Firebase config', async ({ page, request }) => {
    await page.goto('/');
    const res = await request.get('/api/config');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.firebase).toBeTruthy();
    expect(body.firebase.projectId).toBeTruthy();
  });

  test('jira proxy responds for an allowed path', async ({ request }) => {
    const res = await request.get('/api/jira?path=' + encodeURIComponent('/rest/api/3/myself'));
    // 200 (auth ok) or 401 (bad/expired token) both prove the function + proxy path works.
    // A 403 means the allow-list rejected the path, which would be a real regression.
    expect([200, 401]).toContain(res.status());
  });

  test('jira proxy rejects a path outside the allow-list', async ({ request }) => {
    const res = await request.get('/api/jira?path=' + encodeURIComponent('/rest/api/3/user/permission'));
    expect(res.status()).toBe(403);
  });

  for (const tab of TABS) {
    test(`"${tab.label}" tab switches and renders without console errors`, async ({ page }) => {
      const errors = await collectConsoleErrors(page);
      await page.goto('/');
      await page.getByRole('button', { name: tab.label, exact: true }).click();
      await expect(page.locator(`#${tab.panelId}`)).toBeVisible();
      await expect(page.locator(`#${tab.panelId}`)).toHaveClass(/active/);
      // give async Jira/Firebase fetches a moment to resolve or fail
      await page.waitForTimeout(1500);
      expect(errors, `Console errors on "${tab.label}" tab:\n${errors.join('\n')}`).toEqual([]);
    });
  }

  test('Themes/Epics KPI row shows exactly the expected cards (no stray severity card)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#kpi-row .kpi');
    const labels = await page.locator('#kpi-row .kpi .kpi-l').allTextContents();
    expect(labels).toEqual(['Themes', 'Epics', 'Stories', 'Outstanding', 'Done', 'At Risk']);
    // Regression guard: the removed "Severity bugs" card must not reappear.
    await expect(page.locator('.sev-kpi-card')).toHaveCount(0);
  });

  test('Bugs tab loads bug data or an explicit empty state (not a stuck spinner)', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Bugs', exact: true }).click();
    const root = page.locator('#bugs-root');
    await expect(root).toBeVisible();
    await expect(root).not.toContainText('Loading bugs from Jira…', { timeout: 15000 });
  });

  test('Settings tab can reach the Jira connection test', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const btn = page.getByRole('button', { name: 'Test Jira Connection' });
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(page.locator('#jira-test-result')).not.toHaveText('', { timeout: 10000 });
  });
});

test.describe('Visual regression', () => {
  for (const tab of TABS) {
    test(`visual: ${tab.label} tab`, async ({ page }) => {
      await page.goto('/');
      await page.getByRole('button', { name: tab.label, exact: true }).click();
      await expect(page.locator(`#${tab.panelId}`)).toBeVisible();
      // let charts/canvas and async data settle before the screenshot
      await page.waitForTimeout(2000);
      await expect(page).toHaveScreenshot(`${tab.key}-tab.png`, {
        fullPage: true,
        mask: [
          // mask anything that legitimately changes between runs (timestamps, live counts)
          page.locator('#hdr-sub'),
          page.locator('#qbadge-val'),
        ],
      });
    });
  }
});
