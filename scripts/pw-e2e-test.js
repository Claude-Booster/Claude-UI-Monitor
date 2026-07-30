// pw-e2e-test.js — Playwright smoke test with optional advanced UI checks.
//
// Single-page (backward-compat):
//   node pw-e2e-test.js <url> <out.png> [width] [height] [flags]
//   → stdout: JSON object { ok, url, out, width, height, consoleErrors, a11y,
//                           meta, images, bundle, fonts, securityHeaders,
//                           [advanced], [css], [cwv], [darkMode], [diff], [harPath] }
//
// Multi-page:
//   node pw-e2e-test.js <url> <out-prefix> [width] [height] --routes=auto|/r1,/r2 [--nav=link-crawl|tab-click]
//   → stdout: JSON array  [{ ok, url, route, out, ..., meta, images, bundle, fonts,
//                            securityHeaders, [advanced], [css], [cwv], [darkMode] }, ...]
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
// Extended check flags (single-page + link-crawl multi-page):
//   --dark-mode          Extra screenshot with prefers-color-scheme: dark emulated
//   --css-coverage       CSS coverage report (unused % per stylesheet)
//   --har                Record network activity as HAR file (<outBase>.har)
//   --cwv                Core Web Vitals via PerformanceObserver (LCP, CLS, FCP, TTFB)
//   --compare=<path>     Pixel-diff current screenshot vs baseline PNG
//                        (creates baseline automatically on first run)
//
// Always-on for real URLs (zero-overhead additions to JSON output):
//   meta            OpenGraph / SEO meta tag audit with issue list
//   images          Image quality (broken, oversized, missing alt, legacy formats)
//   bundle          Resource size summary (JS/CSS/img KB via Performance API)
//   fonts           Font loading status + font-display FOUT/FOIT risk
//   securityHeaders HTTP security header presence (CSP, HSTS, X-Frame-Options, etc.)
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

// ── Argument parsing ──────────────────────────────────────────────────────────
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
const width    = parseInt(w, 10) || 1280;
const height   = parseInt(h, 10) || 800;
const routeArg = flags['routes'];
const navStrat = flags['nav'] || 'link-crawl';
const multiMode= !!routeArg;

const detectAdv  = flags['detect-advanced'] === 'true';
const forceAnim  = flags['animated']        === 'true';
const forceHover = flags['hover']           === 'true';
const forceScroll= flags['scroll']          === 'true';
const forceVideo = flags['video']           === 'true';
const anyAdvFlag = detectAdv || forceAnim || forceHover || forceScroll || forceVideo;

const darkMode    = flags['dark-mode']    === 'true';
const cssCoverage = flags['css-coverage'] === 'true';
const harCapture  = flags['har']          === 'true';
const cwvMode     = flags['cwv']          === 'true';
const comparePath = flags['compare']      || null;

// ── Response tracking (security headers + image formats) ──────────────────────
function setupResponseTracking(page) {
  const securityHeaders = {};
  const imageFormats    = {};
  let secCaptured = false;

  page.on('response', response => {
    try {
      const headers = response.headers();
      if (!secCaptured && response.request().resourceType() === 'document' && response.status() < 400) {
        securityHeaders.csp              = headers['content-security-policy']   ?? null;
        securityHeaders.hsts             = headers['strict-transport-security'] ?? null;
        securityHeaders.xFrameOptions    = headers['x-frame-options']           ?? null;
        securityHeaders.xcto             = headers['x-content-type-options']    ?? null;
        securityHeaders.referrerPolicy   = headers['referrer-policy']           ?? null;
        securityHeaders.permissionsPolicy= headers['permissions-policy']        ?? null;
        securityHeaders.missing = [
          !securityHeaders.csp            && 'content-security-policy',
          !securityHeaders.hsts           && 'strict-transport-security',
          !securityHeaders.xFrameOptions  && 'x-frame-options',
          !securityHeaders.xcto           && 'x-content-type-options',
          !securityHeaders.referrerPolicy && 'referrer-policy',
        ].filter(Boolean);
        secCaptured = true;
      }
      const ct = headers['content-type'];
      if (ct && ct.startsWith('image/')) {
        imageFormats[response.url()] = ct.split(';')[0].trim();
      }
    } catch {}
  });

  return {
    getSecurityHeaders: () => (secCaptured ? securityHeaders : null),
    getImageFormats:    () => imageFormats,
  };
}

