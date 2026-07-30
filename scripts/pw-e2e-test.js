// pw-e2e-test.js — Playwright smoke test with optional advanced UI checks.
//
// Single-page (backward-compat):
//   node pw-e2e-test.js <url> <out.png> [width] [height] [flags]
//   → stdout: JSON object { ok, url, out, width, height, consoleErrors, a11y,
//                           meta, images, scripts, touchTargets, bundle, fonts,
//                           securityHeaders, [redirects], [advanced], [css], [cwv],
//                           [darkMode], [darkModeA11y], [diff], [harPath],
//                           [reducedMotion], [forcedColors], [print], [noJs],
//                           [focusAudit] }
//
// Multi-page:
//   node pw-e2e-test.js <url> <out-prefix> [width] [height] --routes=auto|/r1,/r2 [--nav=link-crawl|tab-click]
//   → stdout: JSON array  [{ ok, url, route, out, ..., meta, images, scripts,
//                            touchTargets, bundle, fonts, securityHeaders, [redirects],
//                            [advanced], [css], [cwv], [darkMode], [darkModeA11y] }, ...]
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
//   --dark-mode          Extra screenshot + axe-core run with prefers-color-scheme: dark
//   --css-coverage       CSS coverage report (unused % per stylesheet)
//   --har                Record network activity as HAR file (<outBase>.har)
//   --cwv                Core Web Vitals (LCP, CLS+sources, FCP, TTFB, TBT via PerformanceObserver)
//   --compare=<path>     Pixel-diff current screenshot vs baseline PNG (creates baseline on first run)
//   --reduced-motion     Extra screenshot with prefers-reduced-motion: reduce
//   --forced-colors      Extra screenshot with forced-colors: active (Windows High Contrast)
//   --print              Extra screenshot with media: print emulated (print stylesheet)
//   --no-js              Extra screenshot with JavaScript disabled (progressive enhancement check)
//   --focus-audit        Tab through focusable elements; flag missing visible focus rings
//
// Always-on for real URLs (zero-overhead additions to JSON output):
//   meta            OpenGraph/SEO meta audit + JSON-LD structured data + viewport zoom check
//   images          Image quality (broken, oversized, missing alt, legacy formats, lazy-above-fold)
//   scripts         Third-party script audit (SRI, async/defer, known trackers)
//   touchTargets    WCAG 2.5.8 touch target size (interactive elements < 24px)
//   bundle          Resource size summary (JS/CSS/img KB via Performance API)
//   fonts           Font loading status + font-display FOUT/FOIT risk
//   securityHeaders HTTP security header presence (CSP, HSTS, X-Frame-Options, etc.)
//   redirects       Redirect chain (if any 3xx responses detected during navigation)
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

const darkMode     = flags['dark-mode']      === 'true';
const cssCoverage  = flags['css-coverage']   === 'true';
const harCapture   = flags['har']            === 'true';
const cwvMode      = flags['cwv']            === 'true';
const comparePath  = flags['compare']        || null;
const reducedMotion= flags['reduced-motion'] === 'true';
const forcedColors = flags['forced-colors']  === 'true';
const printLayout  = flags['print']          === 'true';
const noJsMode     = flags['no-js']          === 'true';
const focusAudit   = flags['focus-audit']    === 'true';

