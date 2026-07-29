// pw-e2e-test.js — Playwright smoke test with optional advanced UI checks.
//
// Single-page (backward-compat):
//   node pw-e2e-test.js <url> <out.png> [width] [height] [flags]
//   → stdout: JSON object { ok, url, out, width, height, consoleErrors, a11y, [advanced] }
//
// Multi-page:
//   node pw-e2e-test.js <url> <out-prefix> [width] [height] --routes=auto|/r1,/r2 [--nav=link-crawl|tab-click]
//   → stdout: JSON array  [{ ok, url, route, out, ..., [advanced] }, ...]
//
// Navigation flags:
//   --routes=auto        Discover routes automatically (uses --nav strategy)
//   --routes=/,/about    Explicit comma-separated route list
//   --nav=link-crawl     (default) follow internal <a href> links
//   --nav=tab-click      click [role=tab] / data-testid=stTab / .tab-nav elements
//
// Advanced UI flags (single-page and per-page in multi-page):
//   --detect-advanced    Auto-detect animations/canvas/WebGL and auto-enable checks below
//   --animated           Multi-frame capture (0 / 500ms / 1s / 2s) + FPS measurement
//   --hover              Hover up to 5 interactive elements, screenshot each
//   --scroll             Scroll to 25/50/75/100%, screenshot at each position
//   --video              Record a 3-second WebM video of the page load
//
// Auto-escalation when --detect-advanced is set:
//   CSS animations / GSAP / Framer / Lottie / SVG animate  → enables --animated + --scroll
//   CSS transitions                                          → enables --hover
//   canvas / WebGL / Three.js                               → enables --animated (FPS only)
//
// Cap: 15 routes max for link-crawl; 10 tabs max for tab-click.

const { chromium }   = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
const path           = require('path');
const fs             = require('fs');

// ── Argument parsing ─────────────────────────────────────────────────────────
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags      = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const eq = a.indexOf('=');
      return eq === -1
        ? [a.replace(/^--/, ''), 'true']
        : [a.slice(2, eq), a.slice(eq + 1)];
    })
);

const [url = 'about:blank', outArg = 'e2e-test.png', w = '1280', h = '800'] = positional;
const width     = parseInt(w, 10)  || 1280;
const height    = parseInt(h, 10)  || 800;
const routeArg  = flags['routes'];
const navStrat  = flags['nav'] || 'link-crawl';
const multiMode = !!routeArg;

const detectAdv  = flags['detect-advanced'] === 'true';
const forceAnim  = flags['animated']        === 'true';
const forceHover = flags['hover']           === 'true';
const forceScroll= flags['scroll']          === 'true';
const forceVideo = flags['video']           === 'true';
const anyAdvFlag = detectAdv || forceAnim || forceHover || forceScroll || forceVideo;

// ── Helpers ───────────────────────────────────────────────────────────────────
async function runAxe(page) {
  try {
    const results  = await new AxeBuilder({ page }).analyze();
    const critical = results.violations.filter(
      v => v.impact === 'critical' || v.impact === 'serious'
    );
    return {
      violations: results.violations.length,
      critical:   critical.length,
      details:    results.violations.map(v => ({
        id:          v.id,
        impact:      v.impact,
        description: v.description,
        nodes:       v.nodes.length,
      })),
    };
  } catch (e) {
    return { violations: -1, critical: -1, error: e.message };
  }
}