// ── Accessibility ─────────────────────────────────────────────────────────────
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

// ── Advanced UI feature detection ─────────────────────────────────────────────
async function detectFeatures(page) {
  return page.evaluate(() => {
    const canvasEls = Array.from(document.querySelectorAll('canvas'));
    const hasCanvas = canvasEls.length > 0;
    let hasWebGL = false;
    canvasEls.forEach(c => {
      try { if (c.getContext('webgl') || c.getContext('webgl2')) hasWebGL = true; } catch {}
    });
    const els = Array.from(document.querySelectorAll('*')).slice(0, 300);
    let hasAnimations = false, hasTransitions = false;
    for (const el of els) {
      const s = getComputedStyle(el);
      if (!hasAnimations && s.animationName && s.animationName !== 'none') hasAnimations = true;
      if (!hasTransitions && s.transitionDuration && s.transitionDuration !== '0s') hasTransitions = true;
      if (hasAnimations && hasTransitions) break;
    }
    const hasGSAP          = typeof window.gsap   !== 'undefined';
    const hasThreeJS        = typeof window.THREE  !== 'undefined';
    const hasMotion         = typeof window.motion !== 'undefined';
    const hasLottie         = document.querySelectorAll('[class*="lottie"], lottie-player, dotlottie-player').length > 0;
    const hasSVGAnimations  = document.querySelectorAll('animate, animateTransform, animateMotion').length > 0;
    return { hasCanvas, hasWebGL, hasAnimations, hasTransitions,
             hasGSAP, hasThreeJS, hasMotion, hasLottie, hasSVGAnimations };
  });
}

// ── FPS measurement ───────────────────────────────────────────────────────────
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

// ── Multi-frame capture ───────────────────────────────────────────────────────
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

// ── Hover states ──────────────────────────────────────────────────────────────
async function captureHoverStates(page, outBase) {
  const results = [];
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
      await page.mouse.move(0, 0);
      await page.waitForTimeout(150);
    } catch {}
  }
  return results;
}

