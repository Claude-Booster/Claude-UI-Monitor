// UI snapshot baseline tests — uses Playwright toHaveScreenshot() for regression detection.
// First run:  node_modules/.bin/playwright test --update-snapshots  (creates baselines)
// Next runs:  node_modules/.bin/playwright test                     (compares against baselines)
// Baselines stored in: ~/.claude/ui-screenshots/baselines/
const { test, expect } = require('@playwright/test');
const { AxeBuilder }   = require('@axe-core/playwright');
const fs   = require('fs');
const path = require('path');
const net  = require('net');

// All ports from the registry — single source of truth
const registryPath = path.join(process.env.USERPROFILE, '.claude', 'framework-registry.json');

let registry;
try {
  registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
} catch (err) {
  throw new Error(`Failed to load framework-registry.json at ${registryPath}: ${err.message}`);
}

// Build port→frameworkName map for readable test names
const portFrameworkMap = {};
for (const fw of registry.frameworks) {
  for (const p of fw.ports) {
    if (!portFrameworkMap[p]) portFrameworkMap[p] = fw.name;
  }
}

const ALL_PORTS = [...new Set(registry.frameworks.flatMap(f => f.ports.map(Number)))];

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800  },
  { name: 'mobile',  width: 390,  height: 844  },
  { name: 'tablet',  width: 768,  height: 1024 },
];

// Python-based frameworks need extra time to render beyond domcontentloaded
const SLOW_PORTS  = new Set([8501, 5000, 5001, 8050, 7860, 8765, 2718]);
const NAV_TIMEOUT = 30000;

function probePort(port) {
  return new Promise(resolve => {
    const s = net.createConnection({ port, host: '127.0.0.1' });
    s.setTimeout(200);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error',   () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

for (const port of ALL_PORTS) {
  const frameworkName = portFrameworkMap[port] || `port-${port}`;

  for (const vp of VIEWPORTS) {
    // Include framework name in test title for readable failure messages
    test(`${frameworkName} (${port}) @ ${vp.name} ${vp.width}x${vp.height}`, async ({ page }) => {
      const isLive = await probePort(port);
      test.skip(!isLive, `Port ${port} not live`);

      // Python servers need extra settle time after domcontentloaded
      const waitUntil = SLOW_PORTS.has(port) ? 'networkidle' : 'domcontentloaded';

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`http://localhost:${port}`, { waitUntil, timeout: NAV_TIMEOUT });

      // Visual regression baseline
      await expect(page).toHaveScreenshot(`${port}-${vp.name}.png`, { maxDiffPixelRatio: 0.02 });

      // Accessibility audit — separate assertion so visual pass/fail is independent of a11y
      if (vp.name === 'desktop') {
        const a11y     = await new AxeBuilder({ page }).analyze();
        const critical = a11y.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
        if (critical.length > 0) {
          const summary = critical.map(v => `[${v.impact}] ${v.id}: ${v.description}`).join('\n');
          console.warn(`\nA11y violations on localhost:${port} (${frameworkName}):\n${summary}`);
        }
        expect(critical, `Critical/serious a11y violations on ${frameworkName} localhost:${port}`).toHaveLength(0);
      }
    });
  }
}
