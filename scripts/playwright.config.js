// Playwright config for UI snapshot baseline tests.
// Run:  npm run snapshots              → compare against baselines
//       npm run snapshots:update       → create/refresh baselines
//       npm run snapshots:report       → open HTML report
const { defineConfig } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
  testDir:   __dirname,
  testMatch: '**/snapshot.spec.js',
  snapshotDir: path.join(process.env.USERPROFILE, '.claude', 'ui-screenshots', 'baselines'),
  timeout:   45_000,   // Python servers (Streamlit, Flask) can take >30 s to fully render
  workers:   3,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: path.join(process.env.USERPROFILE, '.claude', 'ui-screenshots', 'report') }],
    ['json', { outputFile: path.join(process.env.USERPROFILE, '.claude', 'ui-screenshots', 'test-results.json') }],
  ],
  use: {
    headless:           true,
    actionTimeout:      15_000,
    navigationTimeout:  30_000,
  },
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
      animations:        'disabled',
    },
  },
});
