// pw-e2e-test.js — Playwright smoke test with optional advanced UI checks.
//
// Single-page: node pw-e2e-test.js <url> <out.png> [width] [height] [flags]
// Multi-page:  node pw-e2e-test.js <url> <prefix> [w] [h] --routes=auto|/r1,/r2 [--nav=link-crawl|tab-click]
//
// Always-on for real URLs (zero overhead):
//   meta            SEO/OG, JSON-LD, blocksZoom, lang, charset, dir
//   images          broken, missingAlt, oversized, lazy-above-fold, missingSrcset, missingFetchPriority
//   scripts         third-party SRI, render-blocking, trackers, stylesheet SRI, pre-consent tracker calls
//   touchTargets    WCAG 2.5.8 interactive elements < 24px
//   headings        h1 count, level-skip detection
//   domA11y         ARIA broken refs, unlabeled inputs
//   links           generic anchor text (hurts SEO + screen readers)
//   layout          horizontal scroll / viewport overflow
//   bundle          JS/CSS/img KB, protocol, missing preconnect hints
//   fonts           loaded/failed, FOIT/FOUT risk
//   cookies         Secure/SameSite flags on Set-Cookie headers
//   securityHeaders CSP (+ strength), HSTS, X-Frame-Options, mixed content, unsandboxed iframes
//   redirects       3xx redirect chain (when present)
//
// Extended flags (single-page + multi-page):
//   --dark-mode       screenshot + axe in dark mode → darkMode, darkModeA11y
//   --css-coverage    unused CSS % per stylesheet → css
//   --har             network HAR file → harPath
//   --cwv             LCP, CLS+sources, FCP, TTFB, TBT → cwv
//   --compare=<path>  pixel-diff vs baseline → diff
//   --reduced-motion  prefers-reduced-motion screenshot → reducedMotion
//   --forced-colors   forced-colors: active screenshot → forcedColors
//   --print           media: print screenshot → print
//   --no-js           JS-disabled screenshot → noJs
//   --focus-audit     keyboard focus ring audit → focusAudit
//   --pwa             web app manifest + service worker check → pwa
//   --img-format      WebP/AVIF content negotiation check → imgFormat
//   --link-check      broken internal link check (HEAD, cap 20) → linkCheck
//   --seo-deep        robots.txt, sitemap, hreflang → seoDeep
//   --budget-js=N     JS KB budget (adds budget.exceeded[] if over)
//   --budget-css=N    CSS KB budget
//   --budget-total=N  total transfer KB budget
//   --budget-requests=N  max request count budget
//
// Advanced flags (auto-detected or explicit):
//   --detect-advanced  auto-enable animation/hover/scroll based on page features
//   --animated         multi-frame capture + FPS
//   --hover            hover state screenshots
//   --scroll           scroll position screenshots
//   --video            3-second .webm recording
//
// Cap: 15 routes (link-crawl), 10 tabs (tab-click).

const { chromium }   = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
const path           = require('path');
const fs             = require('fs');

