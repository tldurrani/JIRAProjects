# Regression testing

This project has an automated regression suite (Playwright) covering:

- **Smoke tests** — the app loads, every tab switches without JS errors, the
  `jira` and `config` Netlify functions respond correctly (including the
  Jira path allow-list), the Bugs tab actually loads data, and a regression
  guard confirms the old "Severity bugs" KPI card never reappears on the
  Themes/Epics tab.
- **Visual regression** — a full-page screenshot of every tab is compared
  pixel-by-pixel against a committed baseline. Anything that visibly shifts
  (layout, colors, a card appearing/disappearing) fails the run and produces
  a diff image.

## Running it

**One-time setup (locally or in CI):**
```bash
npm install
npx playwright install --with-deps chromium
```

**Run against your local dev server:**
```bash
netlify dev &          # or however you normally run this locally
npx playwright test
```

**Run against a live URL** (production, a Netlify deploy preview, etc.):
```bash
TEST_URL=https://your-site.netlify.app npx playwright test
```

**View the HTML report after a run:**
```bash
npm run test:report
```

## Updating the visual baseline

The first run of the visual tests has nothing to compare against, so
Playwright will create the baseline images under
`tests/regression.spec.js-snapshots/`. Commit those images — they're the
"known good" reference going forward.

Whenever you make an *intentional* visual change (new feature, redesign,
etc.), regenerate the baseline and commit the updated images:
```bash
TEST_URL=https://your-site.netlify.app npx playwright test --update-snapshots
git add tests/regression.spec.js-snapshots
git commit -m "Update visual baseline for <change>"
```

## Automatic runs after deploy

`.github/workflows/regression.yml` runs the whole suite automatically once
Netlify reports a successful deploy (this relies on the standard Netlify
GitHub integration, which posts `deployment_status` events with the deployed
URL — no extra webhook setup needed if your site is already connected to
this repo through Netlify's GitHub App).

It also runs on demand: go to **Actions → Regression tests → Run workflow**,
optionally typing in a specific URL (e.g. a deploy preview link). If you
leave the URL blank on a manual run, it falls back to a repo variable named
`PRODUCTION_URL` — set that once under **Settings → Secrets and variables →
Actions → Variables** with your production URL.

Test reports (and, on failure, screenshots/traces/videos) are uploaded as
workflow artifacts you can download from the Actions run page.