// ── Scroll states ─────────────────────────────────────────────────────────────
async function captureScrollStates(page, outBase) {
  const results = [];
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  for (const pct of [25, 50, 75, 100]) {
    await page.evaluate(p => {
      const maxScroll = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
      window.scrollTo({ top: maxScroll * (p / 100), behavior: 'instant' });
    }, pct);
    await page.waitForTimeout(600);
    const scrollPath = `${outBase}-scroll-${pct}pct.png`;
    await page.screenshot({ path: scrollPath, fullPage: false });
    results.push({ pct, file: scrollPath });
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return results;
}

// ── Video recording ───────────────────────────────────────────────────────────
async function recordVideo(pageUrl, outBase, w, h) {
  const videoDir = path.dirname(outBase) || '.';
  const browser  = await chromium.launch({ headless: true });
  const context  = await browser.newContext({
    viewport:    { width: w, height: h },
    recordVideo: { dir: videoDir, size: { width: w, height: h } },
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  } catch {}
  await context.close();
  try {
    const src  = await page.video().path();
    const dest = `${outBase}-recording.webm`;
    if (src && fs.existsSync(src)) fs.renameSync(src, dest);
    return dest;
  } catch { return null; }
  finally { await browser.close(); }
}

// ── Advanced checks orchestration ─────────────────────────────────────────────
async function runAdvanced(page, outBase, detected) {
  const needsAnim   = forceAnim   || (detectAdv && (detected.hasAnimations || detected.hasGSAP || detected.hasMotion || detected.hasLottie || detected.hasSVGAnimations || detected.hasCanvas || detected.hasWebGL || detected.hasThreeJS));
  const needsHover  = forceHover  || (detectAdv && detected.hasTransitions);
  const needsScroll = forceScroll || (detectAdv && (detected.hasAnimations || detected.hasGSAP || detected.hasMotion));
  const needsFPS    = needsAnim   || (detectAdv && (detected.hasCanvas || detected.hasWebGL || detected.hasThreeJS));
  const adv = { detected };
  if (needsFPS)   { const { fps, fpsStatus } = await measureFPS(page); adv.fps = fps; adv.fpsStatus = fpsStatus; }
  if (needsAnim)   adv.frames = await captureFrames(page, outBase);
  if (needsHover)  adv.hover  = await captureHoverStates(page, outBase);
  if (needsScroll) adv.scroll = await captureScrollStates(page, outBase);
  if (forceVideo)  adv.video  = await recordVideo(url, outBase, width, height);
  return adv;
}

// ── New audit helpers ─────────────────────────────────────────────────────────

async function runMetaAudit(page) {
  return page.evaluate(() => {
    const get = (sel, attr = 'content') => document.querySelector(sel)?.[attr] ?? null;
    const title = document.title;
    const desc  = get('meta[name="description"]');
    const ogImg = get('meta[property="og:image"]');
    return {
      title,
      description: desc,
      canonical:   get('link[rel="canonical"]', 'href'),
      robots:      get('meta[name="robots"]'),
      viewport:    get('meta[name="viewport"]'),
      og: {
        title:       get('meta[property="og:title"]'),
        description: get('meta[property="og:description"]'),
        image:       ogImg,
        url:         get('meta[property="og:url"]'),
        type:        get('meta[property="og:type"]'),
      },
      twitter: {
        card:  get('meta[name="twitter:card"]'),
        image: get('meta[name="twitter:image"]'),
        title: get('meta[name="twitter:title"]'),
      },
      issues: [
        !title                                  && 'Missing <title>',
        title && title.length > 60              && `Title too long (${title.length} chars, max 60)`,
        title && title.length < 10              && `Title too short (${title.length} chars)`,
        !desc                                   && 'Missing meta description',
        desc  && desc.length > 160              && `Description too long (${desc.length} chars, max 160)`,
        !get('link[rel="canonical"]', 'href')   && 'Missing canonical link',
        !ogImg                                  && 'Missing og:image',
        !get('meta[name="viewport"]')           && 'Missing viewport meta',
        !get('meta[property="og:title"]')       && 'Missing og:title',
      ].filter(Boolean),
    };
  });
}

async function runImageAudit(page, imageFormats) {
  const imgData = await page.evaluate(() =>
    [...document.querySelectorAll('img')].map(img => ({
      src:        img.currentSrc || img.src || '',
      missingAlt: img.alt === '' && img.getAttribute('role') !== 'presentation' && img.getAttribute('aria-hidden') !== 'true',
      broken:     img.complete && img.naturalWidth === 0 && img.src !== '',
      naturalW:   img.naturalWidth,
      naturalH:   img.naturalHeight,
      displayW:   img.clientWidth,
      displayH:   img.clientHeight,
      oversized:  img.naturalWidth > img.clientWidth * 2 && img.clientWidth > 0 && img.naturalWidth > 200,
      lazy:       img.loading === 'lazy',
    }))
  );
  const legacyFormats = Object.entries(imageFormats)
    .filter(([, ct]) => ct === 'image/jpeg' || ct === 'image/png')
    .map(([u]) => u.split('/').pop().split('?')[0]);

  return {
    total:         imgData.length,
    broken:        imgData.filter(i => i.broken).length,
    missingAlt:    imgData.filter(i => i.missingAlt).length,
    oversized:     imgData.filter(i => i.oversized).length,
    notLazy:       imgData.filter(i => !i.lazy && i.displayW > 100).length,
    legacyFormats: legacyFormats.length,
    details: {
      broken:     imgData.filter(i => i.broken).map(i => i.src),
      missingAlt: imgData.filter(i => i.missingAlt).map(i => i.src || '(no src)'),
      oversized:  imgData.filter(i => i.oversized).map(i => ({
        src:     i.src,
        natural: `${i.naturalW}×${i.naturalH}`,
        display: `${i.displayW}×${i.displayH}`,
      })),
    },
  };
}

async function runBundleAudit(page) {
  return page.evaluate(() => {
    const resources = performance.getEntriesByType('resource');
    const kb = bytes => parseFloat((bytes / 1024).toFixed(1));
    const byType = type => resources.filter(r => r.initiatorType === type);
    const jsRes  = byType('script');
    const cssRes = byType('css');
    const imgRes = byType('img');
    const jsKB   = kb(jsRes.reduce( (s, r) => s + r.transferSize, 0));
    const cssKB  = kb(cssRes.reduce((s, r) => s + r.transferSize, 0));
    const totalKB= kb(resources.reduce((s, r) => s + r.transferSize, 0));
    const largest = [...resources]
      .sort((a, b) => b.decodedBodySize - a.decodedBodySize).slice(0, 3)
      .map(r => ({ file: r.name.split('/').pop().split('?')[0] || r.name, decodedKB: kb(r.decodedBodySize), type: r.initiatorType }));
    const slowest = [...resources].filter(r => r.duration > 0)
      .sort((a, b) => b.duration - a.duration).slice(0, 3)
      .map(r => ({ file: r.name.split('/').pop().split('?')[0] || r.name, durationMs: Math.round(r.duration), type: r.initiatorType }));
    return {
      totalTransferKB: totalKB,
      jsKB, cssKB,
      imgKB:         kb(imgRes.reduce((s, r) => s + r.transferSize, 0)),
      resourceCount: resources.length,
      cachedCount:   resources.filter(r => r.transferSize === 0 && r.decodedBodySize > 0).length,
      largest, slowest,
      warnings: [
        totalKB > 2048 && `Total transfer ${totalKB}KB exceeds 2MB`,
        jsKB    > 512  && `JS bundle ${jsKB}KB exceeds 512KB`,
      ].filter(Boolean),
    };
  });
}

async function runFontAudit(page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const fontFaces = [...document.fonts].map(f => ({ family: f.family, status: f.status }));
    const fontFaceRules = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSFontFaceRule) {
            fontFaceRules.push({
              family:  rule.style.getPropertyValue('font-family').replace(/['"]/g, ''),
              display: rule.style.getPropertyValue('font-display') || 'auto',
            });
          }
        }
      } catch {} // cross-origin stylesheet throws SecurityError
    }
    return {
      loaded:   fontFaces.filter(f => f.status === 'loaded').length,
      failed:   fontFaces.filter(f => f.status === 'error').map(f => f.family),
      foitRisk: fontFaceRules.filter(f => f.display === 'auto' || f.display === 'block').map(f => f.family),
      foutRisk: fontFaceRules.filter(f => f.display === 'swap').map(f => f.family),
      optimal:  fontFaceRules.filter(f => f.display === 'optional' || f.display === 'fallback').map(f => f.family),
    };
  });
}