// ── Response tracking (security headers + image formats + redirect chain) ─────
function setupResponseTracking(page) {
  const securityHeaders = {};
  const imageFormats    = {};
  const redirectChain   = [];
  let secCaptured = false;

  page.on('response', response => {
    try {
      const status  = response.status();
      const headers = response.headers();

      // Redirect chain
      if ([301, 302, 303, 307, 308].includes(status)) {
        redirectChain.push({
          from:     response.url(),
          status,
          to:       headers['location'] || null,
        });
      }

      // Security headers (from first document response)
      if (!secCaptured && response.request().resourceType() === 'document' && status < 400) {
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

      // Image format tracking
      const ct = headers['content-type'];
      if (ct && ct.startsWith('image/')) {
        imageFormats[response.url()] = ct.split(';')[0].trim();
      }
    } catch {}
  });

  return {
    getSecurityHeaders: () => (secCaptured ? securityHeaders : null),
    getImageFormats:    () => imageFormats,
    getRedirectChain:   () => redirectChain,
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
    const hasGSAP         = typeof window.gsap   !== 'undefined';
    const hasThreeJS      = typeof window.THREE  !== 'undefined';
    const hasMotion       = typeof window.motion !== 'undefined';
    const hasLottie       = document.querySelectorAll('[class*="lottie"], lottie-player, dotlottie-player').length > 0;
    const hasSVGAnimations= document.querySelectorAll('animate, animateTransform, animateMotion').length > 0;
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

    // Viewport zoom anti-pattern check
    const viewportContent = get('meta[name="viewport"]');
    const blocksZoom = viewportContent ? (
      viewportContent.includes('user-scalable=no') ||
      viewportContent.includes('user-scalable=0') ||
      /maximum-scale=[01][,\s]/.test(viewportContent) ||
      viewportContent.includes('maximum-scale=1.0')
    ) : false;

    // JSON-LD structured data extraction
    const structuredData = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map(s => {
        try { return { type: JSON.parse(s.textContent)['@type'] || 'Unknown', parseError: null }; }
        catch (e) { return { type: null, parseError: e.message.slice(0, 80) }; }
      });

    const issues = [
      !title                                  && 'Missing <title>',
      title && title.length > 60              && `Title too long (${title.length} chars, max 60)`,
      title && title.length < 10              && `Title too short (${title.length} chars)`,
      !desc                                   && 'Missing meta description',
      desc  && desc.length > 160              && `Description too long (${desc.length} chars, max 160)`,
      !get('link[rel="canonical"]', 'href')   && 'Missing canonical link',
      !ogImg                                  && 'Missing og:image',
      !viewportContent                        && 'Missing viewport meta',
      !get('meta[property="og:title"]')       && 'Missing og:title',
      blocksZoom                              && 'Viewport blocks user zoom (WCAG 1.4.4)',
      structuredData.some(sd => sd.parseError) && 'JSON-LD parse error detected',
    ].filter(Boolean);

    return {
      title,
      description: desc,
      canonical:   get('link[rel="canonical"]', 'href'),
      robots:      get('meta[name="robots"]'),
      viewport:    viewportContent,
      blocksZoom,
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
      structuredData: {
        count:      structuredData.length,
        types:      structuredData.filter(sd => sd.type).map(sd => sd.type),
        parseErrors: structuredData.filter(sd => sd.parseError).map(sd => sd.parseError),
      },
      issues,
    };
  });
}