// ── Tracker domain registry (shared between response tracking and DOM audit) ──
const TRACKER_DOMAINS = {
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
const pwaMode      = flags['pwa']            === 'true';
const imgFormatMode= flags['img-format']     === 'true';
const linkCheckMode= flags['link-check']     === 'true';
const seoDeepMode  = flags['seo-deep']       === 'true';
const budgetJs     = parseInt(flags['budget-js']       || '0', 10) || null;
const budgetCss    = parseInt(flags['budget-css']      || '0', 10) || null;
const budgetTotal  = parseInt(flags['budget-total']    || '0', 10) || null;
const budgetReqs   = parseInt(flags['budget-requests'] || '0', 10) || null;
const anyBudget    = !!(budgetJs || budgetCss || budgetTotal || budgetReqs);

// ── Response tracking ─────────────────────────────────────────────────────────
function setupResponseTracking(page) {
  const securityHeaders    = {};
  const imageFormats       = {};
  const redirectChain      = [];
  const mixedContent       = [];
  const cookiesInsecure    = [];
  const preConsentTrackers = [];
  let secCaptured = false;
  let pageIsHttps = null;

  page.on('response', response => {
    try {
      const status  = response.status();
      const headers = response.headers();
      const resUrl  = response.url();
      const resType = response.request().resourceType();

      // Redirect chain
      if ([301, 302, 303, 307, 308].includes(status)) {
        redirectChain.push({ from: resUrl, status, to: headers['location'] || null });
      }

      // Security headers + HTTPS detection (from first document response)
      if (!secCaptured && resType === 'document' && status < 400) {
        pageIsHttps = resUrl.startsWith('https://');
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

      // Mixed content: HTTP sub-resource on HTTPS page
      if (pageIsHttps && resUrl.startsWith('http://') &&
          !resUrl.startsWith('http://localhost') && !resUrl.startsWith('http://127.')) {
        mixedContent.push({ url: resUrl.slice(0, 100), type: resType });
      }

      // Cookie security (Secure + SameSite flags)
      const setCookieRaw = headers['set-cookie'];
      if (setCookieRaw) {
        for (const line of setCookieRaw.split('\n')) {
          if (!line.trim()) continue;
          const name      = (line.split('=')[0] || '').trim().slice(0, 30);
          const lower     = line.toLowerCase();
          const hasSecure = /;\s*secure/.test(lower);
          const ssMatch   = lower.match(/;\s*samesite=(\w+)/);
          const sameSite  = ssMatch ? ssMatch[1] : null;
          const issues = [];
          if (pageIsHttps && !hasSecure) issues.push('missing Secure');
          if (!sameSite)                 issues.push('missing SameSite');
          if (issues.length) cookiesInsecure.push({ name, issues, sameSite: sameSite || 'not set' });
        }
      }

      // Pre-consent tracker calls (fire at load time = before any user interaction)
      for (const [domain, trackerName] of Object.entries(TRACKER_DOMAINS)) {
        if (resUrl.includes(domain)) {
          preConsentTrackers.push({ url: resUrl.slice(0, 80), name: trackerName });
          break;
        }
      }

      // Image format tracking
      const ct = headers['content-type'];
      if (ct && ct.startsWith('image/')) {
        imageFormats[resUrl] = ct.split(';')[0].trim();
      }
    } catch {}
  });

  return {
    getSecurityHeaders:     () => (secCaptured ? securityHeaders : null),
    getImageFormats:        () => imageFormats,
    getRedirectChain:       () => redirectChain,
    getMixedContent:        () => mixedContent,
    getCookiesInsecure:     () => cookiesInsecure,
    getPreConsentTrackers:  () => preConsentTrackers,
  };
}

// ── CSP strength evaluation (Node-only, no browser needed) ────────────────────
function computeCspStrength(cspStr) {
  if (!cspStr) return null;
  const issues = [];
  const dirs = cspStr.split(';').map(d => d.trim().toLowerCase());
  const getDir = n => dirs.find(d => d.startsWith(n)) || '';
  const scriptSrc = getDir('script-src') || getDir('default-src');
  if (!scriptSrc)                             issues.push('No script-src or default-src');
  if (scriptSrc.includes("'unsafe-inline'"))  issues.push("'unsafe-inline' allows inline XSS");
  if (scriptSrc.includes("'unsafe-eval'"))    issues.push("'unsafe-eval' allows eval() XSS");
  if (/ \*[ ;]/.test(scriptSrc + ' '))        issues.push('Wildcard (*) in script-src');
  if (scriptSrc.includes('data:'))            issues.push("data: URI in script-src");
  return { score: issues.length === 0 ? 'strong' : issues.length <= 2 ? 'weak' : 'very-weak', issues };
}

// ── Accessibility ─────────────────────────────────────────────────────────────
async function runAxe(page) {
  try {
    const results  = await new AxeBuilder({ page }).analyze();
    const critical = results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
    return {
      violations: results.violations.length,
      critical:   critical.length,
      details:    results.violations.map(v => ({ id: v.id, impact: v.impact, description: v.description, nodes: v.nodes.length })),
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
    canvasEls.forEach(c => { try { if (c.getContext('webgl') || c.getContext('webgl2')) hasWebGL = true; } catch {} });
    const els = Array.from(document.querySelectorAll('*')).slice(0, 300);
    let hasAnimations = false, hasTransitions = false;
    for (const el of els) {
      const s = getComputedStyle(el);
      if (!hasAnimations && s.animationName && s.animationName !== 'none') hasAnimations = true;
      if (!hasTransitions && s.transitionDuration && s.transitionDuration !== '0s') hasTransitions = true;
      if (hasAnimations && hasTransitions) break;
    }
    return {
      hasCanvas, hasWebGL, hasAnimations, hasTransitions,
      hasGSAP:         typeof window.gsap   !== 'undefined',
      hasThreeJS:      typeof window.THREE  !== 'undefined',
      hasMotion:       typeof window.motion !== 'undefined',
      hasLottie:       document.querySelectorAll('[class*="lottie"], lottie-player, dotlottie-player').length > 0,
      hasSVGAnimations:document.querySelectorAll('animate, animateTransform, animateMotion').length > 0,
    };
  });
}

// ── FPS measurement ───────────────────────────────────────────────────────────
async function measureFPS(page) {
  try {
    const fps = await page.evaluate(() => new Promise(resolve => {
      let frames = 0;
      const start = performance.now();
      function tick() { frames++; if (performance.now() - start < 1000) requestAnimationFrame(tick); else resolve(Math.round(frames)); }
      requestAnimationFrame(tick);
    }));
    return { fps, fpsStatus: fps >= 55 ? 'smooth' : fps >= 30 ? 'reduced' : 'janky' };
  } catch { return { fps: null, fpsStatus: 'unknown' }; }
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
      const label = await el.evaluate(e => (e.textContent || e.getAttribute('aria-label') || e.className || '').trim().replace(/\s+/g, '-').slice(0, 30));
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
    await page.evaluate(p => { const max = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1); window.scrollTo({ top: max * (p / 100), behavior: 'instant' }); }, pct);
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
  const context  = await browser.newContext({ viewport: { width: w, height: h }, recordVideo: { dir: videoDir, size: { width: w, height: h } } });
  const page     = await context.newPage();
  try { await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(3000); } catch {}
  await context.close();
  try { const src = await page.video().path(); const dest = `${outBase}-recording.webm`; if (src && fs.existsSync(src)) fs.renameSync(src, dest); return dest; } catch { return null; }
  finally { await browser.close(); }
}

// ── Advanced checks orchestration ─────────────────────────────────────────────
async function runAdvanced(page, outBase, detected) {
  const needsAnim   = forceAnim   || (detectAdv && (detected.hasAnimations || detected.hasGSAP || detected.hasMotion || detected.hasLottie || detected.hasSVGAnimations || detected.hasCanvas || detected.hasWebGL || detected.hasThreeJS));
  const needsHover  = forceHover  || (detectAdv && detected.hasTransitions);
  const needsScroll = forceScroll || (detectAdv && (detected.hasAnimations || detected.hasGSAP || detected.hasMotion));
  const needsFPS    = needsAnim   || (detectAdv && (detected.hasCanvas || detected.hasWebGL || detected.hasThreeJS));
  const adv = { detected };
  if (needsFPS)    { const { fps, fpsStatus } = await measureFPS(page); adv.fps = fps; adv.fpsStatus = fpsStatus; }
  if (needsAnim)   adv.frames = await captureFrames(page, outBase);
  if (needsHover)  adv.hover  = await captureHoverStates(page, outBase);
  if (needsScroll) adv.scroll = await captureScrollStates(page, outBase);
  if (forceVideo)  adv.video  = await recordVideo(url, outBase, width, height);
  return adv;
}

// ── Always-on audit helpers ───────────────────────────────────────────────────

async function runMetaAudit(page) {
  return page.evaluate(() => {
    const get = (sel, attr = 'content') => document.querySelector(sel)?.[attr] ?? null;
    const title = document.title;
    const desc  = get('meta[name="description"]');
    const ogImg = get('meta[property="og:image"]');
    const viewportContent = get('meta[name="viewport"]');
    const blocksZoom = viewportContent ? (
      viewportContent.includes('user-scalable=no') ||
      viewportContent.includes('user-scalable=0') ||
      /maximum-scale=[01][,\s]/.test(viewportContent) ||
      viewportContent.includes('maximum-scale=1.0')
    ) : false;
    const structuredData = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map(s => { try { return { type: JSON.parse(s.textContent)['@type'] || 'Unknown', parseError: null }; } catch (e) { return { type: null, parseError: e.message.slice(0, 80) }; } });
    const lang    = document.documentElement.lang || null;
    const charset = document.characterSet || null;
    const dir     = document.documentElement.dir || 'ltr';
    const issues = [
      !title                                    && 'Missing <title>',
      title && title.length > 60                && `Title too long (${title.length} chars, max 60)`,
      title && title.length < 10                && `Title too short (${title.length} chars)`,
      !desc                                     && 'Missing meta description',
      desc && desc.length > 160                 && `Description too long (${desc.length} chars, max 160)`,
      !get('link[rel="canonical"]', 'href')     && 'Missing canonical link',
      !ogImg                                    && 'Missing og:image',
      !viewportContent                          && 'Missing viewport meta',
      !get('meta[property="og:title"]')         && 'Missing og:title',
      blocksZoom                                && 'Viewport blocks user zoom (WCAG 1.4.4)',
      structuredData.some(sd => sd.parseError)  && 'JSON-LD parse error detected',
      !lang                                     && 'Missing <html lang> attribute (WCAG 3.1.1)',
    ].filter(Boolean);
    return {
      title, description: desc,
      canonical: get('link[rel="canonical"]', 'href'),
      robots:    get('meta[name="robots"]'),
      viewport:  viewportContent,
      blocksZoom, lang, charset, dir,
      og: { title: get('meta[property="og:title"]'), description: get('meta[property="og:description"]'), image: ogImg, url: get('meta[property="og:url"]'), type: get('meta[property="og:type"]') },
      twitter: { card: get('meta[name="twitter:card"]'), image: get('meta[name="twitter:image"]'), title: get('meta[name="twitter:title"]') },
      structuredData: { count: structuredData.length, types: structuredData.filter(sd => sd.type).map(sd => sd.type), parseErrors: structuredData.filter(sd => sd.parseError).map(sd => sd.parseError) },
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
      const hasLazy = img.loading === 'lazy';
      const hasFP   = img.getAttribute('fetchpriority') === 'high';
      let foldIssue = null;
      if (isAboveFold && hasLazy)        foldIssue = 'LAZY_ABOVE_FOLD';
      else if (isBelowFold && !hasLazy)  foldIssue = 'MISSING_LAZY';
      return {
        src:             img.currentSrc || img.src || '',
        missingAlt:      img.alt === '' && img.getAttribute('role') !== 'presentation' && img.getAttribute('aria-hidden') !== 'true',
        broken:          img.complete && img.naturalWidth === 0 && img.src !== '',
        naturalW:        img.naturalWidth,
        naturalH:        img.naturalHeight,
        displayW:        img.clientWidth,
        displayH:        img.clientHeight,
        oversized:       img.naturalWidth > img.clientWidth * 2 && img.clientWidth > 0 && img.naturalWidth > 200,
        lazy:            hasLazy,
        foldIssue,
        isHeroCandidate: isAboveFold && img.clientWidth > 300 && !hasFP && !hasLazy,
        missingSrcset:   !img.srcset && !img.closest('picture') && img.clientWidth > 200,
      };
    });
  });
  const legacyFormats   = Object.entries(imageFormats).filter(([, ct]) => ct === 'image/jpeg' || ct === 'image/png').map(([u]) => u.split('/').pop().split('?')[0]);
  const lazyAboveFold   = imgData.filter(i => i.foldIssue === 'LAZY_ABOVE_FOLD');
  const heroCandidates  = imgData.filter(i => i.isHeroCandidate);
  const missingSrcset   = imgData.filter(i => i.missingSrcset);
  return {
    total:    imgData.length,
    broken:   imgData.filter(i => i.broken).length,
    missingAlt: imgData.filter(i => i.missingAlt).length,
    oversized:  imgData.filter(i => i.oversized).length,
    notLazy:    imgData.filter(i => !i.lazy && i.displayW > 100).length,
    legacyFormats: legacyFormats.length,
    lazyAboveFold: lazyAboveFold.length,
    missingFetchPriority: heroCandidates.length,
    missingSrcset: missingSrcset.length,
    details: {
      broken:       imgData.filter(i => i.broken).map(i => i.src),
      missingAlt:   imgData.filter(i => i.missingAlt).map(i => i.src || '(no src)'),
      oversized:    imgData.filter(i => i.oversized).map(i => ({ src: i.src, natural: `${i.naturalW}×${i.naturalH}`, display: `${i.displayW}×${i.displayH}` })),
      lazyAboveFold:lazyAboveFold.map(i => i.src),
      heroMissingFP:heroCandidates.map(i => i.src),
      missingSrcset:missingSrcset.map(i => i.src).slice(0, 5),
    },
    warnings: [
      lazyAboveFold.length  > 0 && `${lazyAboveFold.length} above-fold image(s) marked lazy — hurts LCP`,
      heroCandidates.length > 0 && `${heroCandidates.length} large above-fold image(s) missing fetchpriority="high"`,
      missingSrcset.length  > 0 && `${missingSrcset.length} image(s) > 200px wide missing srcset (no responsive images)`,
    ].filter(Boolean),
  };
}