async function getCSSCoverage(page) {
  const coverage = await page.coverage.stopCSSCoverage();
  let totalBytes = 0, usedBytes = 0;
  const sheets = [];
  for (const entry of coverage) {
    const entryUsed = entry.ranges.reduce((s, r) => s + (r.end - r.start), 0);
    totalBytes += entry.text.length;
    usedBytes  += entryUsed;
    sheets.push({
      url:     entry.url.split('/').pop().split('?')[0] || entry.url,
      totalKB: parseFloat((entry.text.length / 1024).toFixed(1)),
      usedKB:  parseFloat((entryUsed          / 1024).toFixed(1)),
      usedPct: entry.text.length ? Math.round(entryUsed / entry.text.length * 100) : 100,
    });
  }
  const unusedPct = totalBytes
    ? parseFloat(((totalBytes - usedBytes) / totalBytes * 100).toFixed(1))
    : 0;
  return {
    totalKB:     parseFloat((totalBytes / 1024).toFixed(1)),
    usedKB:      parseFloat((usedBytes  / 1024).toFixed(1)),
    unusedPct,
    sheetsCount: coverage.length,
    warnings:    unusedPct > 70 ? [`${unusedPct}% of CSS unused on initial load`] : [],
    sheets:      sheets.sort((a, b) => b.totalKB - a.totalKB).slice(0, 5),
  };
}