// Detect advanced UI features via computed styles + DOM inspection
async function detectFeatures(page) {
  return page.evaluate(() => {
    // Canvas / WebGL
    const canvasEls = Array.from(document.querySelectorAll('canvas'));
    const hasCanvas = canvasEls.length > 0;
    let hasWebGL = false;
    canvasEls.forEach(c => {
      try { if (c.getContext('webgl') || c.getContext('webgl2')) hasWebGL = true; } catch {}
    });

    // CSS animations and transitions (sample first 300 elements for speed)
    const els = Array.from(document.querySelectorAll('*')).slice(0, 300);
    let hasAnimations = false, hasTransitions = false;
    for (const el of els) {
      const s = getComputedStyle(el);
      if (!hasAnimations && s.animationName && s.animationName !== 'none') hasAnimations = true;
      if (!hasTransitions && s.transitionDuration && s.transitionDuration !== '0s') hasTransitions = true;
      if (hasAnimations && hasTransitions) break;
    }

    // JS animation libraries
    const hasGSAP    = typeof window.gsap    !== 'undefined';
    const hasThreeJS = typeof window.THREE   !== 'undefined';
    const hasMotion  = typeof window.motion  !== 'undefined'; // Framer Motion
    const hasLottie  = document.querySelectorAll('[class*="lottie"], lottie-player, dotlottie-player').length > 0;

    // SVG animations
    const hasSVGAnimations = document.querySelectorAll('animate, animateTransform, animateMotion').length > 0;

    return { hasCanvas, hasWebGL, hasAnimations, hasTransitions,
             hasGSAP, hasThreeJS, hasMotion, hasLottie, hasSVGAnimations };
  });
}

// Measure live FPS via requestAnimationFrame for ~1 second
async function measureFPS(page) {
  try {
    const fps = await page.evaluate(() => new Promise(resolve => {
      let frames = 0;
      const start = performance.now();
      function tick() {
        frames++;
        if (performance.now() - start < 1000) requestAnimationFrame(tick);
        else resolve(Math.round(frames));
      }
      requestAnimationFrame(tick);
    }));
    return { fps, fpsStatus: fps >= 55 ? 'smooth' : fps >= 30 ? 'reduced' : 'janky' };
  } catch {
    return { fps: null, fpsStatus: 'unknown' };
  }
}

// Multi-frame screenshot: capture at 0 / 500ms / 1s / 2s from now
async function captureFrames(page, outBase) {
  const frames = [];
  let elapsed = 0;
  for (const ms of [0, 500, 1000, 2000]) {
    if (ms > elapsed) await page.waitForTimeout(ms - elapsed);
    elapsed = ms;
    const framePath = `${outBase}-frame-${ms}ms.png`;
    await page.screenshot({ path: framePath, fullPage: false });
    frames.push({ ms, file: framePath });
  }
  return frames;
}

// Hover up to 5 interactive elements and screenshot each
async function captureHoverStates(page, outBase) {
  const results = [];
  // Scroll to top first
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);

  const candidates = await page.$$('button, a[href], [role="button"], input[type="button"], input[type="submit"]');
  let captured = 0;
  for (const el of candidates) {
    if (captured >= 5) break;
    try {
      if (!await el.isVisible()) continue;
      const label = await el.evaluate(e =>
        (e.textContent || e.getAttribute('aria-label') || e.getAttribute('title') || e.className || '')
          .trim().replace(/\s+/g, '-').slice(0, 30)
      );
      await el.hover({ timeout: 2000 });
      await page.waitForTimeout(350);
      const hoverPath = `${outBase}-hover-${captured}.png`;
      await page.screenshot({ path: hoverPath, fullPage: false });
      results.push({ index: captured, label, file: hoverPath });
      captured++;
      // Move mouse away to reset hover state
      await page.mouse.move(0, 0);
      await page.waitForTimeout(150);
    } catch {}
  }
  return results;
}

// Scroll to 25 / 50 / 75 / 100% page height and screenshot
async function captureScrollStates(page, outBase) {
  const results = [];
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  for (const pct of [25, 50, 75, 100]) {
    await page.evaluate(p => {
      const maxScroll = Math.max(
        document.documentElement.scrollHeight - window.innerHeight, 1
      );
      window.scrollTo({ top: maxScroll * (p / 100), behavior: 'instant' });
    }, pct);
    await page.waitForTimeout(600); // let scroll-triggered animations fire
    const scrollPath = `${outBase}-scroll-${pct}pct.png`;
    await page.screenshot({ path: scrollPath, fullPage: false });
    results.push({ pct, file: scrollPath });
  }
  // Reset scroll
  await page.evaluate(() => window.scrollTo(0, 0));
  return results;
}