async function runImageAudit(page, imageFormats) {
  const imgData = await page.evaluate(() => {
    const vh = window.innerHeight;
    return [...document.querySelectorAll('img')].map(img => {
      const rect = img.getBoundingClientRect();
      const isAboveFold = rect.bottom <= vh && rect.top >= 0 && rect.width > 0;
      const isBelowFold = rect.top > vh;
      const hasLazy     = img.loading === 'lazy';
      const hasFP       = img.getAttribute('fetchpriority') === 'high';

      let foldIssue = null;
      if (isAboveFold && hasLazy)   foldIssue = 'LAZY_ABOVE_FOLD';    // hurts LCP
      else if (isBelowFold && !hasLazy) foldIssue = 'MISSING_LAZY';   // wastes bandwidth

      const isHeroCandidate = isAboveFold && img.clientWidth > 300 && !hasFP && !hasLazy;

      return {
        src:        img.currentSrc || img.src || '',
        missingAlt: img.alt === '' && img.getAttribute('role') !== 'presentation' && img.getAttribute('aria-hidden') !== 'true',
        broken:     img.complete && img.naturalWidth === 0 && img.src !== '',
        naturalW:   img.naturalWidth,
        naturalH:   img.naturalHeight,
        displayW:   img.clientWidth,
        displayH:   img.clientHeight,
        oversized:  img.naturalWidth > img.clientWidth * 2 && img.clientWidth > 0 && img.naturalWidth > 200,
        lazy:       hasLazy,
        foldIssue,
        isHeroCandidate,
      };
    });
  });

  const legacyFormats = Object.entries(imageFormats)
    .filter(([, ct]) => ct === 'image/jpeg' || ct === 'image/png')
    .map(([u]) => u.split('/').pop().split('?')[0]);

  const lazyAboveFold = imgData.filter(i => i.foldIssue === 'LAZY_ABOVE_FOLD');
  const missingLazy   = imgData.filter(i => i.foldIssue === 'MISSING_LAZY');
  const heroCandidates= imgData.filter(i => i.isHeroCandidate);

  return {
    total:           imgData.length,
    broken:          imgData.filter(i => i.broken).length,
    missingAlt:      imgData.filter(i => i.missingAlt).length,
    oversized:       imgData.filter(i => i.oversized).length,
    notLazy:         imgData.filter(i => !i.lazy && i.displayW > 100).length,
    legacyFormats:   legacyFormats.length,
    lazyAboveFold:   lazyAboveFold.length,
    missingFetchPriority: heroCandidates.length,
    details: {
      broken:          imgData.filter(i => i.broken).map(i => i.src),
      missingAlt:      imgData.filter(i => i.missingAlt).map(i => i.src || '(no src)'),
      oversized:       imgData.filter(i => i.oversized).map(i => ({
        src:     i.src,
        natural: `${i.naturalW}×${i.naturalH}`,
        display: `${i.displayW}×${i.displayH}`,
      })),
      lazyAboveFold:   lazyAboveFold.map(i => i.src),
      heroMissingFP:   heroCandidates.map(i => i.src),
    },
    warnings: [
      lazyAboveFold.length > 0   && `${lazyAboveFold.length} above-fold image(s) marked lazy — hurts LCP`,
      heroCandidates.length > 0  && `${heroCandidates.length} large above-fold image(s) missing fetchpriority="high"`,
    ].filter(Boolean),
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
      } catch {} // cross-origin stylesheet
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

async function runScriptAudit(page) {
  return page.evaluate(() => {
    const pageOrigin = location.origin;
    const TRACKERS = {
      'google-analytics.com':  'Google Analytics',
      'googletagmanager.com':  'Google Tag Manager',
      'connect.facebook.net':  'Facebook Pixel',
      'static.hotjar.com':     'Hotjar',
      'widget.intercom.io':    'Intercom',
      'cdn.segment.com':       'Segment',
      'js.stripe.com':         'Stripe',
      'snap.licdn.com':        'LinkedIn Insight',
      'platform.twitter.com':  'Twitter Widget',
      'script.crazyegg.com':   'Crazy Egg',
    };

    const scripts = [...document.querySelectorAll('script[src]')].map(s => {
      let origin;
      try { origin = new URL(s.src).origin; } catch { return null; }
      const isThirdParty = origin !== pageOrigin;
      const tracker = Object.entries(TRACKERS).find(([k]) => s.src.includes(k));
      return {
        src:         s.src.slice(0, 100),
        origin,
        isThirdParty,
        trackerName: tracker?.[1] || null,
        hasSRI:      !!s.integrity,
        isAsync:     s.async,
        isDefer:     s.defer,
        isModule:    s.type === 'module',
      };
    }).filter(Boolean);

    const thirdParty      = scripts.filter(s => s.isThirdParty);
    const missingSRI      = thirdParty.filter(s => !s.hasSRI);
    const renderBlocking  = thirdParty.filter(s => !s.isAsync && !s.isDefer && !s.isModule);
    const trackers        = thirdParty.filter(s => s.trackerName).map(s => s.trackerName);

    return {
      total:            scripts.length,
      thirdPartyCount:  thirdParty.length,
      missingSRI:       missingSRI.length,
      renderBlocking:   renderBlocking.length,
      trackers:         [...new Set(trackers)],
      warnings: [
        missingSRI.length     > 0 && `${missingSRI.length} third-party script(s) missing SRI hash`,
        renderBlocking.length > 0 && `${renderBlocking.length} render-blocking third-party script(s)`,
      ].filter(Boolean),
      details: thirdParty.slice(0, 10),
    };
  });
}

async function runTouchTargetAudit(page) {
  return page.evaluate(() => {
    const MIN_AA = 24;  // WCAG 2.5.8 AA (WCAG 2.2)
    const SEL    = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="tab"]';
    const failing = [...document.querySelectorAll(SEL)].map(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      if (window.getComputedStyle(el).display === 'none') return null;
      const failsAA = r.width < MIN_AA || r.height < MIN_AA;
      if (!failsAA) return null;
      return {
        tag:    el.tagName,
        text:   (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40),
        width:  Math.round(r.width),
        height: Math.round(r.height),
      };
    }).filter(Boolean);

    return {
      failingAA: failing.length,
      details:   failing.slice(0, 10),
      warnings:  failing.length > 0 ? [`${failing.length} interactive element(s) below 24×24px (WCAG 2.5.8)`] : [],
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

// Installs CWV, CLS-source, and long-task observers before navigation
async function installCWVObserver(page) {
  await page.addInitScript(() => {
    window.__vitals = { cls: 0, shifts: [], longTasks: [] };
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput) continue;
          window.__vitals.cls += e.value;
          if (e.sources) {
            for (const src of e.sources) {
              if (src.node) {
                try {
                  window.__vitals.shifts.push({
                    value:     parseFloat(e.value.toFixed(4)),
                    startTime: Math.round(e.startTime),
                    element:   {
                      tag:      src.node.tagName,
                      id:       src.node.id || null,
                      class:    (src.node.className || '').split(' ').filter(Boolean)[0] || null,
                      prevRect: src.previousRect
                        ? { x: Math.round(src.previousRect.x), y: Math.round(src.previousRect.y), w: Math.round(src.previousRect.width), h: Math.round(src.previousRect.height) }
                        : null,
                      currRect: src.currentRect
                        ? { x: Math.round(src.currentRect.x),  y: Math.round(src.currentRect.y),  w: Math.round(src.currentRect.width),  h: Math.round(src.currentRect.height)  }
                        : null,
                    },
                  });
                } catch {}
              }
            }
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {}
    try {
      new PerformanceObserver(list => {
        list.getEntries().forEach(e =>
          window.__vitals.longTasks.push({ duration: Math.round(e.duration), startTime: Math.round(e.startTime) })
        );
      }).observe({ type: 'longtask', buffered: true });
    } catch {}
  });
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
      const shifts = window.__vitals?.shifts || [];
      const tasks  = window.__vitals?.longTasks || [];
      const tbt    = Math.round(tasks.reduce((s, t) => s + Math.max(0, t.duration - 50), 0));
      const rate   = (v, g, ni) => v == null ? null : v <= g ? 'good' : v <= ni ? 'needs-improvement' : 'poor';
      return {
        lcp:  lcp  != null ? Math.round(lcp)            : null,
        cls:  cls  != null ? parseFloat(cls.toFixed(4)) : null,
        fcp:  fcp  != null ? Math.round(fcp)            : null,
        ttfb, tbt,
        clsSources: shifts.sort((a, b) => b.value - a.value).slice(0, 5),
        longTasks:  tasks.sort((a, b) => b.duration - a.duration).slice(0, 5),
        ratings: {
          lcp: rate(lcp, 2500, 4000),
          cls: rate(cls, 0.1,  0.25),
          fcp: rate(fcp, 1800, 3000),
          tbt: rate(tbt, 200,  600),
        },
      };
    });
  } catch (e) {
    return { error: e.message };
  }
}