async function runCWV(page) {
  try {
    await page.waitForTimeout(2000);
    return await page.evaluate(() => {
      const nav    = performance.getEntriesByType('navigation')[0] || {};
      const paints = performance.getEntriesByType('paint');
      const fcp    = paints.find(e => e.name === 'first-contentful-paint')?.startTime ?? null;
      const lcpEnt = performance.getEntriesByType('largest-contentful-paint');
      const lcp    = lcpEnt.length ? lcpEnt[lcpEnt.length - 1].startTime : null;
      const cls    = window.__vitals?.cls ?? null;
      const ttfb   = nav.responseStart ? Math.round(nav.responseStart) : null;
      const rate   = (v, g, ni) => v == null ? null : v <= g ? 'good' : v <= ni ? 'needs-improvement' : 'poor';
      return {
        lcp:  lcp  != null ? Math.round(lcp)            : null,
        cls:  cls  != null ? parseFloat(cls.toFixed(4)) : null,
        fcp:  fcp  != null ? Math.round(fcp)            : null,
        ttfb,
        ratings: {
          lcp: rate(lcp, 2500, 4000),
          cls: rate(cls, 0.1,  0.25),
          fcp: rate(fcp, 1800, 3000),
        },
      };
    });
  } catch (e) {
    return { error: e.message };
  }
}

async function captureDarkMode(page, outPath) {
  const darkPath = outPath.replace(/\.png$/i, '') + '-dark.png';
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: darkPath, fullPage: false });
  await page.emulateMedia({ colorScheme: 'light' });
  return darkPath;
}

async function compareScreenshots(currentPath, baselinePath) {
  try {
    const { PNG }    = require('pngjs');
    const pixelmatch = require('pixelmatch');
    const img1 = PNG.sync.read(fs.readFileSync(baselinePath));
    const img2 = PNG.sync.read(fs.readFileSync(currentPath));
    if (img1.width !== img2.width || img1.height !== img2.height) {
      return { ok: false, error: `Size mismatch: baseline ${img1.width}×${img1.height} vs current ${img2.width}×${img2.height}` };
    }
    const diffPNG    = new PNG({ width: img1.width, height: img1.height });
    const diffPixels = pixelmatch(img1.data, img2.data, diffPNG.data, img1.width, img1.height,
                                  { threshold: 0.1, includeAA: true });
    const diffPct  = parseFloat(((diffPixels / (img1.width * img1.height)) * 100).toFixed(2));
    const diffPath = currentPath.replace(/\.png$/i, '') + '-diff.png';
    fs.writeFileSync(diffPath, PNG.sync.write(diffPNG));
    return { diffPixels, diffPct, diffPath, changed: diffPct > 0.5 };
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      return { ok: false, error: 'pixelmatch/pngjs not installed',
               action: 'cd ~/.claude/scripts && npm install pixelmatch pngjs' };
    }
    return { ok: false, error: e.message };
  }
}