async function runBundleAudit(page) {
  return page.evaluate(() => {
    const resources = performance.getEntriesByType('resource');
    const nav       = performance.getEntriesByType('navigation')[0] || {};
    const kb = bytes => parseFloat((bytes / 1024).toFixed(1));
    const byType = type => resources.filter(r => r.initiatorType === type);
    const jsRes  = byType('script');
    const cssRes = byType('css');
    const imgRes = byType('img');
    const jsKB   = kb(jsRes.reduce( (s, r) => s + r.transferSize, 0));
    const cssKB  = kb(cssRes.reduce((s, r) => s + r.transferSize, 0));
    const totalKB= kb(resources.reduce((s, r) => s + r.transferSize, 0));
    const largest = [...resources].sort((a, b) => b.decodedBodySize - a.decodedBodySize).slice(0, 3).map(r => ({ file: r.name.split('/').pop().split('?')[0] || r.name, decodedKB: kb(r.decodedBodySize), type: r.initiatorType }));
    const slowest = [...resources].filter(r => r.duration > 0).sort((a, b) => b.duration - a.duration).slice(0, 3).map(r => ({ file: r.name.split('/').pop().split('?')[0] || r.name, durationMs: Math.round(r.duration), type: r.initiatorType }));
    // Resource hints: preconnect vs actual third-party origins
    const preconnectOrigins = new Set([...document.querySelectorAll('link[rel="preconnect"]')].map(l => { try { return new URL(l.href).origin; } catch { return null; } }).filter(Boolean));
    const usedThirdParty    = [...new Set(resources.map(r => { try { const o = new URL(r.name).origin; return o !== location.origin ? o : null; } catch { return null; } }).filter(Boolean))];
    const missingPreconnect = usedThirdParty.filter(o => !preconnectOrigins.has(o)).slice(0, 5);
    return {
      totalTransferKB: totalKB, jsKB, cssKB,
      imgKB:         kb(imgRes.reduce((s, r) => s + r.transferSize, 0)),
      resourceCount: resources.length,
      cachedCount:   resources.filter(r => r.transferSize === 0 && r.decodedBodySize > 0).length,
      protocol:      nav.nextHopProtocol || null,
      missingPreconnect,
      largest, slowest,
      warnings: [
        totalKB > 2048 && `Total transfer ${totalKB}KB exceeds 2MB`,
        jsKB    > 512  && `JS bundle ${jsKB}KB exceeds 512KB`,
        nav.nextHopProtocol && nav.nextHopProtocol === 'http/1.1' && 'Page served over HTTP/1.1 (upgrade to HTTP/2 for multiplexing)',
        missingPreconnect.length > 0 && `${missingPreconnect.length} third-party origin(s) without preconnect hint`,
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
      try { for (const rule of sheet.cssRules) { if (rule instanceof CSSFontFaceRule) fontFaceRules.push({ family: rule.style.getPropertyValue('font-family').replace(/['"]/g, ''), display: rule.style.getPropertyValue('font-display') || 'auto' }); } } catch {}
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

async function runScriptAudit(page, preConsentTrackers = []) {
  const domAudit = await page.evaluate((TRACKERS) => {
    const pageOrigin = location.origin;
    const scripts = [...document.querySelectorAll('script[src]')].map(s => {
      let origin;
      try { origin = new URL(s.src).origin; } catch { return null; }
      const isThirdParty = origin !== pageOrigin;
      const tracker = Object.entries(TRACKERS).find(([k]) => s.src.includes(k));
      return { src: s.src.slice(0, 100), origin, isThirdParty, trackerName: tracker?.[1] || null, hasSRI: !!s.integrity, isAsync: s.async, isDefer: s.defer, isModule: s.type === 'module' };
    }).filter(Boolean);
    const stylesheets = [...document.querySelectorAll('link[rel="stylesheet"][href]')].map(l => {
      let origin;
      try { origin = new URL(l.href).origin; } catch { return null; }
      if (origin === pageOrigin) return null;
      return { href: l.href.slice(0, 100), hasSRI: !!l.integrity };
    }).filter(Boolean);
    const thirdParty      = scripts.filter(s => s.isThirdParty);
    const missingSRI      = thirdParty.filter(s => !s.hasSRI);
    const renderBlocking  = thirdParty.filter(s => !s.isAsync && !s.isDefer && !s.isModule);
    const trackers        = [...new Set(thirdParty.filter(s => s.trackerName).map(s => s.trackerName))];
    const stylesheetsSRI  = stylesheets.filter(s => !s.hasSRI).length;
    return {
      total: scripts.length, thirdPartyCount: thirdParty.length,
      missingSRI: missingSRI.length, renderBlocking: renderBlocking.length,
      trackers, stylesheetsMissingSRI: stylesheetsSRI,
      warnings: [
        missingSRI.length   > 0 && `${missingSRI.length} third-party script(s) missing SRI hash`,
        renderBlocking.length>0 && `${renderBlocking.length} render-blocking third-party script(s)`,
        stylesheetsSRI      > 0 && `${stylesheetsSRI} third-party stylesheet(s) missing SRI`,
      ].filter(Boolean),
      details: thirdParty.slice(0, 10),
    };
  }, TRACKER_DOMAINS);
  // Merge pre-consent tracker calls (network-level, captured by response tracking)
  domAudit.preConsentTrackers = [...new Set(preConsentTrackers.map(t => t.name))];
  if (domAudit.preConsentTrackers.length > 0 && !domAudit.warnings.includes('pre-consent')) {
    domAudit.warnings.push(`${domAudit.preConsentTrackers.length} tracker(s) fire at load time before user consent`);
  }
  return domAudit;
}

async function runTouchTargetAudit(page) {
  return page.evaluate(() => {
    const MIN_AA = 24;
    const SEL = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="tab"]';
    const failing = [...document.querySelectorAll(SEL)].map(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      if (window.getComputedStyle(el).display === 'none') return null;
      if (r.width >= MIN_AA && r.height >= MIN_AA) return null;
      return { tag: el.tagName, text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40), width: Math.round(r.width), height: Math.round(r.height) };
    }).filter(Boolean);
    return { failingAA: failing.length, details: failing.slice(0, 10), warnings: failing.length > 0 ? [`${failing.length} interactive element(s) below 24×24px (WCAG 2.5.8)`] : [] };
  });
}

async function runHeadingAudit(page) {
  return page.evaluate(() => {
    const els    = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    const levels = els.map(h => parseInt(h.tagName[1]));
    const h1Count = levels.filter(l => l === 1).length;
    const skips   = [...new Set(levels.map((l, i) => i > 0 && l - levels[i-1] > 1 ? `h${levels[i-1]}→h${l}` : null).filter(Boolean))];
    return {
      h1Count, totalHeadings: els.length, skips,
      warnings: [
        h1Count === 0   && 'No <h1> found (WCAG 2.4.6)',
        h1Count > 1     && `${h1Count} <h1> elements — should be one per page`,
        skips.length > 0 && `Heading level skip(s): ${skips.join(', ')}`,
      ].filter(Boolean),
    };
  });
}

async function runDomA11yAudit(page) {
  return page.evaluate(() => {
    // Broken ARIA ID references
    const ARIA_REF_ATTRS = ['aria-labelledby','aria-describedby','aria-controls','aria-owns','aria-activedescendant'];
    const allIds = new Set([...document.querySelectorAll('[id]')].map(el => el.id));
    const brokenAriaRefs = [];
    document.querySelectorAll(ARIA_REF_ATTRS.map(a => `[${a}]`).join(',')).forEach(el => {
      for (const attr of ARIA_REF_ATTRS) {
        const val = el.getAttribute(attr);
        if (!val) continue;
        for (const id of val.trim().split(/\s+/)) {
          if (id && !allIds.has(id)) brokenAriaRefs.push({ attr, id, element: el.tagName + (el.id ? '#' + el.id : '') });
        }
      }
    });
    // Unlabeled inputs
    const inputs = [...document.querySelectorAll('input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]),select,textarea')];
    const unlabeled = inputs.filter(inp => {
      if (inp.getAttribute('aria-label') || inp.getAttribute('aria-labelledby')) return false;
      if (inp.closest('label')) return false;
      const id = inp.id;
      if (id) { try { if (document.querySelector(`label[for="${CSS.escape(id)}"]`)) return false; } catch {} }
      return true;
    });
    return {
      brokenAriaRefs: brokenAriaRefs.slice(0, 10),
      unlabeledInputs: unlabeled.length,
      warnings: [
        brokenAriaRefs.length > 0 && `${brokenAriaRefs.length} broken ARIA reference(s) (ID not found in DOM)`,
        unlabeled.length > 0      && `${unlabeled.length} form input(s) missing accessible label (WCAG 1.3.1)`,
      ].filter(Boolean),
    };
  });
}

async function runLinksAudit(page) {
  return page.evaluate(() => {
    const GENERIC = new Set(['click here','here','read more','more','learn more','this link','link','this','details','info','information','click','go']);
    const generic = [...document.querySelectorAll('a[href]')]
      .map(a => { const t = (a.textContent || a.getAttribute('aria-label') || '').trim().toLowerCase(); return { text: t, href: a.href }; })
      .filter(l => GENERIC.has(l.text) || (l.text.length > 0 && l.text.length < 4))
      .slice(0, 10);
    return {
      genericAnchorText: generic.length,
      warnings: generic.length > 0 ? [`${generic.length} link(s) with generic anchor text (hurts SEO + screen readers)`] : [],
      details: generic,
    };
  });
}

async function runLayoutAudit(page) {
  return page.evaluate(() => {
    const docWidth  = document.documentElement.scrollWidth;
    const viewWidth = window.innerWidth;
    const hasHorizontalScroll = docWidth > viewWidth;
    const excessPx  = Math.max(0, docWidth - viewWidth);
    const wideElements = hasHorizontalScroll
      ? [...document.querySelectorAll('*')].filter(el => { const r = el.getBoundingClientRect(); return r.right > viewWidth + 5 && r.width > 0; }).slice(0, 5).map(el => ({ tag: el.tagName, class: (el.className || '').split(' ')[0] || null, right: Math.round(el.getBoundingClientRect().right) }))
      : [];
    return {
      hasHorizontalScroll, excessPx, wideElements,
      warnings: hasHorizontalScroll ? [`Page is ${excessPx}px wider than viewport — likely mobile breakage`] : [],
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
    sheets.push({ url: entry.url.split('/').pop().split('?')[0] || entry.url, totalKB: parseFloat((entry.text.length / 1024).toFixed(1)), usedKB: parseFloat((entryUsed / 1024).toFixed(1)), usedPct: entry.text.length ? Math.round(entryUsed / entry.text.length * 100) : 100 });
  }
  const unusedPct = totalBytes ? parseFloat(((totalBytes - usedBytes) / totalBytes * 100).toFixed(1)) : 0;
  return { totalKB: parseFloat((totalBytes / 1024).toFixed(1)), usedKB: parseFloat((usedBytes / 1024).toFixed(1)), unusedPct, sheetsCount: coverage.length, warnings: unusedPct > 70 ? [`${unusedPct}% of CSS unused on initial load`] : [], sheets: sheets.sort((a, b) => b.totalKB - a.totalKB).slice(0, 5) };
}

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
                try { window.__vitals.shifts.push({ value: parseFloat(e.value.toFixed(4)), startTime: Math.round(e.startTime), element: { tag: src.node.tagName, id: src.node.id || null, class: (src.node.className || '').split(' ').filter(Boolean)[0] || null, prevRect: src.previousRect ? { x: Math.round(src.previousRect.x), y: Math.round(src.previousRect.y), w: Math.round(src.previousRect.width), h: Math.round(src.previousRect.height) } : null, currRect: src.currentRect  ? { x: Math.round(src.currentRect.x),  y: Math.round(src.currentRect.y),  w: Math.round(src.currentRect.width),  h: Math.round(src.currentRect.height)  } : null } }); } catch {}
              }
            }
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {}
    try { new PerformanceObserver(list => { list.getEntries().forEach(e => window.__vitals.longTasks.push({ duration: Math.round(e.duration), startTime: Math.round(e.startTime) })); }).observe({ type: 'longtask', buffered: true }); } catch {}
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
      const tasks  = window.__vitals?.longTasks || [];
      const tbt    = Math.round(tasks.reduce((s, t) => s + Math.max(0, t.duration - 50), 0));
      const rate   = (v, g, ni) => v == null ? null : v <= g ? 'good' : v <= ni ? 'needs-improvement' : 'poor';
      return {
        lcp: lcp != null ? Math.round(lcp) : null,
        cls: cls != null ? parseFloat(cls.toFixed(4)) : null,
        fcp: fcp != null ? Math.round(fcp) : null,
        ttfb, tbt,
        clsSources: (window.__vitals?.shifts || []).sort((a, b) => b.value - a.value).slice(0, 5),
        longTasks:  tasks.sort((a, b) => b.duration - a.duration).slice(0, 5),
        ratings: { lcp: rate(lcp, 2500, 4000), cls: rate(cls, 0.1, 0.25), fcp: rate(fcp, 1800, 3000), tbt: rate(tbt, 200, 600) },
      };
    });
  } catch (e) { return { error: e.message }; }
}

// ── Flag-gated helpers ────────────────────────────────────────────────────────

async function captureDarkMode(page, outPath, keepEmulation = false) {
  const darkPath = outPath.replace(/\.png$/i, '') + '-dark.png';
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: darkPath, fullPage: false });
  if (!keepEmulation) await page.emulateMedia({ colorScheme: 'light' });
  return darkPath;
}

async function captureReducedMotion(page, outPath) {
  const rmPath = outPath.replace(/\.png$/i, '') + '-reduced-motion.png';
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: rmPath, fullPage: false });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  return rmPath;
}