// Record a ~3-second WebM video of the page (separate browser context required)
async function recordVideo(url, outBase, width, height) {
  const videoDir = path.dirname(outBase) || '.';
  const browser  = await chromium.launch({ headless: true });
  const context  = await browser.newContext({
    viewport:    { width, height },
    recordVideo: { dir: videoDir, size: { width, height } },
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000); // capture 3 seconds of animation
  } catch {}
  await context.close(); // triggers video save
  try {
    const src  = await page.video().path();
    const dest = `${outBase}-recording.webm`;
    if (src && fs.existsSync(src)) fs.renameSync(src, dest);
    return dest;
  } catch { return null; }
  finally { await browser.close(); }
}

// Run all advanced checks; returns the `advanced` result object
async function runAdvanced(page, outBase, detected) {
  const needsAnim   = forceAnim   || (detectAdv && (detected.hasAnimations || detected.hasGSAP || detected.hasMotion || detected.hasLottie || detected.hasSVGAnimations || detected.hasCanvas || detected.hasWebGL || detected.hasThreeJS));
  const needsHover  = forceHover  || (detectAdv && detected.hasTransitions);
  const needsScroll = forceScroll || (detectAdv && (detected.hasAnimations || detected.hasGSAP || detected.hasMotion));
  const needsFPS    = needsAnim || (detectAdv && (detected.hasCanvas || detected.hasWebGL || detected.hasThreeJS));

  const adv = { detected };

  if (needsFPS) {
    const { fps, fpsStatus } = await measureFPS(page);
    adv.fps       = fps;
    adv.fpsStatus = fpsStatus;
  }
  if (needsAnim)   adv.frames = await captureFrames(page, outBase);
  if (needsHover)  adv.hover  = await captureHoverStates(page, outBase);
  if (needsScroll) adv.scroll = await captureScrollStates(page, outBase);
  if (forceVideo) {
    adv.video = await recordVideo(url, outBase, width, height);
  }

  return adv;
}

async function discoverByLinks(page, baseUrl) {
  const links = await page.$$eval(
    'a[href]',
    (anchors, base) => {
      const seen = new Set(['/']);
      return anchors.reduce((acc, a) => {
        try {
          const href = a.getAttribute('href') || '';
          if (!href || href.startsWith('#') || href.startsWith('javascript')
              || href.startsWith('mailto') || href.startsWith('data:')) return acc;
          const u = new URL(href, base);
          if (u.host !== new URL(base).host) return acc;
          const key = u.pathname + (u.search || '');
          if (!seen.has(key)) { seen.add(key); acc.push(key); }
        } catch {}
        return acc;
      }, []);
    },
    baseUrl
  );
  return ['/', ...links].slice(0, 15);
}

async function discoverTabs(page) {
  const selectors = [
    '[data-testid="stTab"]',
    '.tab-nav button',
    '[role="tab"]',
    'button[class*="tab"]',
  ];
  for (const sel of selectors) {
    const els = await page.$$(sel);
    if (els.length >= 2) return els.slice(0, 10).map((_, i) => ({ selector: sel, index: i }));
  }
  return [];
}