// ── CWV init script (registered before page navigation) ───────────────────────
async function installCWVObserver(page) {
  await page.addInitScript(() => {
    window.__vitals = { cls: 0 };
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          if (!e.hadRecentInput) window.__vitals.cls += e.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {}
  });
}

// ── Route discovery helpers ───────────────────────────────────────────────────
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
  return route === '/'
    ? 'root'
    : route.replace(/^\//, '').replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40);
}

// ── Single-page mode ──────────────────────────────────────────────────────────
async function singlePage() {
  const outBase = outArg.replace(/\.png$/i, '');
  const outDir  = path.dirname(outBase);
  if (outDir && outDir !== '.' && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  // Browser context — optional HAR recording
  const contextOpts = {};
  let harPath;
  if (harCapture) {
    harPath = outBase + '.har';
    contextOpts.recordHar = { path: harPath, mode: 'minimal' };
  }
  const context = await browser.newContext(contextOpts);
  const page    = await context.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width, height });

  const tracker = url !== 'about:blank' ? setupResponseTracking(page) : null;

  if (cwvMode && url !== 'about:blank') await installCWVObserver(page);
  if (cssCoverage) await page.coverage.startCSSCoverage();

  if (url === 'about:blank') {
    await page.setContent('<h1 style="font-family:sans-serif;color:green">Playwright E2E OK</h1>');
  } else {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  await page.screenshot({ path: outArg, fullPage: false });

  let css;
  if (cssCoverage) css = await getCSSCoverage(page);

  let darkOut;
  if (darkMode && url !== 'about:blank') darkOut = await captureDarkMode(page, outArg);

  let diff;
  if (comparePath) {
    if (!fs.existsSync(comparePath)) {
      fs.copyFileSync(outArg, comparePath);
      diff = { ok: true, baselineCreated: true, baselinePath: comparePath };
    } else {
      diff = await compareScreenshots(outArg, comparePath);
    }
  }

  let a11y = { violations: 0, critical: 0, details: [] };
  if (url !== 'about:blank') a11y = await runAxe(page);

  // Advanced checks — always runs when flags are set (detected = {} on blank pages)
  let advanced;
  if (anyAdvFlag) {
    const detected = await detectFeatures(page);
    advanced = await runAdvanced(page, outBase, detected);
  }

  // Always-on audits for real URLs
  let meta, images, bundle, fonts, securityHeaders, cwv;
  if (url !== 'about:blank') {
    [meta, images, bundle, fonts] = await Promise.all([
      runMetaAudit(page),
      runImageAudit(page, tracker.getImageFormats()),
      runBundleAudit(page),
      runFontAudit(page),
    ]);
    securityHeaders = tracker.getSecurityHeaders();
    if (cwvMode) cwv = await runCWV(page);
  }

  await context.close(); // flushes HAR
  await browser.close();

  const result = { ok: true, url, out: outArg, width, height, consoleErrors: errors, a11y };
  if (url !== 'about:blank') {
    result.meta            = meta;
    result.images          = images;
    result.bundle          = bundle;
    result.fonts           = fonts;
    result.securityHeaders = securityHeaders;
  }
  if (advanced) result.advanced = advanced;
  if (css)      result.css      = css;
  if (cwv)      result.cwv      = cwv;
  if (darkOut)  result.darkMode = { out: darkOut };
  if (diff)     result.diff     = diff;
  if (harPath)  result.harPath  = harPath;

  process.stdout.write(JSON.stringify(result) + '\n');
}