async function captureForcedColors(page, outPath) {
  const fcPath = outPath.replace(/\.png$/i, '') + '-forced-colors.png';
  await page.emulateMedia({ forcedColors: 'active' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: fcPath, fullPage: false });
  await page.emulateMedia({ forcedColors: 'none' });
  return fcPath;
}

async function capturePrintLayout(page, outPath) {
  const printPath = outPath.replace(/\.png$/i, '') + '-print.png';
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: printPath, fullPage: true });
  await page.emulateMedia({ media: 'screen' });
  return printPath;
}

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
    return { out: noJsPath, contentLength, hasContent, warning: !hasContent ? 'Page has < 100 chars without JS — likely blank SPA with no SSR' : null };
  } catch (e) { return { error: e.message }; }
  finally { await noJsContext.close(); }
}

async function runFocusAuditFn(page, outBase) {
  const focusableCount = await page.evaluate(() => document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])').length);
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
      return { tag: el.tagName, id: el.id || null, text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40), outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, hasVisibleFocus: style.outlineStyle !== 'none' && style.outlineWidth !== '0px', rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } };
    });
    if (focused) {
      if (!focused.hasVisibleFocus) { try { const ssPath = `${outBase}-focus-${i}.png`; await page.screenshot({ path: ssPath, fullPage: false }); focused.screenshot = ssPath; } catch {} }
      focusResults.push(focused);
    }
  }
  const missing = focusResults.filter(f => !f.hasVisibleFocus);
  return { tabStopsTested: focusResults.length, missingFocusRing: missing.length, focusRingPct: focusResults.length > 0 ? Math.round((1 - missing.length / focusResults.length) * 100) : 100, warnings: missing.length > 0 ? [`${missing.length}/${focusResults.length} focusable elements have no visible focus ring (WCAG 2.4.7)`] : [], details: focusResults };
}