// Dark mode screenshot; optionally keep dark emulation active for further checks
async function captureDarkMode(page, outPath, keepEmulation = false) {
  const darkPath = outPath.replace(/\.png$/i, '') + '-dark.png';
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: darkPath, fullPage: false });
  if (!keepEmulation) await page.emulateMedia({ colorScheme: 'light' });
  return darkPath;
}

// Reduced motion screenshot
async function captureReducedMotion(page, outPath) {
  const rmPath = outPath.replace(/\.png$/i, '') + '-reduced-motion.png';
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: rmPath, fullPage: false });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  return rmPath;
}

// Forced colors / Windows High Contrast screenshot
async function captureForcedColors(page, outPath) {
  const fcPath = outPath.replace(/\.png$/i, '') + '-forced-colors.png';
  await page.emulateMedia({ forcedColors: 'active' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: fcPath, fullPage: false });
  await page.emulateMedia({ forcedColors: 'none' });
  return fcPath;
}

// Print layout screenshot
async function capturePrintLayout(page, outPath) {
  const printPath = outPath.replace(/\.png$/i, '') + '-print.png';
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: printPath, fullPage: true });
  await page.emulateMedia({ media: 'screen' });
  return printPath;
}

// Progressive enhancement: screenshot with JS disabled (new context, single-page only)
async function captureNoJS(browser, pageUrl, outBase, w, h) {
  const noJsContext = await browser.newContext({ javaScriptEnabled: false });
  const noJsPage    = await noJsContext.newPage();
  await noJsPage.setViewportSize({ width: w, height: h });
  try {
    await noJsPage.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const noJsPath     = outBase + '-no-js.png';
    await noJsPage.screenshot({ path: noJsPath, fullPage: false });
    const contentLength = await noJsPage.evaluate(() => document.body.innerText.trim().length);
    const hasContent    = contentLength > 100;
    return {
      out: noJsPath,
      contentLength,
      hasContent,
      warning: !hasContent ? 'Page has < 100 chars of text without JS — likely a blank SPA with no SSR' : null,
    };
  } catch (e) {
    return { error: e.message };
  } finally {
    await noJsContext.close();
  }
}

