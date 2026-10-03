const { chromium } = require('playwright');
const path = require('path');

const url = process.argv[2];
const ssDir = process.argv[3];
const ts = process.argv[4];

if (!url || !ssDir || !ts) {
  process.stderr.write('Usage: node theme-gallery-review.js <url> <ssDir> <timestamp>\n');
  process.exit(1);
}

// Click the rail item for a theme key. Returns true only if a click actually
// succeeded — callers rely on this to decide whether to use the keyboard fallback.
async function clickTheme(page, key) {
  const items = await page.$$(`[data-theme="${key}"]`);
  for (const item of items) {
    const tag = await item.evaluate(el => el.tagName.toLowerCase());
    if (tag === 'li' || tag === 'div' || tag === 'button' || tag === 'a') {
      try {
        await item.click();
        return true;
      } catch {
        // element matched but wasn't clickable — try the next match
      }
    }
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });

    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const themes = [
      { key: 1, name: 'midway-neon' },
      { key: 2, name: 'velocity-red' },
      { key: 3, name: 'park-map' },
      { key: 4, name: 'control-room' },
      { key: 5, name: 'candy-cotton' },
      { key: 6, name: 'cosmic-coaster' },
    ];

    for (const theme of themes) {
      // Prefer clicking the rail item; only fall back to the keyboard shortcut
      // when the click did not actually land.
      let method = 'click';
      if (!(await clickTheme(page, theme.key))) {
        const keys = ['1', '2', '3', '4', '5', '6'];
        await page.keyboard.press(keys[theme.key - 1]);
        method = 'key';
      }
      await page.waitForTimeout(1000);

      const outPath = path.join(ssDir, `stellar-spin-${theme.name}-${ts}.png`);
      await page.screenshot({ path: outPath, fullPage: false });
      process.stdout.write(JSON.stringify({ theme: theme.name, ok: true, method }) + '\n');
    }

    // Scroll down in the active preview to see ticket prices / FAQ. First go back
    // to theme 1 (reuses the same click logic as the main loop).
    await clickTheme(page, 1);
    await page.waitForTimeout(800);

    // Scroll the stage/preview area
    await page.evaluate(() => {
      const candidates = [
        document.querySelector('.g-stage'),
        document.querySelector('.stage'),
        document.querySelector('.preview-area'),
        document.querySelector('main'),
      ];
      const el = candidates.find(Boolean);
      if (el) el.scrollTop = 800;
      else window.scrollTo(0, 800);
    });
    await page.waitForTimeout(500);
    const scrolledPath = path.join(ssDir, `stellar-spin-content-scroll-${ts}.png`);
    await page.screenshot({ path: scrolledPath, fullPage: false });
    process.stdout.write(JSON.stringify({ theme: 'scrolled-content', ok: true }) + '\n');

    process.stdout.write(JSON.stringify({ consoleErrors }) + '\n');
  } finally {
    await browser.close();
  }
})();