async function runPWAAudit(page) {
  const manifestHref = await page.evaluate(() => document.querySelector('link[rel="manifest"]')?.href || null);
  if (!manifestHref) return { hasManifest: false, warnings: ['No <link rel="manifest"> found'] };
  try {
    const manifest = await page.evaluate(async (url) => { const r = await fetch(url); if (!r.ok) return { error: `HTTP ${r.status}` }; return r.json(); }, manifestHref);
    if (manifest.error) return { hasManifest: true, error: manifest.error, warnings: [`Manifest fetch failed: ${manifest.error}`] };
    const issues = [];
    if (!manifest.name && !manifest.short_name)                                   issues.push('Missing name or short_name');
    if (!manifest.start_url)                                                       issues.push('Missing start_url');
    if (!manifest.display)                                                         issues.push('Missing display mode');
    const icons = manifest.icons || [];
    if (!icons.some(i => (i.sizes || '').includes('192')))                        issues.push('Missing 192×192 icon');
    if (!icons.some(i => (i.sizes || '').includes('512')))                        issues.push('Missing 512×512 icon');
    const hasSW = await page.evaluate(async () => { try { const r = await navigator.serviceWorker?.getRegistrations(); return (r?.length || 0) > 0; } catch { return false; } });
    return { hasManifest: true, name: manifest.name || manifest.short_name || null, display: manifest.display || null, startUrl: manifest.start_url || null, iconCount: icons.length, hasServiceWorker: hasSW, issues, warnings: issues };
  } catch (e) { return { hasManifest: true, error: e.message, warnings: [e.message] }; }
}