function routeSlug(route) {
  return route === '/' ? 'root' : route.replace(/^\//, '').replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40);
}

// ── Single-page mode ──────────────────────────────────────────────────────────
async function singlePage() {
  const outBase  = outArg.replace(/\.png$/i, '');
  const outDir   = path.dirname(outBase);
  if (outDir && outDir !== '.' && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();
  const errors  = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width, height });

  if (url === 'about:blank') {
    await page.setContent('<h1 style="font-family:sans-serif;color:green">Playwright E2E OK</h1>');
  } else {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  await page.screenshot({ path: outArg, fullPage: false });

  let a11y = { violations: 0, critical: 0, details: [] };
  if (url !== 'about:blank') a11y = await runAxe(page);

  // Advanced checks
  let advanced;
  if (anyAdvFlag && url !== 'about:blank') {
    const detected = await detectFeatures(page);
    advanced = await runAdvanced(page, outBase, detected);
  }

  await browser.close();

  const result = { ok: true, url, out: outArg, width, height, consoleErrors: errors, a11y };
  if (advanced) result.advanced = advanced;
  process.stdout.write(JSON.stringify(result) + '\n');
}

// ── Multi-page mode ───────────────────────────────────────────────────────────
async function multiPage() {
  const prefix = outArg.replace(/\.png$/i, '');
  const outDir = path.dirname(prefix);
  if (outDir && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const results = [];

  async function pageChecks(page, pageUrl, outPath, route) {
    const errors = [];
    const errHandler = e => errors.push(e.message);
    page.on('pageerror', errHandler);
    try {
      await page.setViewportSize({ width, height });
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.screenshot({ path: outPath, fullPage: false });
      const a11y = await runAxe(page);
      let advanced;
      if (anyAdvFlag) {
        const detected = await detectFeatures(page);
        const outBase   = outPath.replace(/\.png$/i, '');
        advanced = await runAdvanced(page, outBase, detected);
      }
      const entry = { ok: true, url: pageUrl, route, out: outPath, width, height, consoleErrors: errors, a11y };
      if (advanced) entry.advanced = advanced;
      return entry;
    } catch (e) {
      return { ok: false, url: pageUrl, route, error: e.message };
    } finally {
      page.off('pageerror', errHandler);
    }
  }

  if (navStrat === 'tab-click') {
    const page = await browser.newPage();
    await page.setViewportSize({ width, height });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const tabs = await discoverTabs(page);

    if (tabs.length === 0) {
      const outPath = `${prefix}-root.png`;
      await page.screenshot({ path: outPath, fullPage: false });
      const a11y = await runAxe(page);
      results.push({ ok: true, url, route: '/', out: outPath, width, height,
                     consoleErrors: [], a11y, note: 'no-tabs-found' });
    } else {
      for (const tab of tabs) {
        const errors = [];
        const errHandler = e => errors.push(e.message);
        page.on('pageerror', errHandler);
        try {
          const els = await page.$$(tab.selector);
          if (!els[tab.index]) continue;
          const label = (await els[tab.index].innerText().catch(() => '')).trim()
            .replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '').toLowerCase() || `tab${tab.index}`;
          await els[tab.index].click();
          await page.waitForTimeout(700);
          const outPath = `${prefix}-tab-${label}.png`;
          await page.screenshot({ path: outPath, fullPage: false });
          const a11y = await runAxe(page);
          let advanced;
          if (anyAdvFlag) {
            const detected = await detectFeatures(page);
            advanced = await runAdvanced(page, outPath.replace(/\.png$/i, ''), detected);
          }
          const entry = { ok: true, url, route: `tab:${label}`, tab: tab.index,
                          out: outPath, width, height, consoleErrors: errors, a11y };
          if (advanced) entry.advanced = advanced;
          results.push(entry);
        } catch (e) {
          results.push({ ok: false, url, route: `tab:${tab.index}`, error: e.message });
        } finally {
          page.off('pageerror', errHandler);
        }
      }
    }
    await page.close();

  } else {
    let routes;
    if (routeArg === 'auto') {
      const discPage = await browser.newPage();
      await discPage.setViewportSize({ width, height });
      await discPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      routes = await discoverByLinks(discPage, url);
      await discPage.close();
    } else {
      routes = routeArg.split(',').map(r => r.trim()).filter(Boolean);
    }

    const base = new URL(url);
    for (const route of routes) {
      const pageUrl = `${base.protocol}//${base.host}${route.startsWith('/') ? route : '/' + route}`;
      const outPath = `${prefix}-${routeSlug(route)}.png`;
      const page    = await browser.newPage();
      const entry   = await pageChecks(page, pageUrl, outPath, route);
      results.push(entry);
      await page.close();
    }
  }

  await browser.close();
  process.stdout.write(JSON.stringify(results) + '\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────
(multiMode ? multiPage() : singlePage()).catch(e => {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
  process.exit(1);
});