// ── Multi-page: single-route audit ────────────────────────────────────────────
async function pageChecks(page, pageUrl, outPath, route) {
  const errors = [];
  const errHandler = e => errors.push(e.message);
  page.on('pageerror', errHandler);
  const tracker = setupResponseTracking(page);
  try {
    await page.setViewportSize({ width, height });
    if (cwvMode) await installCWVObserver(page);
    if (cssCoverage) await page.coverage.startCSSCoverage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.screenshot({ path: outPath, fullPage: false });

    let css;
    if (cssCoverage) css = await getCSSCoverage(page);

    let darkOut;
    if (darkMode) darkOut = await captureDarkMode(page, outPath);

    const a11y = await runAxe(page);
    let advanced;
    if (anyAdvFlag) {
      const detected = await detectFeatures(page);
      advanced = await runAdvanced(page, outPath.replace(/\.png$/i, ''), detected);
    }

    const [meta, images, bundle, fonts] = await Promise.all([
      runMetaAudit(page),
      runImageAudit(page, tracker.getImageFormats()),
      runBundleAudit(page),
      runFontAudit(page),
    ]);
    const securityHeaders = tracker.getSecurityHeaders();
    let cwv;
    if (cwvMode) cwv = await runCWV(page);

    const entry = {
      ok: true, url: pageUrl, route, out: outPath, width, height,
      consoleErrors: errors, a11y, meta, images, bundle, fonts, securityHeaders,
    };
    if (advanced) entry.advanced = advanced;
    if (css)      entry.css      = css;
    if (cwv)      entry.cwv      = cwv;
    if (darkOut)  entry.darkMode = { out: darkOut };
    return entry;
  } catch (e) {
    return { ok: false, url: pageUrl, route, error: e.message };
  } finally {
    page.off('pageerror', errHandler);
  }
}

// ── Multi-page mode ───────────────────────────────────────────────────────────
async function multiPage() {
  const prefix = outArg.replace(/\.png$/i, '');
  const outDir = path.dirname(prefix);
  if (outDir && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  // Shared context with optional HAR (captures all pages in one file)
  const contextOpts = {};
  let harPath;
  if (harCapture) {
    harPath = prefix + '-multipage.har';
    contextOpts.recordHar = { path: harPath, mode: 'minimal' };
  }
  const sharedContext = await browser.newContext(contextOpts);

  const results = [];

  if (navStrat === 'tab-click') {
    const page = await sharedContext.newPage();
    await page.setViewportSize({ width, height });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const tabs = await discoverTabs(page);

    if (tabs.length === 0) {
      const outPath = `${prefix}-root.png`;
      await page.screenshot({ path: outPath, fullPage: false });
      const a11y = await runAxe(page);
      const [meta, images, bundle, fonts] = await Promise.all([
        runMetaAudit(page), runImageAudit(page, {}), runBundleAudit(page), runFontAudit(page),
      ]);
      results.push({ ok: true, url, route: '/', out: outPath, width, height,
                     consoleErrors: [], a11y, meta, images, bundle, fonts,
                     securityHeaders: null, note: 'no-tabs-found' });
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
          let darkOut;
          if (darkMode) darkOut = await captureDarkMode(page, outPath);
          const [meta, images, bundle, fonts] = await Promise.all([
            runMetaAudit(page), runImageAudit(page, {}), runBundleAudit(page), runFontAudit(page),
          ]);
          const entry = { ok: true, url, route: `tab:${label}`, tab: tab.index,
                          out: outPath, width, height, consoleErrors: errors, a11y,
                          meta, images, bundle, fonts, securityHeaders: null };
          if (advanced) entry.advanced = advanced;
          if (darkOut)  entry.darkMode = { out: darkOut };
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
    // link-crawl
    let routes;
    if (routeArg === 'auto') {
      const discPage = await sharedContext.newPage();
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
      const page    = await sharedContext.newPage();
      const entry   = await pageChecks(page, pageUrl, outPath, route);
      results.push(entry);
      await page.close();
    }
  }

  await sharedContext.close(); // flushes HAR
  await browser.close();

  if (harPath) results.forEach(r => { if (r.ok) r.harPath = harPath; });
  process.stdout.write(JSON.stringify(results) + '\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────
(multiMode ? multiPage() : singlePage()).catch(e => {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
  process.exit(1);
});