function checkBudget(bundle) {
  if (!anyBudget) return null;
  const exceeded = [
    budgetJs    && bundle.jsKB           > budgetJs    && `JS ${bundle.jsKB}KB exceeds ${budgetJs}KB budget`,
    budgetCss   && bundle.cssKB          > budgetCss   && `CSS ${bundle.cssKB}KB exceeds ${budgetCss}KB budget`,
    budgetTotal && bundle.totalTransferKB> budgetTotal && `Total ${bundle.totalTransferKB}KB exceeds ${budgetTotal}KB budget`,
    budgetReqs  && bundle.resourceCount  > budgetReqs  && `${bundle.resourceCount} requests exceeds ${budgetReqs} budget`,
  ].filter(Boolean);
  return { budgets: { js: budgetJs, css: budgetCss, total: budgetTotal, requests: budgetReqs }, exceeded, passed: exceeded.length === 0 };
}

async function runImageFormatCheck(page, imageFormats) {
  const legacyUrls = Object.entries(imageFormats).filter(([, ct]) => ct === 'image/jpeg' || ct === 'image/png').map(([u]) => u).slice(0, 5);
  if (legacyUrls.length === 0) return { checked: 0, supportsModern: [], noModernSupport: [], warnings: [] };
  const results = await page.evaluate(async (urls) => Promise.all(urls.map(async url => {
    try { const r = await fetch(url, { method: 'GET', headers: { Accept: 'image/avif,image/webp,*/*;q=0.8' }, cache: 'no-store' }); const ct = r.headers.get('content-type') || ''; return { url: url.split('/').pop().split('?')[0].slice(0, 50), served: ct, supportsModern: ct.includes('avif') || ct.includes('webp') }; }
    catch (e) { return { url: url.slice(0, 50), error: e.message, supportsModern: false }; }
  })), legacyUrls);
  const noModern = results.filter(r => !r.supportsModern && !r.error);
  return { checked: results.length, supportsModern: results.filter(r => r.supportsModern).map(r => r.url), noModernSupport: noModern.map(r => r.url), warnings: noModern.length > 0 ? [`${noModern.length} image(s) not served as WebP/AVIF when browser requests them`] : [] };
}