// Keyboard focus ring audit: Tab through up to 20 focusable elements
async function runFocusAuditFn(page, outBase) {
  const focusableCount = await page.evaluate(() =>
    document.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ).length
  );
  const maxTabs = Math.min(focusableCount, 20);
  const focusResults = [];
  await page.evaluate(() => { try { document.activeElement?.blur(); } catch {} });

  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const style = window.getComputedStyle(el);
      const rect  = el.getBoundingClientRect();
      return {
        tag:             el.tagName,
        id:              el.id || null,
        text:            (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40),
        outlineStyle:    style.outlineStyle,
        outlineWidth:    style.outlineWidth,
        hasVisibleFocus: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
        rect:            { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      };
    });
    if (focused) {
      if (!focused.hasVisibleFocus) {
        try {
          const ssPath = `${outBase}-focus-${i}.png`;
          await page.screenshot({ path: ssPath, fullPage: false });
          focused.screenshot = ssPath;
        } catch {}
      }
      focusResults.push(focused);
    }
  }

  const missing = focusResults.filter(f => !f.hasVisibleFocus);
  return {
    tabStopsTested:  focusResults.length,
    missingFocusRing: missing.length,
    focusRingPct:    focusResults.length > 0 ? Math.round((1 - missing.length / focusResults.length) * 100) : 100,
    warnings:        missing.length > 0 ? [`${missing.length}/${focusResults.length} focusable elements have no visible focus ring (WCAG 2.4.7)`] : [],
    details:         focusResults,
  };
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

