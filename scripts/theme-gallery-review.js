const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  
  const url = process.argv[2];
  const ssDir = process.argv[3];
  const ts = process.argv[4];
  
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
    // Try clicking rail item by data-theme attribute
    const selector = `[data-theme="${theme.key}"]`;
    const items = await page.$$(selector);
    let clicked = false;
    for (const item of items) {
      const tag = await item.evaluate(el => el.tagName.toLowerCase());
      if (tag === 'li' || tag === 'div' || tag === 'button' || tag === 'a') {
        await item.click().catch(() => {});
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      // Try keyboard shortcut - press the letter key
      const keys = ['1','2','3','4','5','6'];
      await page.keyboard.press(keys[theme.key - 1]);
    }
    await page.waitForTimeout(1000);
    
    const outPath = path.join(ssDir, `stellar-spin-${theme.name}-${ts}.png`);
    await page.screenshot({ path: outPath, fullPage: false });
    process.stdout.write(JSON.stringify({ theme: theme.name, ok: true }) + '\n');
  }

  // Scroll down in the active preview to see ticket prices / FAQ
  // First go back to theme 1
  const items1 = await page.$$('[data-theme="1"]');
  for (const item of items1) {
    const tag = await item.evaluate(el => el.tagName.toLowerCase());
    if (tag === 'li' || tag === 'div') { await item.click().catch(() => {}); break; }
  }
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

  await browser.close();
  process.stdout.write(JSON.stringify({ consoleErrors }) + '\n');
})();