async function runLinkCheck(page) {
  const internalLinks = await page.evaluate(() => {
    const seen = new Set();
    return [...document.querySelectorAll('a[href]')].map(a => a.href).filter(href => {
      try { const u = new URL(href); return u.origin === location.origin && !href.includes('#') && !seen.has(href) && !!seen.add(href); } catch { return false; }
    }).slice(0, 20);
  });
  if (!internalLinks.length) return { checked: 0, broken: 0, warnings: [], details: [] };
  const results = await page.evaluate(async (links) => Promise.all(links.map(async url => {
    try { let r = await fetch(url, { method: 'HEAD', redirect: 'follow' }); if (r.status === 405) r = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' }); return { url, status: r.status, ok: r.ok }; }
    catch (e) { return { url, status: 0, ok: false, error: e.message }; }
  })), internalLinks);
  const broken = results.filter(r => !r.ok);
  return { checked: results.length, broken: broken.length, warnings: broken.length > 0 ? [`${broken.length} broken internal link(s)`] : [], details: broken.map(r => ({ url: r.url, status: r.status })) };
}

async function runSEODeepAudit(page) {
  return page.evaluate(async () => {
    const results = { warnings: [] };
    // robots.txt
    try {
      const r    = await fetch(new URL('/robots.txt', location.href).href);
      const text = await r.text();
      const lines = text.split('\n').map(l => l.trim().toLowerCase());
      const blockAll    = lines.some(l => l === 'disallow: /');
      const sitemapLine = text.split('\n').find(l => l.trim().toLowerCase().startsWith('sitemap:'));
      const sitemapUrl  = sitemapLine ? sitemapLine.split(':').slice(1).join(':').trim() : null;
      results.robotsTxt = { found: r.ok, blockAll, sitemapDeclared: !!sitemapUrl, sitemapUrl };
      if (blockAll)       results.warnings.push('robots.txt blocks all crawlers (Disallow: /)');
      if (!sitemapUrl)    results.warnings.push('No sitemap declared in robots.txt');
      if (sitemapUrl) {
        try { const sr = await fetch(sitemapUrl); results.sitemap = { found: sr.ok, status: sr.status, url: sitemapUrl }; if (!sr.ok) results.warnings.push(`Sitemap not accessible (HTTP ${sr.status})`); }
        catch { results.sitemap = { found: false, url: sitemapUrl }; results.warnings.push('Sitemap URL declared but unreachable'); }
      }
    } catch { results.robotsTxt = { found: false }; results.warnings.push('robots.txt not found'); }
    // hreflang
    const hreflangLinks = [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map(l => ({ lang: l.hreflang, href: l.href }));
    const hasXDefault   = hreflangLinks.some(l => l.lang === 'x-default');
    results.hreflang = { count: hreflangLinks.length, hasXDefault: hreflangLinks.length > 0 ? hasXDefault : null };
    if (hreflangLinks.length > 0 && !hasXDefault) results.warnings.push('hreflang set but missing x-default fallback');
    return results;
  });
}

async function compareScreenshots(currentPath, baselinePath) {
  try {
    const { PNG }    = require('pngjs');
    const pixelmatch = require('pixelmatch');
    const img1 = PNG.sync.read(fs.readFileSync(baselinePath));
    const img2 = PNG.sync.read(fs.readFileSync(currentPath));
    if (img1.width !== img2.width || img1.height !== img2.height) return { ok: false, error: `Size mismatch: baseline ${img1.width}×${img1.height} vs current ${img2.width}×${img2.height}` };
    const diffPNG    = new PNG({ width: img1.width, height: img1.height });
    const diffPixels = pixelmatch(img1.data, img2.data, diffPNG.data, img1.width, img1.height, { threshold: 0.1, includeAA: true });
    const diffPct  = parseFloat(((diffPixels / (img1.width * img1.height)) * 100).toFixed(2));
    const diffPath = currentPath.replace(/\.png$/i, '') + '-diff.png';
    fs.writeFileSync(diffPath, PNG.sync.write(diffPNG));
    return { diffPixels, diffPct, diffPath, changed: diffPct > 0.5 };
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') return { ok: false, error: 'pixelmatch/pngjs not installed', action: 'cd ~/.claude/scripts && npm install pixelmatch pngjs' };
    return { ok: false, error: e.message };
  }
}

// ── Route discovery helpers ───────────────────────────────────────────────────
async function discoverByLinks(page, baseUrl) {
  const links = await page.$$eval('a[href]', (anchors, base) => {
    const seen = new Set(['/']);
    return anchors.reduce((acc, a) => {
      try {
        const href = a.getAttribute('href') || '';
        if (!href || href.startsWith('#') || href.startsWith('javascript') || href.startsWith('mailto') || href.startsWith('data:')) return acc;
        const u = new URL(href, base);
        if (u.host !== new URL(base).host) return acc;
        const key = u.pathname + (u.search || '');
        if (!seen.has(key)) { seen.add(key); acc.push(key); }
      } catch {}
      return acc;
    }, []);
  }, baseUrl);
  return ['/', ...links].slice(0, 15);
}

async function discoverTabs(page) {
  const selectors = ['[data-testid="stTab"]', '.tab-nav button', '[role="tab"]', 'button[class*="tab"]'];
  for (const sel of selectors) {
    const els = await page.$$(sel);
    if (els.length >= 2) return els.slice(0, 10).map((_, i) => ({ selector: sel, index: i }));
  }
  return [];
}

function routeSlug(route) {
  return route === '/' ? 'root' : route.replace(/^\//, '').replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40);
}

// ── Shared full-page audit ────────────────────────────────────────────────────
async function runFullAudit(page, outPath, outBase, tracker) {
  const preConsentTrackers = tracker.getPreConsentTrackers();
  const [meta, images, scripts, touchTargets, headings, domA11y, links, layout, bundle, fonts] = await Promise.all([
    runMetaAudit(page),
    runImageAudit(page, tracker.getImageFormats()),
    runScriptAudit(page, preConsentTrackers),
    runTouchTargetAudit(page),
    runHeadingAudit(page),
    runDomA11yAudit(page),
    runLinksAudit(page),
    runLayoutAudit(page),
    runBundleAudit(page),
    runFontAudit(page),
  ]);

  // Compose security headers + enrichments
  const securityHeaders = tracker.getSecurityHeaders();
  if (securityHeaders) {
    securityHeaders.cspStrength        = computeCspStrength(securityHeaders.csp);
    securityHeaders.mixedContent       = tracker.getMixedContent();
    securityHeaders.unsandboxedIframes = await page.evaluate(() =>
      [...document.querySelectorAll('iframe')].filter(f => {
        if (f.getAttribute('sandbox') !== null) return false;
        try { return new URL(f.src).origin !== location.origin; } catch { return false; }
      }).map(f => f.src.slice(0, 80))
    );
    if (securityHeaders.mixedContent.length > 0) securityHeaders.missing.push('mixed-content');
  }

  const cookiesInsecure = tracker.getCookiesInsecure();
  const cookies = { insecureCount: cookiesInsecure.length, details: cookiesInsecure.slice(0, 10), warnings: cookiesInsecure.length > 0 ? [`${cookiesInsecure.length} cookie(s) missing Secure/SameSite flags`] : [] };

  const redirectChain = tracker.getRedirectChain();

  // Budget check (Node-only)
  const budget = anyBudget ? checkBudget(bundle) : undefined;

  // Flag-gated: dark mode + axe in dark
  let darkMode_, darkModeA11y_;
  if (darkMode) {
    const darkOut_ = await captureDarkMode(page, outPath, true);
    const dmA11y   = await runAxe(page);
    await page.emulateMedia({ colorScheme: 'light' });
    darkMode_     = { out: darkOut_ };
    darkModeA11y_ = dmA11y;
  }

  let reducedMotion_, forcedColors_, print_;
  if (reducedMotion) reducedMotion_ = { out: await captureReducedMotion(page, outPath) };
  if (forcedColors)  forcedColors_  = { out: await captureForcedColors(page, outPath)  };
  if (printLayout)   print_         = { out: await capturePrintLayout(page, outPath)   };

  // PWA audit
  let pwa;
  if (pwaMode) pwa = await runPWAAudit(page);

  // Image format content negotiation
  let imgFormat;
  if (imgFormatMode) imgFormat = await runImageFormatCheck(page, tracker.getImageFormats());

  // SEO deep audit
  let seoDeep;
  if (seoDeepMode) seoDeep = await runSEODeepAudit(page);

  // Link check (modifies page state via fetch — run after screenshots)
  let linkCheck;
  if (linkCheckMode) linkCheck = await runLinkCheck(page);

  return {
    meta, images, scripts, touchTargets, headings, domA11y, links, layout, bundle, fonts, cookies, securityHeaders,
    ...(redirectChain.length > 0 && { redirects: redirectChain }),
    ...(budget        && { budget }),
    ...(darkMode_     && { darkMode: darkMode_ }),
    ...(darkModeA11y_ && { darkModeA11y: darkModeA11y_ }),
    ...(reducedMotion_&& { reducedMotion: reducedMotion_ }),
    ...(forcedColors_ && { forcedColors: forcedColors_ }),
    ...(print_        && { print: print_ }),
    ...(pwa           && { pwa }),
    ...(imgFormat     && { imgFormat }),
    ...(seoDeep       && { seoDeep }),
    ...(linkCheck     && { linkCheck }),
  };
}

// ── Single-page mode ──────────────────────────────────────────────────────────
async function singlePage() {
  const outBase = outArg.replace(/\.png$/i, '');
  const outDir  = path.dirname(outBase);
  if (outDir && outDir !== '.' && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  const contextOpts = {};
  let harPath;
  if (harCapture) { harPath = outBase + '.har'; contextOpts.recordHar = { path: harPath, mode: 'minimal' }; }
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
    if (!fs.existsSync(comparePath)) { fs.copyFileSync(outArg, comparePath); diff = { ok: true, baselineCreated: true, baselinePath: comparePath }; }
    else diff = await compareScreenshots(outArg, comparePath);
  }

  let a11y = { violations: 0, critical: 0, details: [] };
  if (url !== 'about:blank') a11y = await runAxe(page);

  let advanced;
  if (anyAdvFlag) { const detected = await detectFeatures(page); advanced = await runAdvanced(page, outBase, detected); }

  let auditResult = {};
  if (url !== 'about:blank') auditResult = await runFullAudit(page, outArg, outBase, tracker);

  let cwv;
  if (cwvMode && url !== 'about:blank') cwv = await runCWV(page);

  let noJs;
  if (noJsMode && url !== 'about:blank') noJs = await captureNoJS(browser, url, outBase, width, height);

  let focusAuditResult;
  if (focusAudit && url !== 'about:blank') focusAuditResult = await runFocusAuditFn(page, outBase);

  await context.close();
  await browser.close();

  const result = { ok: true, url, out: outArg, width, height, consoleErrors: errors, a11y };
  Object.assign(result, auditResult);
  if (advanced)         result.advanced   = advanced;
  if (css)              result.css        = css;
  if (cwv)              result.cwv        = cwv;
  if (diff)             result.diff       = diff;
  if (harPath)          result.harPath    = harPath;
  if (noJs)             result.noJs       = noJs;
  if (focusAuditResult) result.focusAudit = focusAuditResult;

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
    const a11y       = await runAxe(page);
    let advanced;
    if (anyAdvFlag) { const detected = await detectFeatures(page); advanced = await runAdvanced(page, outPath.replace(/\.png$/i, ''), detected); }
    const auditResult = await runFullAudit(page, outPath, outPath.replace(/\.png$/i, ''), tracker);
    let cwv;
    if (cwvMode) cwv = await runCWV(page);
    let focusAuditResult;
    if (focusAudit) focusAuditResult = await runFocusAuditFn(page, outPath.replace(/\.png$/i, ''));
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
  const contextOpts = {};
  let harPath;
  if (harCapture) { harPath = prefix + '-multipage.har'; contextOpts.recordHar = { path: harPath, mode: 'minimal' }; }
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
      const a11y    = await runAxe(page);
      const tracker = setupResponseTracking(page);
      const audit   = await runFullAudit(page, outPath, outPath.replace(/\.png$/i, ''), tracker);
      results.push({ ok: true, url, route: '/', out: outPath, width, height, consoleErrors: [], a11y, ...audit, note: 'no-tabs-found' });
    } else {
      for (const tab of tabs) {
        const errors = [];
        const errH   = e => errors.push(e.message);
        page.on('pageerror', errH);
        try {
          const els = await page.$$(tab.selector);
          if (!els[tab.index]) continue;
          const label = (await els[tab.index].innerText().catch(() => '')).trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '').toLowerCase() || `tab${tab.index}`;
          await els[tab.index].click();
          await page.waitForTimeout(700);
          const outPath = `${prefix}-tab-${label}.png`;
          await page.screenshot({ path: outPath, fullPage: false });
          const a11y    = await runAxe(page);
          let advanced;
          if (anyAdvFlag) { const detected = await detectFeatures(page); advanced = await runAdvanced(page, outPath.replace(/\.png$/i, ''), detected); }
          const tracker = setupResponseTracking(page);
          const audit   = await runFullAudit(page, outPath, outPath.replace(/\.png$/i, ''), tracker);
          const entry   = { ok: true, url, route: `tab:${label}`, tab: tab.index, out: outPath, width, height, consoleErrors: errors, a11y, ...audit };
          if (advanced) entry.advanced = advanced;
          results.push(entry);
        } catch (e) { results.push({ ok: false, url, route: `tab:${tab.index}`, error: e.message }); }
        finally { page.off('pageerror', errH); }
      }
    }
    await page.close();
  } else {
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

  await sharedContext.close();
  await browser.close();

  if (harPath) results.forEach(r => { if (r.ok) r.harPath = harPath; });
  process.stdout.write(JSON.stringify(results) + '\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────
(multiMode ? multiPage() : singlePage()).catch(e => {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
  process.exit(1);
});