// ── Shared full-page audit (used by both singlePage and pageChecks) ────────────
async function runFullAudit(page, outPath, outBase, tracker, isFirstPage = false) {
  const [meta, images, scripts, touchTargets, bundle, fonts] = await Promise.all([
    runMetaAudit(page),
    runImageAudit(page, tracker.getImageFormats()),
    runScriptAudit(page),
    runTouchTargetAudit(page),
    runBundleAudit(page),
    runFontAudit(page),
  ]);
  const securityHeaders = tracker.getSecurityHeaders();
  const redirectChain   = tracker.getRedirectChain();

  // Dark mode: screenshot + axe
  let darkMode_, darkModeA11y_;
  if (darkMode) {
    const darkOut_ = await captureDarkMode(page, outPath, true); // keep emulation
    const dmA11y   = await runAxe(page);
    await page.emulateMedia({ colorScheme: 'light' });
    darkMode_     = { out: darkOut_ };
    darkModeA11y_ = dmA11y;
  }

  // Reduced motion
  let reducedMotion_;
  if (reducedMotion) {
    reducedMotion_ = { out: await captureReducedMotion(page, outPath) };
  }

  // Forced colors
  let forcedColors_;
  if (forcedColors) {
    forcedColors_ = { out: await captureForcedColors(page, outPath) };
  }

  // Print layout
  let print_;
  if (printLayout) {
    print_ = { out: await capturePrintLayout(page, outPath) };
  }

  return {
    meta, images, scripts, touchTargets, bundle, fonts, securityHeaders,
    ...(redirectChain.length > 0 && { redirects: redirectChain }),
    ...(darkMode_     && { darkMode: darkMode_ }),
    ...(darkModeA11y_ && { darkModeA11y: darkModeA11y_ }),
    ...(reducedMotion_&& { reducedMotion: reducedMotion_ }),
    ...(forcedColors_ && { forcedColors: forcedColors_ }),
    ...(print_        && { print: print_ }),
  };
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

  // Advanced checks
  let advanced;
  if (anyAdvFlag) {
    const detected = await detectFeatures(page);
    advanced = await runAdvanced(page, outBase, detected);
  }

  // Always-on audits + flag-gated screenshots (real URLs only)
  let auditResult = {};
  if (url !== 'about:blank') {
    auditResult = await runFullAudit(page, outArg, outBase, tracker);
  }

  // CWV (requires 2s settle time — run after other audits)
  let cwv;
  if (cwvMode && url !== 'about:blank') cwv = await runCWV(page);

  // No-JS screenshot (single-page only — needs fresh browser context)
  let noJs;
  if (noJsMode && url !== 'about:blank') {
    noJs = await captureNoJS(browser, url, outBase, width, height);
  }

  // Focus audit (modifies page state — run last)
  let focusAuditResult;
  if (focusAudit && url !== 'about:blank') {
    focusAuditResult = await runFocusAuditFn(page, outBase);
  }

  await context.close(); // flushes HAR
  await browser.close();

  const result = { ok: true, url, out: outArg, width, height, consoleErrors: errors, a11y };
  Object.assign(result, auditResult);
  if (advanced)          result.advanced    = advanced;
  if (css)               result.css         = css;
  if (cwv)               result.cwv         = cwv;
  if (diff)              result.diff        = diff;
  if (harPath)           result.harPath     = harPath;
  if (noJs)              result.noJs        = noJs;
  if (focusAuditResult)  result.focusAudit  = focusAuditResult;

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

    const a11y = await runAxe(page);
    let advanced;
    if (anyAdvFlag) {
      const detected = await detectFeatures(page);
      advanced = await runAdvanced(page, outPath.replace(/\.png$/i, ''), detected);
    }

    const auditResult = await runFullAudit(page, outPath, outPath.replace(/\.png$/i, ''), tracker);

    let cwv;
    if (cwvMode) cwv = await runCWV(page);

    let focusAuditResult;
    if (focusAudit) {
      focusAuditResult = await runFocusAuditFn(page, outPath.replace(/\.png$/i, ''));
    }

    const entry = { ok: true, url: pageUrl, route, out: outPath, width, height, consoleErrors: errors, a11y };
    Object.assign(entry, auditResult);
    if (advanced)         entry.advanced   = advanced;
    if (css)              entry.css        = css;
    if (cwv)              entry.cwv        = cwv;
    if (focusAuditResult) entry.focusAudit = focusAuditResult;
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

  // Shared context with optional HAR
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
      const a11y       = await runAxe(page);
      const tracker_   = setupResponseTracking(page);
      const auditResult= await runFullAudit(page, outPath, outPath.replace(/\.png$/i, ''), tracker_);
      results.push({ ok: true, url, route: '/', out: outPath, width, height,
                     consoleErrors: [], a11y, ...auditResult, note: 'no-tabs-found' });
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
          const outPath  = `${prefix}-tab-${label}.png`;
          await page.screenshot({ path: outPath, fullPage: false });
          const a11y = await runAxe(page);
          let advanced;
          if (anyAdvFlag) {
            const detected = await detectFeatures(page);
            advanced = await runAdvanced(page, outPath.replace(/\.png$/i, ''), detected);
          }
          const tracker_    = setupResponseTracking(page);
          const auditResult = await runFullAudit(page, outPath, outPath.replace(/\.png$/i, ''), tracker_);
          const entry = { ok: true, url, route: `tab:${label}`, tab: tab.index,
                          out: outPath, width, height, consoleErrors: errors, a11y, ...auditResult };
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
