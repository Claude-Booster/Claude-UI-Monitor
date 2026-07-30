// pw-e2e-test.js — Playwright UI/UX audit tool.
//
// Single-page: node pw-e2e-test.js <url> <out.png> [width] [height] [flags]
// Multi-page:  node pw-e2e-test.js <url> <prefix> [w] [h] --routes=auto|/r1,/r2 [--nav=link-crawl|tab-click]
//
// Always-on for real URLs (zero overhead):
//   meta              title, viewport, blocksZoom (WCAG 1.4.4), lang, charset, dir,
//                     metaDescription (length), og: tags, noindex detection, favicon, CSP/referrer meta
//   images            broken, missingAlt, oversized, lazy-above-fold, missingFetchPriority, missingSrcset, missingHeight
//   scripts           render-blocking third-party + first-party scripts (delays page display)
//   touchTargets      interactive elements < 24×24px (WCAG 2.5.8)
//   headings          h1 count, heading level skips (WCAG 2.4.6)
//   domA11y           broken ARIA ID refs, unlabeled inputs, icon-only buttons, title-only interactive,
//                     duplicate IDs (WCAG 4.1.1), generic link text (WCAG 2.4.4),
//                     aria-hidden on interactive elements (WCAG 4.1.2), skip link (WCAG 2.4.1),
//                     label-in-name violations (WCAG 2.5.3), iframe missing title (WCAG 4.1.2)
//   layout            horizontal scroll, overflow-hidden clipping, sticky/fixed covering content,
//                     fixed bottom elements missing safe-area-inset-bottom (notched devices),
//                     consecutive <br> spacing hacks
//   bundle            JS/CSS/image KB, largest + slowest resources
//   fonts             loaded/failed, FOIT/FOUT risk, custom fonts missing <link rel=preload>
//   typography        font-size < 16px on mobile, line-height < 1.2, ellipsis truncation,
//                     estimated line length > 80 chars (WCAG 1.4.8), text-transform:uppercase blocks
//   interactiveStates :hover/:focus/:disabled CSS rules, outline:0 without :focus-visible replacement
//   cursor            interactive elements missing cursor:pointer, visible elements with pointer-events:none
//   viewportUnits     height:100vh rules that clip on mobile (use dvh instead)
//   mediaQuerySupport prefers-color-scheme:dark, prefers-reduced-motion, responsive breakpoints presence
//   formUX            missing autocomplete on email/password/tel, placeholder-as-only-label (WCAG 3.3.2),
//                     radio/checkbox groups without fieldset+legend (WCAG 1.3.1)
//   animationDurations animations > 1s, transitions > 300ms, infinite animations (WCAG 2.2.2)
//   stacking          z-index > 9999 anomalies
//   svgA11y           informative SVGs missing role="img" and <title> element
//   mediaA11y         video autoplay without muted (WCAG 1.4.2), missing captions track (WCAG 1.2.2)
//   colorOnly         inline links distinguished from body text only by color (WCAG 1.4.1)
//   textSelectability text content blocked from copying with user-select:none
//   landmarks         main/nav/banner/contentinfo landmark regions (WCAG 2.4.1)
//   tableA11y         data tables missing <th>, scope, or <caption> (WCAG 1.3.1)
//   dialogs           dialog/modal missing aria-modal or accessible name (WCAG 4.1.2)
//   widgets           toggle buttons missing aria-expanded, tabs ARIA pattern, carousel issues
//   security          target=_blank without rel=noopener; mixed http:// content on https pages
//   statusMessages    notification/toast/alert containers missing aria-live or role (WCAG 4.1.3)
//   domSize           total DOM node count; warns if > 1500 (Lighthouse threshold)
//   preconnect        third-party origins without preconnect/dns-prefetch hints
//   rtl               physical directional CSS on dir=rtl pages (should use logical props)
//
// Flag-gated checks:
//   --dark-mode            screenshot + axe in dark mode → darkMode, darkModeA11y
//   --cwv                  LCP, CLS+sources, FCP, TTFB, TBT, INP estimate → cwv
//   --compare=<path>       pixel-diff vs baseline → diff
//   --reduced-motion       prefers-reduced-motion screenshot → reducedMotion
//   --forced-colors        forced-colors: active screenshot → forcedColors
//   --print                media: print screenshot → print
//   --no-js                JS-disabled screenshot → noJs
//   --focus-audit          keyboard focus ring audit → focusAudit
//   --link-check           broken internal link check (HEAD, cap 20) → linkCheck
//   --reflow               320px viewport layout check (WCAG 1.4.10) → reflow
//   --text-spacing         WCAG 1.4.12 text-spacing override clipping check → textSpacing
//   --paint-complexity     expensive CSS paint properties on large elements → paintComplexity
//   --state-contrast       WCAG 1.4.3 contrast in default + hover state → stateContrast
//   --required-fields      required form fields missing aria-required="true" → requiredFields
//   --animation-fill       animations missing fill-mode:forwards/both (snap-back glitch) → animationDurations.missingFillMode
//   --empty-states         stuck loading spinners + empty list/grid containers → emptyStates
//   --text-contrast        WCAG 1.4.3 contrast on body text (p, li, headings) → bodyTextContrast
//   --placeholder-contrast placeholder text contrast < 4.5:1 (WCAG 1.4.3) → placeholderContrast
//   --non-text-contrast    input border/checkbox/radio contrast < 3:1 (WCAG 1.4.11) → nonTextContrast
//   --pwa                  PWA readiness: manifest link + service worker → pwaReadiness
//   --sri                  external scripts/styles missing integrity attribute → sri
//
// Advanced flags (auto-detected or explicit):
//   --detect-advanced  auto-enable based on CSS animations, WebGL, canvas, GSAP, etc.
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

const darkMode        = flags['dark-mode']        === 'true';
const cwvMode         = flags['cwv']              === 'true';
const comparePath     = flags['compare']          || null;
const reducedMotion   = flags['reduced-motion']   === 'true';
const forcedColors    = flags['forced-colors']    === 'true';
const printLayout     = flags['print']            === 'true';
const noJsMode        = flags['no-js']            === 'true';
const focusAudit      = flags['focus-audit']      === 'true';
const linkCheckMode   = flags['link-check']       === 'true';
const reflowMode         = flags['reflow']           === 'true';
const textSpacingMode    = flags['text-spacing']     === 'true';
const paintComplexity    = flags['paint-complexity'] === 'true';
const stateContrast      = flags['state-contrast']   === 'true';
const requiredFieldsMode     = flags['required-fields']        === 'true';
const animFillMode           = flags['animation-fill']         === 'true';
const emptyStatesMode        = flags['empty-states']           === 'true';
const textContrastMode       = flags['text-contrast']          === 'true';
const placeholderContrastMode= flags['placeholder-contrast']   === 'true';
const nonTextContrastMode    = flags['non-text-contrast']      === 'true';
const pwaMode                = flags['pwa']                    === 'true';
const sriMode                = flags['sri']                    === 'true';

// ── Response tracking (image formats only) ────────────────────────────────────
function setupResponseTracking(page) {
  const imageFormats = {};
  page.on('response', response => {
    try {
      const ct = response.headers()['content-type'];
      if (ct && ct.startsWith('image/')) {
        imageFormats[response.url()] = ct.split(';')[0].trim();
      }
    } catch {}
  });
  return { getImageFormats: () => imageFormats };
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
    const viewportContent = document.querySelector('meta[name="viewport"]')?.content ?? null;
    const blocksZoom = viewportContent ? (
      viewportContent.includes('user-scalable=no') ||
      viewportContent.includes('user-scalable=0') ||
      /maximum-scale=[01][,\s]/.test(viewportContent) ||
      viewportContent.includes('maximum-scale=1.0')
    ) : false;
    const lang    = document.documentElement.lang || null;
    const charset = document.characterSet || null;
    const dir     = document.documentElement.dir || 'ltr';
    const issues  = [
      blocksZoom && 'Viewport blocks user zoom (WCAG 1.4.4)',
      !lang      && 'Missing <html lang> attribute (WCAG 3.1.1)',
    ].filter(Boolean);
    // metaDescription
    const descEl = document.querySelector('meta[name="description"]');
    const descContent = descEl ? (descEl.getAttribute('content') || '') : null;
    const metaDescription = {
      content:  descContent ? descContent.slice(0, 200) : null,
      missing:  descContent === null,
      tooShort: descContent !== null && descContent.length < 50,
      tooLong:  descContent !== null && descContent.length > 160,
      length:   descContent !== null ? descContent.length : 0,
    };
    // Open Graph
    const og = name => document.querySelector(`meta[property="og:${name}"]`)?.getAttribute('content') ?? null;
    const openGraph = { title: og('title'), description: og('description'), image: og('image'), url: og('url') };
    const openGraphMissing = ['title','description','image','url'].filter(k => !openGraph[k]);
    // robots noindex
    const robotsMeta = document.querySelector('meta[name="robots"]');
    const noindex = robotsMeta ? /noindex/i.test(robotsMeta.getAttribute('content') || '') : false;
    // favicon
    const hasFavicon = [...document.querySelectorAll('link')].some(l => /^(shortcut )?icon|apple-touch-icon/i.test(l.getAttribute('rel') || ''));
    // security meta
    const hasCSPMeta      = !!document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    const hasReferrerMeta = !!document.querySelector('meta[name="referrer"]');
    const pageTitle = document.title?.trim() || '';
    const missingTitle = !pageTitle;
    // Orientation lock detection (WCAG 1.3.4) — CSS hiding content in one orientation
    let orientationLock = false;
    try {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSMediaRule) {
              const cond = rule.conditionText || rule.media?.mediaText || '';
              if (/orientation\s*:\s*(portrait|landscape)/.test(cond)) {
                for (const sub of rule.cssRules) {
                  if (sub instanceof CSSStyleRule) {
                    const d = sub.style.display, v = sub.style.visibility, h = sub.style.height;
                    if (d === 'none' || v === 'hidden' || h === '0px' || h === '0') { orientationLock = true; break; }
                  }
                }
              }
            }
            if (orientationLock) break;
          }
        } catch {}
        if (orientationLock) break;
      }
    } catch {}
    const metaWarnings = [
      missingTitle                      && 'Missing or empty <title> — screen readers announce blank page name (WCAG 2.4.2)',
      metaDescription.missing           && 'Missing <meta name="description"> — search snippet will be auto-generated',
      metaDescription.tooShort          && `Meta description too short (${metaDescription.length} chars, min 50)`,
      metaDescription.tooLong           && `Meta description too long (${metaDescription.length} chars, max 160) — will be truncated`,
      openGraphMissing.length > 0       && `Missing og: tags: ${openGraphMissing.join(', ')} — social unfurling will fail`,
      noindex                           && 'Page has meta robots=noindex — will not appear in search results',
      !hasFavicon                       && 'No favicon link — browser makes wasted /favicon.ico request',
      orientationLock                   && 'CSS hides content in one orientation — may lock device to one orientation (WCAG 1.3.4)',
    ].filter(Boolean);
    return {
      title: pageTitle || null, missingTitle, viewport: viewportContent, blocksZoom, lang, charset, dir, issues,
      metaDescription, openGraph, openGraphMissing, noindex, hasFavicon, hasCSPMeta, hasReferrerMeta, orientationLock,
      warnings: metaWarnings,
    };
  });
}

async function runImageAudit(page, imageFormats = {}) {
  return page.evaluate((fmts) => {
    const vh = window.innerHeight;
    const imgs = [...document.querySelectorAll('img')].map(img => {
      const rect        = img.getBoundingClientRect();
      const isAboveFold = rect.bottom <= vh && rect.top >= 0 && rect.width > 0;
      const isBelowFold = rect.top > vh;
      const hasLazy     = img.loading === 'lazy';
      const hasFP       = img.getAttribute('fetchpriority') === 'high';
      let foldIssue = null;
      if (isAboveFold && hasLazy)       foldIssue = 'LAZY_ABOVE_FOLD';
      else if (isBelowFold && !hasLazy) foldIssue = 'MISSING_LAZY';
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
        missingHeight:   !img.hasAttribute('height') && img.clientWidth > 100,
      };
    });
    const lazyAboveFold  = imgs.filter(i => i.foldIssue === 'LAZY_ABOVE_FOLD');
    const heroCandidates = imgs.filter(i => i.isHeroCandidate);
    const missingSrcset  = imgs.filter(i => i.missingSrcset);
    // Legacy format images: JPEG/PNG > 30 KB when WebP/AVIF would save 25-50%
    const resources = performance.getEntriesByType('resource');
    const legacyFormatImages = resources
      .filter(r => r.initiatorType === 'img' && r.transferSize > 30720)
      .filter(r => { const f = fmts[r.name]; return f === 'image/jpeg' || f === 'image/png'; })
      .slice(0, 10)
      .map(r => ({ url: r.name.slice(0, 100), format: (fmts[r.name] || 'unknown').replace('image/', ''), kb: Math.round(r.transferSize / 1024) }));
    // Below-fold third-party iframes without loading="lazy" (CWV: TBT, TTI)
    const HEAVY_DOMAINS = /youtube\.com|youtu\.be|vimeo\.com|maps\.google|maps\.googleapis|player\.vimeo|open\.spotify|twitter\.com\/widgets|platform\.twitter|facebook\.com\/plugins/;
    const iframesWithoutLazy = [...document.querySelectorAll('iframe[src]')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        const isBelowFold = r.top > vh;
        const isHeavy = HEAVY_DOMAINS.test(el.src || '');
        return (isBelowFold || isHeavy) && el.getAttribute('loading') !== 'lazy';
      }).slice(0, 10).map(el => ({ src: (el.src || '').slice(0, 80), belowFold: el.getBoundingClientRect().top > vh }));
    return {
      total:   imgs.length,
      broken:  imgs.filter(i => i.broken).length,
      missingAlt: imgs.filter(i => i.missingAlt).length,
      oversized:  imgs.filter(i => i.oversized).length,
      notLazy:    imgs.filter(i => !i.lazy && i.displayW > 100).length,
      lazyAboveFold:        lazyAboveFold.length,
      missingFetchPriority: heroCandidates.length,
      missingSrcset:        missingSrcset.length,
      missingHeight:        imgs.filter(i => i.missingHeight).length,
      iframesWithoutLazy:   iframesWithoutLazy.length,
      legacyFormatImages:   legacyFormatImages.length,
      details: {
        broken:           imgs.filter(i => i.broken).map(i => i.src),
        missingAlt:       imgs.filter(i => i.missingAlt).map(i => i.src || '(no src)'),
        oversized:        imgs.filter(i => i.oversized).map(i => ({ src: i.src, natural: `${i.naturalW}×${i.naturalH}`, display: `${i.displayW}×${i.displayH}` })),
        lazyAboveFold:    lazyAboveFold.map(i => i.src),
        heroMissingFP:    heroCandidates.map(i => i.src),
        missingSrcset:    missingSrcset.map(i => i.src).slice(0, 5),
        iframesWithoutLazy,
        legacyFormatImages,
      },
      warnings: [
        lazyAboveFold.length      > 0 && `${lazyAboveFold.length} above-fold image(s) marked lazy — hurts LCP`,
        heroCandidates.length     > 0 && `${heroCandidates.length} large above-fold image(s) missing fetchpriority="high"`,
        missingSrcset.length      > 0 && `${missingSrcset.length} image(s) > 200px wide missing srcset`,
        iframesWithoutLazy.length > 0 && `${iframesWithoutLazy.length} third-party/below-fold iframe(s) without loading="lazy" — blocks main thread at load`,
        legacyFormatImages.length > 0 && `${legacyFormatImages.length} image(s) > 30 KB served as JPEG/PNG — consider WebP/AVIF for 25-50% size savings`,
      ].filter(Boolean),
    };
  }, imageFormats);
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
    const largest = [...resources].sort((a, b) => b.decodedBodySize - a.decodedBodySize).slice(0, 3).map(r => ({ file: r.name.split('/').pop().split('?')[0] || r.name, decodedKB: kb(r.decodedBodySize), type: r.initiatorType }));
    const slowest = [...resources].filter(r => r.duration > 0).sort((a, b) => b.duration - a.duration).slice(0, 3).map(r => ({ file: r.name.split('/').pop().split('?')[0] || r.name, durationMs: Math.round(r.duration), type: r.initiatorType }));
    return {
      totalTransferKB: totalKB, jsKB, cssKB,
      imgKB:         kb(imgRes.reduce((s, r) => s + r.transferSize, 0)),
      resourceCount: resources.length,
      cachedCount:   resources.filter(r => r.transferSize === 0 && r.decodedBodySize > 0).length,
      largest, slowest,
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
    // Font preload hints
    const fontFaceUrls = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSFontFaceRule) {
            const src = rule.style.getPropertyValue('src') || '';
            const matches = src.match(/url\(['"]?([^'")\s]+)['"]?\)/g) || [];
            for (const m of matches) {
              const u = m.replace(/^url\(['"]?/, '').replace(/['"]?\)$/, '');
              if (u && !u.startsWith('data:')) fontFaceUrls.push(u);
            }
          }
        }
      } catch {}
    }
    const preloadFonts = new Set([...document.querySelectorAll('link[rel="preload"][as="font"]')].map(l => {
      try { return new URL(l.href).pathname.split('/').pop(); } catch { return null; }
    }).filter(Boolean));
    const missingFontPreload = fontFaceUrls.filter(u => {
      try { const fname = new URL(u, location.href).pathname.split('/').pop(); return fname && !preloadFonts.has(fname); } catch { return false; }
    }).slice(0, 5);
    return {
      loaded:   fontFaces.filter(f => f.status === 'loaded').length,
      failed:   fontFaces.filter(f => f.status === 'error').map(f => f.family),
      foitRisk: fontFaceRules.filter(f => f.display === 'auto' || f.display === 'block').map(f => f.family),
      foutRisk: fontFaceRules.filter(f => f.display === 'swap').map(f => f.family),
      optimal:  fontFaceRules.filter(f => f.display === 'optional' || f.display === 'fallback').map(f => f.family),
      missingFontPreload: missingFontPreload.length,
      warnings: missingFontPreload.length > 0
        ? [`${missingFontPreload.length} custom font(s) without <link rel="preload" as="font"> — causes late discovery and FOIT/FOUT`]
        : [],
    };
  });
}

async function runScriptAudit(page) {
  return page.evaluate(() => {
    const pageOrigin = location.origin;
    const scripts = [...document.querySelectorAll('script[src]')].map(s => {
      let origin;
      try { origin = new URL(s.src).origin; } catch { return null; }
      return { isThirdParty: origin !== pageOrigin, isAsync: s.async, isDefer: s.defer, isModule: s.type === 'module' };
    }).filter(Boolean);
    const thirdParty              = scripts.filter(s => s.isThirdParty);
    const renderBlocking          = thirdParty.filter(s => !s.isAsync && !s.isDefer && !s.isModule);
    const firstPartyRenderBlocking= scripts.filter(s => !s.isThirdParty && !s.isAsync && !s.isDefer && !s.isModule).length;
    // <link rel="stylesheet"> inside <body> causes FOUC and blocks rendering
    const stylesheetInBody = document.body ? [...document.body.querySelectorAll('link[rel="stylesheet"]')].length : 0;
    return {
      total:                   scripts.length,
      thirdPartyCount:         thirdParty.length,
      renderBlocking:          renderBlocking.length,
      firstPartyRenderBlocking,
      stylesheetInBody,
      warnings: [
        renderBlocking.length > 0           && `${renderBlocking.length} render-blocking third-party script(s) delay page display`,
        firstPartyRenderBlocking > 0        && `${firstPartyRenderBlocking} render-blocking first-party script(s) — add async/defer/type=module`,
        stylesheetInBody > 0                && `${stylesheetInBody} <link rel="stylesheet"> in <body> — causes FOUC and delays LCP`,
      ].filter(Boolean),
    };
  });
}

async function runTouchTargetAudit(page) {
  return page.evaluate(() => {
    const MIN_AA = 24, MIN_AAA = 44;
    const SEL = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="tab"]';
    const all = [...document.querySelectorAll(SEL)].map(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      if (window.getComputedStyle(el).display === 'none') return null;
      return { tag: el.tagName, text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40), width: Math.round(r.width), height: Math.round(r.height) };
    }).filter(Boolean);
    const failing    = all.filter(e => e.width < MIN_AA  || e.height < MIN_AA);
    const failingAAA = all.filter(e => (e.width >= MIN_AA && e.height >= MIN_AA) && (e.width < MIN_AAA || e.height < MIN_AAA));
    return {
      failingAA:  failing.length,
      failingAAA: failingAAA.length,
      details: failing.slice(0, 10),
      warnings: [
        failing.length    > 0 && `${failing.length} interactive element(s) below 24×24px (WCAG 2.5.8 AA)`,
        failingAAA.length > 0 && `${failingAAA.length} interactive element(s) 24–43px — pass AA (2.5.8) but fail AAA (2.5.5 44px)`,
      ].filter(Boolean),
    };
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
        h1Count === 0    && 'No <h1> found (WCAG 2.4.6)',
        h1Count > 1      && `${h1Count} <h1> elements — should be one per page`,
        skips.length > 0 && `Heading level skip(s): ${skips.join(', ')}`,
      ].filter(Boolean),
    };
  });
}

async function runDomA11yAudit(page) {
  return page.evaluate(() => {
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
    const inputs = [...document.querySelectorAll('input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]),select,textarea')];
    const unlabeled = inputs.filter(inp => {
      if (inp.getAttribute('aria-label') || inp.getAttribute('aria-labelledby')) return false;
      if (inp.closest('label')) return false;
      const id = inp.id;
      if (id) { try { if (document.querySelector(`label[for="${CSS.escape(id)}"]`)) return false; } catch {} }
      return true;
    });
    const iconOnlyBtns = [...document.querySelectorAll('button, [role="button"]')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) return false;
        return !el.textContent.trim();
      }).slice(0, 10).map(el => ({
        tag: el.tagName.toLowerCase(),
        class: (el.className || '').trim().split(/\s+/)[0] || null,
        inner: el.innerHTML.replace(/\s+/g, ' ').trim().slice(0, 60),
      }));
    const titleOnly = [...document.querySelectorAll('button, a[href], [role="button"], input, select')]
      .filter(el => {
        if (!el.getAttribute('title')) return false;
        if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
        return !el.textContent.trim();
      }).slice(0, 10).map(el => ({
        tag: el.tagName.toLowerCase(),
        title: (el.getAttribute('title') || '').slice(0, 40),
      }));
    // Duplicate IDs (WCAG 4.1.1)
    const idMap = {};
    document.querySelectorAll('[id]').forEach(el => { idMap[el.id] = (idMap[el.id] || 0) + 1; });
    const duplicateIds = Object.entries(idMap).filter(([, c]) => c > 1).slice(0, 10).map(([id, count]) => ({ id, count }));
    // Generic link text (WCAG 2.4.4)
    const GENERIC_TEXT = /^(click here|read more|here|more|learn more|this|details|link|download|continue|start|go|see more|view more|show more|find out more|button)$/i;
    const genericLinks = [...document.querySelectorAll('a[href]')]
      .filter(a => { const t = a.textContent.trim(); return GENERIC_TEXT.test(t); })
      .slice(0, 10).map(a => ({ text: a.textContent.trim(), href: (a.getAttribute('href') || '').slice(0, 60) }));
    // aria-hidden on interactive/focusable elements (WCAG 4.1.2)
    const ariaHiddenInteractive = [...document.querySelectorAll('[aria-hidden="true"]')]
      .filter(el => el.matches('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])') ||
        !!el.querySelector('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'))
      .slice(0, 10).map(el => ({ tag: el.tagName.toLowerCase(), id: el.id || null, class: (el.className || '').trim().split(/\s+/)[0] || null }));
    // Skip link presence (WCAG 2.4.1)
    const hasSkipLink = [...document.querySelectorAll('a[href^="#"]')].slice(0, 10)
      .some(a => /skip|jump|bypass|main|content/i.test(a.textContent));
    // Label-in-name violations (WCAG 2.5.3)
    const labelInNameViolations = [...document.querySelectorAll('[aria-label]')]
      .filter(el => {
        if (!el.matches('button,a[href],[role="button"],[role="link"]')) return false;
        const visible  = el.textContent.trim().toLowerCase().replace(/\s+/g, ' ');
        if (!visible || visible.length < 2) return false;
        const ariaLbl  = (el.getAttribute('aria-label') || '').toLowerCase();
        return !ariaLbl.includes(visible);
      }).slice(0, 10).map(el => ({ tag: el.tagName.toLowerCase(), visible: el.textContent.trim().slice(0, 40), ariaLabel: (el.getAttribute('aria-label') || '').slice(0, 40) }));
    // iframe missing title (WCAG 4.1.2)
    const iframesMissingTitle = [...document.querySelectorAll('iframe')]
      .filter(el => { const t = el.getAttribute('title'); return !t || !t.trim(); })
      .slice(0, 10).map(el => ({ src: (el.getAttribute('src') || '').slice(0, 80) }));
    // Positive tabindex values (WCAG 2.4.3) — shatters focus order
    const positiveTabindex = [...document.querySelectorAll('[tabindex]')]
      .filter(el => parseInt(el.getAttribute('tabindex'), 10) > 0)
      .slice(0, 10).map(el => ({ tag: el.tagName.toLowerCase(), tabindex: el.getAttribute('tabindex'), id: el.id || null }));
    // aria-invalid=true without linked error message (WCAG 3.3.1)
    const ariaInvalidMissingMessage = [...document.querySelectorAll('[aria-invalid="true"]')]
      .filter(el => {
        const descId = el.getAttribute('aria-describedby');
        if (!descId) return true;
        const desc = document.getElementById(descId.trim().split(/\s+/)[0]);
        return !desc || !desc.textContent.trim();
      }).slice(0, 10).map(el => ({ tag: el.tagName.toLowerCase(), id: el.id || null }));
    // Active nav link missing aria-current (WCAG 2.4.8 / 4.1.2)
    const navLinks = [...document.querySelectorAll('nav a[href],[role="navigation"] a[href]')];
    const pathname = location.pathname.replace(/\/$/, '') || '/';
    const missingAriaCurrent = navLinks.some(a => {
      const href = (a.getAttribute('href') || '').split('?')[0].split('#')[0].replace(/\/$/, '') || '/';
      return href === pathname && !a.getAttribute('aria-current');
    });
    // role=none/presentation on natively focusable elements (WCAG 4.1.2)
    const rolePresentationFocusable = [...document.querySelectorAll('[role="none"],[role="presentation"]')]
      .filter(el => el.matches('a[href],button,input,select,textarea') || parseInt(el.getAttribute('tabindex'), 10) >= 0)
      .slice(0, 10).map(el => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') }));
    // role=menu misuse on navigation (APG / WCAG 4.1.2)
    const menuRoleMisuse = [...document.querySelectorAll('[role="menu"],[role="menubar"]')]
      .filter(el => !!el.closest('nav') || !!el.closest('[role="navigation"]') || !!el.querySelector('a[href]'))
      .slice(0, 5).map(el => ({ tag: el.tagName.toLowerCase(), class: (el.className || '').trim().split(/\s+/)[0] || null }));
    // <details> missing or empty <summary> (WCAG 4.1.2 — name, role, value)
    const detailsMissingSummary = [...document.querySelectorAll('details')]
      .filter(el => {
        const s = el.querySelector('summary');
        if (!s) return true;
        return !s.textContent.trim() && !s.getAttribute('aria-label');
      }).slice(0, 5).map(el => ({ id: el.id || null }));
    // <meter>/<progress> missing accessible name (WCAG 4.1.2)
    const meterProgressMissingLabel = [...document.querySelectorAll('meter, progress')]
      .filter(el => {
        if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
        const id = el.id;
        if (id) { try { if (document.querySelector(`label[for="${CSS.escape(id)}"]`)) return false; } catch {} }
        return true;
      }).slice(0, 5).map(el => ({ tag: el.tagName.toLowerCase(), id: el.id || null }));
    return {
      brokenAriaRefs: brokenAriaRefs.slice(0, 10),
      unlabeledInputs: unlabeled.length,
      iconOnlyButtons: iconOnlyBtns.length,
      titleOnlyInteractive: titleOnly.length,
      duplicateIds: duplicateIds.length,
      genericLinks: genericLinks.length,
      ariaHiddenInteractive: ariaHiddenInteractive.length,
      hasSkipLink,
      labelInNameViolations: labelInNameViolations.length,
      iframesMissingTitle: iframesMissingTitle.length,
      positiveTabindex: positiveTabindex.length,
      ariaInvalidMissingMessage: ariaInvalidMissingMessage.length,
      missingAriaCurrent,
      rolePresentationFocusable: rolePresentationFocusable.length,
      menuRoleMisuse: menuRoleMisuse.length,
      detailsMissingSummary: detailsMissingSummary.length,
      meterProgressMissingLabel: meterProgressMissingLabel.length,
      details: { duplicateIds, genericLinks, ariaHiddenInteractive, labelInNameViolations, iframesMissingTitle, positiveTabindex, ariaInvalidMissingMessage, rolePresentationFocusable, menuRoleMisuse, detailsMissingSummary, meterProgressMissingLabel },
      warnings: [
        brokenAriaRefs.length > 0               && `${brokenAriaRefs.length} broken ARIA reference(s)`,
        unlabeled.length > 0                    && `${unlabeled.length} form input(s) missing accessible label (WCAG 1.3.1)`,
        iconOnlyBtns.length > 0                 && `${iconOnlyBtns.length} button(s) with no accessible name — icon-only, add aria-label`,
        titleOnly.length > 0                    && `${titleOnly.length} interactive element(s) use title-only label (invisible on touch devices)`,
        duplicateIds.length > 0                 && `${duplicateIds.length} duplicate ID(s) — breaks ARIA label associations (WCAG 4.1.1)`,
        genericLinks.length > 0                 && `${genericLinks.length} link(s) with non-descriptive text like "click here" (WCAG 2.4.4)`,
        ariaHiddenInteractive.length > 0        && `${ariaHiddenInteractive.length} interactive/focusable element(s) inside aria-hidden="true" (WCAG 4.1.2)`,
        !hasSkipLink                            && 'No skip-navigation link found — keyboard users must tab through all nav (WCAG 2.4.1)',
        labelInNameViolations.length > 0        && `${labelInNameViolations.length} element(s) where aria-label doesn't include visible text (WCAG 2.5.3)`,
        iframesMissingTitle.length > 0          && `${iframesMissingTitle.length} <iframe>(s) missing title attribute (WCAG 4.1.2)`,
        positiveTabindex.length > 0             && `${positiveTabindex.length} element(s) with positive tabindex — disrupts focus order (WCAG 2.4.3)`,
        ariaInvalidMissingMessage.length > 0    && `${ariaInvalidMissingMessage.length} aria-invalid element(s) missing linked error message (WCAG 3.3.1)`,
        missingAriaCurrent                      && 'Active nav link missing aria-current="page" — screen readers get no location indicator (WCAG 2.4.8)',
        rolePresentationFocusable.length > 0    && `${rolePresentationFocusable.length} focusable element(s) with role="none/presentation" — strips semantics but remains keyboard-reachable (WCAG 4.1.2)`,
        menuRoleMisuse.length > 0               && `${menuRoleMisuse.length} element(s) use role="menu" for navigation — use role="navigation" instead (WCAG 4.1.2)`,
        detailsMissingSummary.length > 0        && `${detailsMissingSummary.length} <details> element(s) missing or empty <summary> — screen readers announce "Details" with no context (WCAG 4.1.2)`,
        meterProgressMissingLabel.length > 0    && `${meterProgressMissingLabel.length} <meter>/<progress> element(s) missing accessible name (WCAG 4.1.2)`,
      ].filter(Boolean),
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
    const hiddenOverflowElements = [...document.querySelectorAll('*')].filter(el => {
      const s = window.getComputedStyle(el);
      if (s.overflow !== 'hidden' && s.overflow !== 'clip' && s.overflowY !== 'hidden' && s.overflowY !== 'clip') return false;
      if (el.scrollHeight <= el.clientHeight + 10) return false;
      const r = el.getBoundingClientRect();
      return r.width > 50 && r.height > 20;
    }).slice(0, 5).map(el => ({
      tag: el.tagName.toLowerCase(),
      class: (el.className || '').trim().split(/\s+/)[0] || null,
      hiddenPx: el.scrollHeight - el.clientHeight,
    }));
    const stickyFixed = [...document.querySelectorAll('*')]
      .filter(el => {
        const s = window.getComputedStyle(el);
        const pos = s.position;
        if (pos !== 'fixed' && pos !== 'sticky') return false;
        const r = el.getBoundingClientRect();
        if (r.height < 40) return false;
        const topNum = parseFloat(s.top), bottomNum = parseFloat(s.bottom);
        return (!isNaN(topNum) && topNum === 0) || (!isNaN(bottomNum) && bottomNum === 0);
      }).slice(0, 5).map(el => {
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { tag: el.tagName.toLowerCase(), class: (el.className || '').trim().split(/\s+/)[0] || null, position: s.position, height: Math.round(r.height) };
      });
    // Safe-area-inset-bottom: fixed bottom elements on notched devices
    let hasSafeAreaCss = false;
    try {
      for (const sheet of document.styleSheets) {
        try { for (const rule of sheet.cssRules) { if (rule.cssText && rule.cssText.includes('safe-area-inset-bottom')) { hasSafeAreaCss = true; break; } } } catch {}
        if (hasSafeAreaCss) break;
      }
    } catch {}
    const missingSafeArea = hasSafeAreaCss ? [] : [...document.querySelectorAll('*')]
      .filter(el => {
        const s = window.getComputedStyle(el);
        if (s.position !== 'fixed' && s.position !== 'sticky') return false;
        const r = el.getBoundingClientRect();
        if (r.height < 44) return false;
        const bottom = parseFloat(s.bottom);
        return !isNaN(bottom) && bottom === 0;
      }).slice(0, 5).map(el => ({ tag: el.tagName.toLowerCase(), class: (el.className || '').trim().split(/\s+/)[0] || null, height: Math.round(el.getBoundingClientRect().height) }));
    // Consecutive <br> spacing hacks
    let consecutiveBrCount = 0;
    const brs = [...document.querySelectorAll('br')];
    for (let i = 0; i < brs.length - 1; i++) {
      let next = brs[i].nextSibling;
      while (next && next.nodeType === 3 && !next.textContent.trim()) next = next.nextSibling;
      if (next && next.nodeName === 'BR') consecutiveBrCount++;
    }
    // will-change overuse: > 4 promoted elements wastes VRAM on low-end devices
    let willChangeCount = 0, willChangeAll = 0;
    try {
      for (const el of document.querySelectorAll('*')) {
        const wc = window.getComputedStyle(el).willChange;
        if (wc && wc !== 'auto') { willChangeCount++; if (wc === 'all') willChangeAll++; }
      }
    } catch {}
    // content-visibility:auto without contain-intrinsic-size causes massive CLS
    const contentVisibilityMissingIntrinsic = [...document.querySelectorAll('*')].filter(el => {
      try { const s = window.getComputedStyle(el); return s.contentVisibility === 'auto' && (!s.containIntrinsicSize || s.containIntrinsicSize === 'none 0px' || s.containIntrinsicSize === 'auto none'); } catch { return false; }
    }).length;
    // WCAG 2.4.11 Focus Not Obscured: sticky top headers > 80px risk covering focused elements
    const focusObscureRisk = stickyFixed.filter(sf => (sf.position === 'fixed' || sf.position === 'sticky') && sf.height > 80);
    return {
      hasHorizontalScroll, excessPx, wideElements, hiddenOverflowElements, stickyFixed,
      missingSafeArea: missingSafeArea.length,
      consecutiveBr: consecutiveBrCount,
      willChangeCount,
      willChangeAll,
      contentVisibilityMissingIntrinsic,
      focusObscureRisk: focusObscureRisk.length,
      warnings: [
        hasHorizontalScroll && `Page is ${excessPx}px wider than viewport — likely mobile breakage`,
        hiddenOverflowElements.length > 0 && `${hiddenOverflowElements.length} element(s) clip overflowing content (overflow:hidden)`,
        stickyFixed.length > 0 && `${stickyFixed.length} sticky/fixed element(s) at top:0 or bottom:0 (height ${stickyFixed[0]?.height}px) may cover scrolled-to content`,
        missingSafeArea.length > 0 && `${missingSafeArea.length} fixed bottom element(s) may be obscured by iPhone home indicator — add padding: env(safe-area-inset-bottom)`,
        consecutiveBrCount > 0 && `${consecutiveBrCount} consecutive <br> pair(s) used for spacing — use margin/padding instead`,
        willChangeCount > 4   && `${willChangeCount} elements with will-change set — excessive GPU layer promotion causes VRAM pressure on low-end mobile`,
        willChangeAll > 0     && `${willChangeAll} element(s) with will-change:all — promotes every property; use specific values`,
        contentVisibilityMissingIntrinsic > 0 && `${contentVisibilityMissingIntrinsic} element(s) with content-visibility:auto missing contain-intrinsic-size — causes CLS spike on scroll`,
        focusObscureRisk.length > 0 && `${focusObscureRisk.length} sticky/fixed element(s) > 80px tall may fully obscure focused elements (WCAG 2.4.11)`,
      ].filter(Boolean),
    };
  });
}

async function runTypographyAudit(page) {
  return page.evaluate(() => {
    const isMobile = window.innerWidth <= 390;
    const textEls = [...document.querySelectorAll('p, span, li, td, th, label, button, a, h1, h2, h3, h4, h5, h6')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && window.getComputedStyle(el).display !== 'none';
      }).slice(0, 200);
    const smallText = [], tightLineHeight = [], truncated = [];
    for (const el of textEls) {
      const s = window.getComputedStyle(el);
      const fontSize   = parseFloat(s.fontSize);
      const lhRaw      = parseFloat(s.lineHeight);
      const lineHeight = isNaN(lhRaw) ? NaN : lhRaw / fontSize;
      const tag = el.tagName.toLowerCase();
      const cls = el.className ? '.' + String(el.className).trim().split(/\s+/)[0] : '';
      const selector = (tag + (el.id ? '#' + el.id : cls)).slice(0, 60);
      if (isMobile && fontSize < 16 && el.textContent.trim().length > 0)
        smallText.push({ tag, fontSize: parseFloat(fontSize.toFixed(1)), selector });
      if (!isNaN(lineHeight) && lineHeight > 0 && lineHeight < 1.2 && el.textContent.trim().length > 3)
        tightLineHeight.push({ tag, lineHeight: parseFloat(lineHeight.toFixed(2)), selector });
      if (s.textOverflow === 'ellipsis' && (s.overflow === 'hidden' || s.overflowX === 'hidden'))
        truncated.push({ tag, selector });
    }
    // Line length > 80 chars (WCAG 1.4.8 guideline)
    const longLineEls = [];
    for (const el of [...document.querySelectorAll('p, li, td, dd, blockquote')].slice(0, 100)) {
      const s2 = window.getComputedStyle(el);
      const w  = el.getBoundingClientRect().width;
      if (w < 200) continue;
      const fs = parseFloat(s2.fontSize) || 16;
      const estimated = Math.round(w / (fs * 0.48));
      if (estimated > 80 && el.textContent.trim().length > 40)
        longLineEls.push({ tag: el.tagName.toLowerCase(), estimated });
    }
    // All-caps text blocks (readability concern)
    const allCapsEls = [...document.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, span, div')]
      .filter(el => {
        const s2 = window.getComputedStyle(el);
        if (s2.textTransform !== 'uppercase') return false;
        return el.textContent.trim().length > 30;
      }).slice(0, 10).map(el => ({ tag: el.tagName.toLowerCase(), length: el.textContent.trim().length, text: el.textContent.trim().slice(0, 40) }));
    const unique = arr => [...new Map(arr.map(x => [x.selector, x])).values()].slice(0, 10);
    const us = unique(smallText), ut = unique(tightLineHeight), uu = unique(truncated);
    const ul = [...new Map(longLineEls.map(x => [x.tag + x.estimated, x])).values()].slice(0, 5);
    return {
      smallText: us, tightLineHeight: ut, truncated: uu,
      longLines: ul.length, allCapsBlocks: allCapsEls.length,
      details: { longLines: ul, allCapsBlocks: allCapsEls },
      warnings: [
        us.length > 0       && `${us.length} element(s) with font-size < 16px on mobile viewport — may trigger iOS auto-zoom`,
        ut.length > 0       && `${ut.length} element(s) with line-height < 1.2 (WCAG 1.4.12)`,
        uu.length > 0       && `${uu.length} element(s) truncating text with ellipsis — content hidden from users`,
        ul.length > 0       && `${ul.length} text container(s) estimated > 80 chars/line — reduces readability (WCAG 1.4.8)`,
        allCapsEls.length > 0 && `${allCapsEls.length} block(s) with text-transform:uppercase on > 30 chars — reduces reading speed`,
      ].filter(Boolean),
    };
  });
}

async function runInteractiveStateAudit(page) {
  return page.evaluate(() => {
    let hoverCount = 0, focusCount = 0, disabledCount = 0;
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSStyleRule) {
            const sel = rule.selectorText || '';
            if (/:hover/.test(sel))    hoverCount++;
            if (/:focus/.test(sel))    focusCount++;
            if (/:disabled/.test(sel)) disabledCount++;
          }
        }
      } catch {}
    }
    const interactive = [...document.querySelectorAll('button, a[href], [role="button"], input[type="submit"], input[type="button"]')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length;
    const hasDisabled = document.querySelectorAll('[disabled]').length > 0;
    const hasFocusVisible = new Set();
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSStyleRule && /:focus-visible/.test(rule.selectorText || '')) {
            const outline = rule.style.outline || rule.style.getPropertyValue('outline');
            if (outline && outline !== 'none' && outline !== '0' && outline !== '0px')
              hasFocusVisible.add((rule.selectorText || '').replace(/:focus-visible[^,]*/g, '').trim());
          }
        }
      } catch {}
    }
    const removedFocusOutline = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSStyleRule) {
            const sel = rule.selectorText || '';
            if (/:focus/.test(sel) && !/:focus-visible/.test(sel)) {
              const outline = rule.style.outline || rule.style.getPropertyValue('outline');
              const outlineStyle = rule.style.getPropertyValue('outline-style');
              const outlineWidth = rule.style.getPropertyValue('outline-width');
              const removes = (outline === 'none' || outline === '0' || outlineStyle === 'none' || outlineWidth === '0' || outlineWidth === '0px');
              if (removes) {
                const base = sel.replace(/:focus[^\s,]*/g, '').trim();
                if (!hasFocusVisible.has(base)) removedFocusOutline.push({ selector: sel.slice(0, 80) });
              }
            }
          }
        }
      } catch {}
    }
    return {
      hoverRuleCount:     hoverCount,
      focusRuleCount:     focusCount,
      disabledRuleCount:  disabledCount,
      interactiveCount:   interactive,
      removedFocusOutline: [...new Map(removedFocusOutline.map(x => [x.selector, x])).values()].slice(0, 10),
      warnings: [
        hoverCount   === 0 && interactive > 0 && 'No :hover CSS rules found — interactive elements lack hover feedback',
        focusCount   === 0 && interactive > 0 && 'No :focus/:focus-visible CSS rules found — keyboard users get no focus indication',
        disabledCount=== 0 && hasDisabled      && 'No :disabled CSS rules — disabled elements look identical to enabled ones',
        removedFocusOutline.length > 0         && `${removedFocusOutline.length} rule(s) remove focus outline without :focus-visible replacement (WCAG 2.4.7)`,
      ].filter(Boolean),
    };
  });
}

async function runCursorAudit(page) {
  return page.evaluate(() => {
    const SEL = 'button, a[href], [role="button"], [role="link"], input[type="submit"], input[type="button"], input[type="reset"]';
    const els = [...document.querySelectorAll(SEL)].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && window.getComputedStyle(el).display !== 'none';
    }).slice(0, 50);
    const missingPointer = els.filter(el => window.getComputedStyle(el).cursor !== 'pointer')
      .slice(0, 10).map(el => ({
        tag:    el.tagName.toLowerCase(),
        text:   (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40),
        cursor: window.getComputedStyle(el).cursor,
      }));
    const pointerEventsNoneEls = els.filter(el => window.getComputedStyle(el).pointerEvents === 'none')
      .slice(0, 10).map(el => ({
        tag:  el.tagName.toLowerCase(),
        text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40),
      }));
    return {
      checked: els.length,
      missingPointer: missingPointer.length,
      pointerEventsNone: pointerEventsNoneEls.length,
      details: missingPointer,
      warnings: [
        missingPointer.length > 0        && `${missingPointer.length} interactive element(s) missing cursor:pointer`,
        pointerEventsNoneEls.length > 0  && `${pointerEventsNoneEls.length} interactive element(s) with pointer-events:none — visible but unclickable`,
      ].filter(Boolean),
    };
  });
}

async function runViewportUnitsAudit(page) {
  return page.evaluate(() => {
    const HEIGHT_PROPS = ['height', 'min-height', 'max-height'];
    const unsafeVh = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSStyleRule) {
            for (const prop of HEIGHT_PROPS) {
              const val = rule.style.getPropertyValue(prop);
              if (val && val.includes('100vh'))
                unsafeVh.push({ selector: (rule.selectorText || '').slice(0, 80), property: prop, value: val });
            }
          }
        }
      } catch {}
    }
    const unique = [...new Map(unsafeVh.map(x => [x.selector + x.property, x])).values()].slice(0, 10);
    return {
      unsafeVhCount: unique.length,
      details: unique,
      warnings: unique.length > 0 ? [`${unique.length} rule(s) use height:100vh — clipped by mobile browser chrome; use dvh instead`] : [],
    };
  });
}

async function runMediaQueryAudit(page) {
  return page.evaluate(() => {
    let darkModeRules = 0, reducedMotionRules = 0, breakpointCount = 0;
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSMediaRule) {
            const cond = rule.conditionText || rule.media?.mediaText || '';
            if (/prefers-color-scheme\s*:\s*dark/.test(cond))     darkModeRules++;
            if (/prefers-reduced-motion\s*:\s*reduce/.test(cond)) reducedMotionRules++;
            if (/\((?:max|min)-width/.test(cond))                 breakpointCount++;
          }
        }
      } catch {}
    }
    let prefersContrastRules = 0;
    let hasSmoothScroll = false, hasSmoothScrollGuard = false;
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSMediaRule) {
            const cond = rule.conditionText || rule.media?.mediaText || '';
            if (/prefers-contrast/.test(cond)) prefersContrastRules++;
            const isRMGuard = /prefers-reduced-motion\s*:\s*no-preference/.test(cond);
            try {
              for (const inner of rule.cssRules) {
                if (inner instanceof CSSStyleRule && inner.style.getPropertyValue('scroll-behavior') === 'smooth') {
                  hasSmoothScroll = true;
                  if (isRMGuard) hasSmoothScrollGuard = true;
                }
              }
            } catch {}
          }
          if (rule instanceof CSSStyleRule) {
            if (rule.style.getPropertyValue('scroll-behavior') === 'smooth') hasSmoothScroll = true;
          }
        }
      } catch {}
    }
    const unguardedSmoothScroll = hasSmoothScroll && !hasSmoothScrollGuard;
    return {
      hasDarkModeCSS:           darkModeRules > 0,
      darkModeCSSRuleCount:     darkModeRules,
      hasReducedMotionCSS:      reducedMotionRules > 0,
      reducedMotionCSSRuleCount:reducedMotionRules,
      hasResponsiveBreakpoints: breakpointCount > 0,
      breakpointCount,
      hasPrefersContrastCSS:    prefersContrastRules > 0,
      unguardedSmoothScroll,
      warnings: [
        darkModeRules        === 0 && 'No prefers-color-scheme:dark CSS — dark mode users see forced light theme',
        reducedMotionRules   === 0 && 'No prefers-reduced-motion:reduce CSS — animations play for motion-sensitive users',
        breakpointCount      === 0 && 'No responsive breakpoints found — layout may not adapt to mobile screens',
        prefersContrastRules === 0 && 'No prefers-contrast CSS — high-contrast mode users get no enhanced contrast',
        unguardedSmoothScroll      && 'scroll-behavior:smooth outside prefers-reduced-motion:no-preference guard — animated scroll for users with vestibular disorders (WCAG 2.3.3)',
      ].filter(Boolean),
    };
  });
}

async function runFormUXAudit(page) {
  return page.evaluate(() => {
    const checks = [
      { sel: 'input[type=email]',    expected: 'email' },
      { sel: 'input[type=password]', expected: 'current-password' },
      { sel: 'input[type=tel]',      expected: 'tel' },
    ];
    const missingAutocomplete = [];
    for (const { sel, expected } of checks) {
      try {
        for (const inp of document.querySelectorAll(sel)) {
          const ac = inp.getAttribute('autocomplete');
          if (!ac || ac === 'off')
            missingAutocomplete.push({ type: inp.type, name: inp.name || inp.id || null, expected });
        }
      } catch {}
    }
    // Placeholder-as-only-label (WCAG 3.3.2): input has placeholder but no persistent label
    const placeholderOnlyLabel = [...document.querySelectorAll('input[placeholder]:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset])')]
      .filter(inp => {
        if (inp.getAttribute('aria-label') || inp.getAttribute('aria-labelledby')) return false;
        if (inp.closest('label')) return false;
        const id = inp.id;
        if (id) { try { if (document.querySelector(`label[for="${CSS.escape(id)}"]`)) return false; } catch {} }
        return true;
      }).slice(0, 10).map(inp => ({ type: inp.type || 'text', name: inp.name || inp.id || null, placeholder: (inp.getAttribute('placeholder') || '').slice(0, 40) }));
    // Radio/checkbox groups without fieldset+legend (WCAG 1.3.1)
    const groupedInputs = {};
    [...document.querySelectorAll('input[type=radio][name], input[type=checkbox][name]')].forEach(inp => {
      (groupedInputs[inp.name] = groupedInputs[inp.name] || []).push(inp);
    });
    const missingFieldset = Object.entries(groupedInputs)
      .filter(([, els]) => els.length >= 2 && !els[0].closest('fieldset'))
      .slice(0, 5).map(([name]) => ({ name }));
    // autocomplete=off on password inputs blocks password managers (WCAG 3.3.8)
    const passwordAutocompleteOff = [...document.querySelectorAll('input[type="password"]')]
      .filter(inp => { const ac = (inp.getAttribute('autocomplete') || '').toLowerCase(); return ac === 'off' || ac === 'false'; })
      .slice(0, 5).map(inp => ({ name: inp.name || inp.id || null }));
    // inputmode absent on numeric/tel-like text inputs (mobile UX)
    const NUMERIC_PATTERN = /phone|tel|zip|postal|pin|cvv|card|otp|ssn|dob|date|code|fax/i;
    const missingInputMode = [...document.querySelectorAll('input[type="text"]:not([inputmode]), input:not([type])[placeholder]')]
      .filter(inp => NUMERIC_PATTERN.test([inp.name, inp.id, inp.getAttribute('placeholder'), inp.getAttribute('autocomplete')].filter(Boolean).join(' ')))
      .slice(0, 10).map(inp => ({ name: inp.name || inp.id || null, placeholder: (inp.getAttribute('placeholder') || '').slice(0, 40) }));
    // input[type=number] misuse on non-numeric semantic data (strips leading zeros, accepts e/+/-)
    const NUMBER_MISUSE_RE = /zip|postal|pin|cvv|cvc|csc|otp|ssn|dob|birthday|phone|mobile|fax|card.?num|account.?num|routing/i;
    const numberInputMisuse = [...document.querySelectorAll('input[type="number"]')]
      .filter(inp => NUMBER_MISUSE_RE.test([inp.name, inp.id, inp.getAttribute('placeholder')].filter(Boolean).join(' ')))
      .slice(0, 5).map(inp => ({ name: inp.name || inp.id || null, placeholder: (inp.getAttribute('placeholder') || '').slice(0, 40) }));
    // Extended WCAG 1.3.5: personal data fields missing appropriate autocomplete token
    const PERSONAL_FIELDS = [
      { re: /^name$|full.?name|your.?name/i,   token: 'name' },
      { re: /first.?name|given.?name/i,          token: 'given-name' },
      { re: /last.?name|family.?name|surname/i,  token: 'family-name' },
      { re: /street|addr(ess)?[_-]?1?$/i,        token: 'street-address' },
      { re: /postal|zip.?code|post.?code/i,       token: 'postal-code' },
      { re: /^country$/i,                         token: 'country' },
      { re: /birthday|birth.?date|^dob$/i,        token: 'bday' },
      { re: /cc.?name|card.?holder|cardholder/i,  token: 'cc-name' },
      { re: /cc.?number|card.?num(ber)?/i,        token: 'cc-number' },
      { re: /new.?pass|create.?pass/i,            token: 'new-password' },
    ];
    const missingPersonalAutocomplete = [];
    for (const { re, token } of PERSONAL_FIELDS) {
      [...document.querySelectorAll('input[type="text"],input:not([type])')].forEach(inp => {
        const key = [inp.name, inp.id, inp.getAttribute('placeholder')].filter(Boolean).join(' ');
        if (!re.test(key)) return;
        const ac = inp.getAttribute('autocomplete') || '';
        if (!ac || ac === 'off' || ac === 'on') missingPersonalAutocomplete.push({ name: inp.name || inp.id || null, expectedToken: token });
      });
    }
    return {
      missingAutocomplete: missingAutocomplete.slice(0, 10),
      placeholderOnlyLabel: placeholderOnlyLabel.length,
      missingFieldset: missingFieldset.length,
      passwordAutocompleteOff: passwordAutocompleteOff.length,
      missingInputMode: missingInputMode.length,
      numberInputMisuse: numberInputMisuse.length,
      missingPersonalAutocomplete: missingPersonalAutocomplete.slice(0, 10).length,
      details: { placeholderOnlyLabel, missingFieldset, passwordAutocompleteOff, missingInputMode, numberInputMisuse },
      warnings: [
        missingAutocomplete.length > 0            && `${missingAutocomplete.length} input(s) missing autocomplete — mobile autofill won't work`,
        placeholderOnlyLabel.length > 0           && `${placeholderOnlyLabel.length} input(s) use placeholder as only label — disappears on focus (WCAG 3.3.2)`,
        missingFieldset.length > 0                && `${missingFieldset.length} radio/checkbox group(s) without <fieldset>+<legend> (WCAG 1.3.1)`,
        passwordAutocompleteOff.length > 0        && `${passwordAutocompleteOff.length} password input(s) with autocomplete="off" — blocks password managers (WCAG 3.3.8)`,
        missingInputMode.length > 0               && `${missingInputMode.length} numeric/tel-like text input(s) missing inputmode — wrong soft keyboard on mobile`,
        numberInputMisuse.length > 0              && `${numberInputMisuse.length} input(s) use type="number" for non-numeric data — strips leading zeros, accepts e/+/-`,
        missingPersonalAutocomplete.length > 0    && `${missingPersonalAutocomplete.length} personal data input(s) missing specific autocomplete token (WCAG 1.3.5)`,
      ].filter(Boolean),
    };
  });
}

async function runAnimationDurationAudit(page) {
  return page.evaluate(() => {
    const SLOW_ANIM_MS = 1000, SLOW_TRANS_MS = 300;
    const parseDur = val => {
      if (!val || val === '0s') return 0;
      return Math.max(...val.split(',').map(p => { const v = parseFloat(p); return p.includes('ms') ? v : v * 1000; }));
    };
    const longAnimations = [], longTransitions = [], infiniteAnimations = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSStyleRule) {
            const sel = (rule.selectorText || '').slice(0, 80);
            const ad = rule.style.getPropertyValue('animation-duration');
            const td = rule.style.getPropertyValue('transition-duration');
            if (ad) { const ms = parseDur(ad); if (ms > SLOW_ANIM_MS) longAnimations.push({ selector: sel, duration: ad.trim(), ms }); }
            if (td) { const ms = parseDur(td); if (ms > SLOW_TRANS_MS) longTransitions.push({ selector: sel, duration: td.trim(), ms }); }
            const iterCount = rule.style.getPropertyValue('animation-iteration-count');
            const animShorthand = rule.style.getPropertyValue('animation');
            const isInfinite = iterCount === 'infinite' || (animShorthand && /\binfinite\b/.test(animShorthand));
            if (isInfinite) {
              const animName = rule.style.getPropertyValue('animation-name') || (animShorthand || '').split(' ')[0];
              if (animName && animName !== 'none' && animName !== '') infiniteAnimations.push({ selector: sel, animationName: animName.slice(0, 40) });
            }
          }
        }
      } catch {}
    }
    const unique = arr => [...new Map(arr.map(x => [x.selector, x])).values()].slice(0, 10);
    const ua = unique(longAnimations), ut = unique(longTransitions), ui = unique(infiniteAnimations);
    return {
      longAnimations: ua, longTransitions: ut, infiniteAnimations: ui,
      warnings: [
        ua.length > 0 && `${ua.length} animation(s) > 1s — may feel sluggish`,
        ut.length > 0 && `${ut.length} transition(s) > 300ms — hover/focus response feels slow`,
        ui.length > 0 && `${ui.length} infinite animation(s) — should be pausable per WCAG 2.2.2`,
      ].filter(Boolean),
    };
  });
}

async function runStackingAudit(page) {
  return page.evaluate(() => {
    const veryHigh = [...document.querySelectorAll('*')].filter(el => {
      const z = parseInt(window.getComputedStyle(el).zIndex);
      return !isNaN(z) && z > 9999;
    }).slice(0, 10).map(el => ({
      tag:    el.tagName.toLowerCase(),
      id:     el.id || null,
      class:  (el.className || '').toString().trim().split(/\s+/)[0] || null,
      zIndex: parseInt(window.getComputedStyle(el).zIndex),
    }));
    return {
      veryHighZIndex: veryHigh,
      warnings: veryHigh.length > 0 ? [`${veryHigh.length} element(s) with z-index > 9999 — may cause stacking/modal issues`] : [],
    };
  });
}

async function runSVGAudit(page) {
  return page.evaluate(() => {
    const svgs = [...document.querySelectorAll('svg')].filter(svg => {
      const r = svg.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const decorative = svgs.filter(svg =>
      svg.getAttribute('aria-hidden') === 'true' ||
      svg.getAttribute('role') === 'presentation' ||
      svg.getAttribute('role') === 'none'
    );
    const informative = svgs.filter(svg => !decorative.includes(svg));
    const missingRole  = informative.filter(svg => svg.getAttribute('role') !== 'img').length;
    const missingTitle = informative.filter(svg => !svg.querySelector('title')).length;
    return {
      total: svgs.length,
      decorativeCount: decorative.length,
      missingRole,
      missingTitle,
      warnings: [
        missingRole  > 0 && `${missingRole} informative SVG(s) missing role="img"`,
        missingTitle > 0 && `${missingTitle} informative SVG(s) missing <title> element (screen reader description)`,
      ].filter(Boolean),
    };
  });
}

async function runMediaAudit(page) {
  return page.evaluate(() => {
    const videos = [...document.querySelectorAll('video')];
    const autoplayWithoutMuted = videos
      .filter(v => v.hasAttribute('autoplay') && !v.hasAttribute('muted'))
      .map(v => ({ src: v.currentSrc || v.querySelector('source')?.src || '(no src)', hasControls: v.hasAttribute('controls') }));
    const missingCaptions = videos
      .filter(v => v.getAttribute('aria-hidden') !== 'true')
      .filter(v => ![...v.querySelectorAll('track')].some(t => t.kind === 'captions' || t.kind === 'subtitles'))
      .map(v => ({ src: v.currentSrc || v.querySelector('source')?.src || '(no src)' }));
    // Audio elements: autoplay without controls (WCAG 1.4.2), no controls at all
    const audios = [...document.querySelectorAll('audio')];
    const audioAutoplayNoControls = audios
      .filter(a => a.hasAttribute('autoplay') && !a.hasAttribute('controls'))
      .slice(0, 5).map(a => ({ src: a.currentSrc || a.querySelector('source')?.src || '(no src)' }));
    const audioMissingControls = audios
      .filter(a => !a.hasAttribute('controls') && a.getAttribute('aria-hidden') !== 'true')
      .slice(0, 5).map(a => ({ src: a.currentSrc || a.querySelector('source')?.src || '(no src)' }));
    return {
      videoCount: videos.length,
      autoplayWithoutMuted: autoplayWithoutMuted.slice(0, 5),
      missingCaptions: missingCaptions.slice(0, 5),
      audioCount: audios.length,
      audioAutoplayNoControls: audioAutoplayNoControls.length,
      audioMissingControls: audioMissingControls.length,
      warnings: [
        autoplayWithoutMuted.length > 0    && `${autoplayWithoutMuted.length} video(s) autoplay without muted attribute — browser may block + WCAG 1.4.2`,
        missingCaptions.length > 0         && `${missingCaptions.length} video(s) missing captions track (WCAG 1.2.2)`,
        audioAutoplayNoControls.length > 0 && `${audioAutoplayNoControls.length} audio(s) autoplay without controls — user cannot pause (WCAG 1.4.2)`,
        audioMissingControls.length > 0    && `${audioMissingControls.length} audio(s) without controls — users cannot control playback`,
      ].filter(Boolean),
    };
  });
}

async function runColorOnlyAudit(page) {
  return page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href]')].filter(a => {
      const parent = a.parentElement;
      if (!parent) return false;
      const r = a.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const text = a.textContent.trim();
      return text.length > 0 && parent.textContent.replace(text, '').trim().length > 0;
    }).slice(0, 30);
    const colorOnly = links.filter(a => {
      const s = window.getComputedStyle(a);
      const ps = window.getComputedStyle(a.parentElement);
      const hasUnderline = s.textDecorationLine !== 'none' && s.textDecorationLine !== '';
      const hasDiffWeight = s.fontWeight !== ps.fontWeight;
      const hasBorder     = s.borderBottomWidth !== '0px' && s.borderBottomStyle !== 'none';
      const hasDiffBg     = s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== ps.backgroundColor;
      return !hasUnderline && !hasDiffWeight && !hasBorder && !hasDiffBg;
    }).slice(0, 10).map(a => ({
      text:       a.textContent.trim().slice(0, 60),
      href:       a.getAttribute('href') || '',
      color:      window.getComputedStyle(a).color,
      decoration: window.getComputedStyle(a).textDecorationLine,
    }));
    return {
      colorOnlyLinks: colorOnly,
      warnings: colorOnly.length > 0
        ? [`${colorOnly.length} inline link(s) distinguished from surrounding text only by color (WCAG 1.4.1)`]
        : [],
    };
  });
}

async function runTextSelectabilityAudit(page) {
  return page.evaluate(() => {
    const SEL = 'p, pre, code, address, [class*="address"], [class*="phone"], [class*="email"]';
    const nonSelectable = [...document.querySelectorAll(SEL)]
      .filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return el.textContent.trim().length > 20 && window.getComputedStyle(el).userSelect === 'none';
      }).slice(0, 10).map(el => ({
        tag:   el.tagName.toLowerCase(),
        text:  el.textContent.trim().slice(0, 60),
        class: (el.className || '').trim().split(/\s+/)[0] || null,
      }));
    return {
      count: nonSelectable.length,
      elements: nonSelectable,
      warnings: nonSelectable.length > 0
        ? [`${nonSelectable.length} text element(s) with user-select:none — users cannot copy this content`]
        : [],
    };
  });
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
                try { window.__vitals.shifts.push({ value: parseFloat(e.value.toFixed(4)), startTime: Math.round(e.startTime), element: { tag: src.node.tagName, id: src.node.id || null, class: (src.node.className || '').split(' ').filter(Boolean)[0] || null, prevRect: src.previousRect ? { x: Math.round(src.previousRect.x), y: Math.round(src.previousRect.y), w: Math.round(src.previousRect.width), h: Math.round(src.previousRect.height) } : null, currRect: src.currentRect ? { x: Math.round(src.currentRect.x), y: Math.round(src.currentRect.y), w: Math.round(src.currentRect.width), h: Math.round(src.currentRect.height) } : null } }); } catch {}
              }
            }
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {}
    try { new PerformanceObserver(list => { list.getEntries().forEach(e => window.__vitals.longTasks.push({ duration: Math.round(e.duration), startTime: Math.round(e.startTime) })); }).observe({ type: 'longtask', buffered: true }); } catch {}
    // INP: collect event-timing durations (buffered = captures already-dispatched events)
    try { window.__vitals.eventDelays = []; new PerformanceObserver(list => { list.getEntries().forEach(e => { if (e.duration > 0) window.__vitals.eventDelays.push(e.duration); }); }).observe({ type: 'event', durationThreshold: 0, buffered: true }); } catch {}
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
      // INP: 98th-percentile event duration
      const delays = (window.__vitals?.eventDelays || []).sort((a, b) => a - b);
      const inp    = delays.length ? Math.round(delays[Math.max(0, Math.floor(delays.length * 0.98) - 1)]) : null;
      const rate   = (v, g, ni) => v == null ? null : v <= g ? 'good' : v <= ni ? 'needs-improvement' : 'poor';
      return {
        lcp: lcp != null ? Math.round(lcp) : null,
        cls: cls != null ? parseFloat(cls.toFixed(4)) : null,
        fcp: fcp != null ? Math.round(fcp) : null,
        ttfb, tbt, inp,
        clsSources: (window.__vitals?.shifts || []).sort((a, b) => b.value - a.value).slice(0, 5),
        longTasks:  tasks.sort((a, b) => b.duration - a.duration).slice(0, 5),
        ratings: { lcp: rate(lcp, 2500, 4000), cls: rate(cls, 0.1, 0.25), fcp: rate(fcp, 1800, 3000), tbt: rate(tbt, 200, 600), inp: rate(inp, 200, 500) },
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
    const noJsPath      = outBase + '-no-js.png';
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

async function captureReflow(browser, pageUrl, outBase, h) {
  const ctx = await browser.newContext({ viewport: { width: 320, height: h } });
  const pg  = await ctx.newPage();
  try {
    await pg.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const reflowPath = outBase + '-reflow-320px.png';
    await pg.screenshot({ path: reflowPath, fullPage: false });
    const layout = await pg.evaluate(() => {
      const docWidth  = document.documentElement.scrollWidth;
      const viewWidth = window.innerWidth;
      const hasHScroll = docWidth > viewWidth;
      const excessPx   = Math.max(0, docWidth - viewWidth);
      const wideEls    = hasHScroll
        ? [...document.querySelectorAll('*')].filter(el => { const r = el.getBoundingClientRect(); return r.right > viewWidth + 5 && r.width > 0; }).slice(0, 5).map(el => ({ tag: el.tagName, class: (el.className || '').split(' ')[0] || null, right: Math.round(el.getBoundingClientRect().right) }))
        : [];
      return { hasHorizontalScroll: hasHScroll, excessPx, wideElements: wideEls };
    });
    return {
      out: reflowPath,
      hasHorizontalScrollAt320px: layout.hasHorizontalScroll,
      excessPx: layout.excessPx,
      wideElements: layout.wideElements,
      warnings: layout.hasHorizontalScroll
        ? [`Content has horizontal scroll at 320px — fails WCAG 1.4.10 Reflow`]
        : [],
    };
  } catch (e) { return { error: e.message }; }
  finally { await ctx.close(); }
}

async function captureTextSpacing(page, outBase) {
  await page.addStyleTag({ content: '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }' });
  await page.waitForTimeout(300);
  const ssPath = outBase + '-text-spacing.png';
  await page.screenshot({ path: ssPath, fullPage: false });
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll('button, a, li, td, th, label, [role="button"]')]
      .filter(el => {
        const s = window.getComputedStyle(el);
        if (s.overflow === 'visible' || s.overflow === 'auto' || s.overflow === 'scroll') return false;
        return el.scrollHeight > el.clientHeight + 4 || el.scrollWidth > el.clientWidth + 4;
      }).slice(0, 10).map(el => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 40),
        overflowH: Math.max(0, el.scrollHeight - el.clientHeight),
        overflowW: Math.max(0, el.scrollWidth - el.clientWidth),
      }))
  );
  return {
    out: ssPath,
    clippedElements: clipped,
    warnings: clipped.length > 0 ? [`${clipped.length} element(s) clip content under WCAG 1.4.12 text-spacing overrides`] : [],
  };
}

async function runPaintComplexityAudit(page) {
  return page.evaluate(() => {
    const AREA_THRESHOLD = 50000;
    const expensive = [...document.querySelectorAll('*')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width * r.height > AREA_THRESHOLD;
    }).flatMap(el => {
      const s   = window.getComputedStyle(el);
      const tag = el.tagName.toLowerCase();
      const cls = el.className ? '.' + String(el.className).trim().split(/\s+/)[0] : '';
      const sel = (tag + (el.id ? '#' + el.id : cls)).slice(0, 60);
      const r   = el.getBoundingClientRect();
      const area = Math.round(r.width * r.height);
      const items = [];
      if (s.filter && s.filter !== 'none')
        items.push({ type: 'filter', selector: sel, value: s.filter.slice(0, 80), area });
      if (s.backdropFilter && s.backdropFilter !== 'none')
        items.push({ type: 'backdrop-filter', selector: sel, value: s.backdropFilter.slice(0, 80), area });
      const shadowLayers = (s.boxShadow || '').split('),').length;
      if (shadowLayers > 2)
        items.push({ type: 'multi-layer-box-shadow', selector: sel, layers: shadowLayers, area });
      return items;
    }).slice(0, 10);
    return {
      expensiveProperties: expensive,
      warnings: expensive.length > 0 ? [`${expensive.length} large element(s) with expensive paint properties — may cause rendering jank`] : [],
    };
  });
}

async function runStateContrastAudit(page) {
  function linearize(c) { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
  function luminance(r, g, b) { return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b); }
  function contrastRatio(l1, l2) { const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return parseFloat(((hi + 0.05) / (lo + 0.05)).toFixed(2)); }
  function parseRGB(s) { const m = (s || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/); return m ? [+m[1], +m[2], +m[3]] : null; }

  const issues = [];
  const candidates = await page.$$('button:visible, a[href]:visible, [role="button"]:visible');
  const limit = Math.min(candidates.length, 15);

  for (let i = 0; i < limit; i++) {
    const el = candidates[i];
    try {
      const defColors = await el.evaluate(e => {
        const s = window.getComputedStyle(e);
        return { fg: s.color, bg: s.backgroundColor, text: (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 40), tag: e.tagName.toLowerCase() };
      });
      const defFg = parseRGB(defColors.fg), defBg = parseRGB(defColors.bg);
      if (defFg && defBg) {
        const ratio = contrastRatio(luminance(...defFg), luminance(...defBg));
        if (ratio < 4.5) issues.push({ state: 'default', tag: defColors.tag, text: defColors.text, contrast: ratio, fg: defColors.fg, bg: defColors.bg });
      }
      await el.hover({ timeout: 1000 }).catch(() => {});
      await page.waitForTimeout(80);
      const hoverColors = await el.evaluate(e => { const s = window.getComputedStyle(e); return { fg: s.color, bg: s.backgroundColor }; });
      await page.mouse.move(0, 0);
      await page.waitForTimeout(80);
      const hvFg = parseRGB(hoverColors.fg), hvBg = parseRGB(hoverColors.bg);
      if (hvFg && hvBg) {
        const ratio = contrastRatio(luminance(...hvFg), luminance(...hvBg));
        if (ratio < 4.5) issues.push({ state: 'hover', tag: defColors.tag, text: defColors.text, contrast: ratio, fg: hoverColors.fg, bg: hoverColors.bg });
      }
    } catch {}
  }
  return {
    checked: limit,
    lowContrast: issues.length,
    details: issues.slice(0, 20),
    warnings: issues.length > 0 ? [`${issues.length} interactive element(s) with contrast < 4.5:1 in default or hover state (WCAG 1.4.3)`] : [],
  };
}

async function runRequiredFieldsAudit(page) {
  return page.evaluate(() => {
    const required = [...document.querySelectorAll('input[required], select[required], textarea[required]')];
    const missingAriaRequired = required
      .filter(el => el.getAttribute('aria-required') !== 'true')
      .slice(0, 10).map(el => ({
        type:  el.type || el.tagName.toLowerCase(),
        name:  el.name || el.id || null,
        label: el.getAttribute('aria-label') || null,
      }));
    return {
      count: required.length,
      missingAriaRequired,
      warnings: missingAriaRequired.length > 0
        ? [`${missingAriaRequired.length} required field(s) missing aria-required="true"`]
        : [],
    };
  });
}

async function runMissingFillModeAudit(page) {
  return page.evaluate(() => {
    const missingFillMode = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSStyleRule) {
            const animName = rule.style.getPropertyValue('animation-name');
            if (!animName || animName === 'none') continue;
            const iterCount = rule.style.getPropertyValue('animation-iteration-count');
            if (iterCount === 'infinite') continue;
            const fillMode = rule.style.getPropertyValue('animation-fill-mode');
            if (!fillMode || fillMode === 'none' || fillMode === 'backwards') {
              missingFillMode.push({
                selector:      (rule.selectorText || '').slice(0, 80),
                animationName: animName.slice(0, 40),
                fillMode:      fillMode || '(not set)',
              });
            }
          }
        }
      } catch {}
    }
    const unique = [...new Map(missingFillMode.map(x => [x.selector, x])).values()].slice(0, 10);
    return {
      missingFillMode: unique,
      warnings: unique.length > 0
        ? [`${unique.length} animation(s) missing fill-mode:forwards/both — element snaps back after animation ends`]
        : [],
    };
  });
}

async function runEmptyStatesAudit(page) {
  return page.evaluate(() => {
    const spinners = [...document.querySelectorAll('[class*="spin"], [class*="loading"], [class*="skeleton"], [role="progressbar"]')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && window.getComputedStyle(el).display !== 'none';
      }).slice(0, 5).map(el => ({
        tag:   el.tagName.toLowerCase(),
        class: (el.className || '').toString().trim().split(/\s+/)[0] || null,
        role:  el.getAttribute('role') || null,
      }));
    const emptyContainers = [...document.querySelectorAll('ul, ol, tbody, [role="list"], [role="grid"]')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return [...el.children].filter(c => window.getComputedStyle(c).display !== 'none').length === 0;
      }).slice(0, 5).map(el => ({
        tag:   el.tagName.toLowerCase(),
        class: (el.className || '').trim().split(/\s+/)[0] || null,
        role:  el.getAttribute('role') || null,
      }));
    return {
      spinners,
      emptyContainers,
      warnings: [
        spinners.length > 0        && `${spinners.length} loading indicator(s) still visible after page load — may be stuck`,
        emptyContainers.length > 0 && `${emptyContainers.length} list/grid container(s) with no items — add an empty-state message`,
      ].filter(Boolean),
    };
  });
}

// ── New always-on audit functions ─────────────────────────────────────────────

async function runLandmarkAudit(page) {
  return page.evaluate(() => {
    const has = sel => !!document.querySelector(sel);
    const hasMain        = has('main') || has('[role="main"]');
    const hasNav         = has('nav')  || has('[role="navigation"]');
    const hasBanner      = has('header[role="banner"]') || has('[role="banner"]') || has('header');
    const hasContentinfo = has('footer[role="contentinfo"]') || has('[role="contentinfo"]') || has('footer');
    return {
      hasMain, hasNav, hasBanner, hasContentinfo,
      warnings: [
        !hasMain        && 'No <main> landmark — screen reader users cannot skip to main content (WCAG 2.4.1)',
        !hasNav         && 'No <nav> landmark — navigation region not identified for assistive technology',
      ].filter(Boolean),
    };
  });
}

async function runTableA11yAudit(page) {
  return page.evaluate(() => {
    const tables = [...document.querySelectorAll('table')].filter(t => { const r = t.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    if (!tables.length) return { count: 0, issues: [], warnings: [] };
    const issues = tables.slice(0, 10).map(table => {
      const hasCaption = !!table.querySelector('caption') || !!table.getAttribute('aria-label') || !!table.getAttribute('aria-labelledby');
      const thEls = [...table.querySelectorAll('th')];
      const hasTh  = thEls.length > 0;
      const thWithScope = thEls.filter(th => th.getAttribute('scope')).length;
      return { class: (table.className || '').trim().split(/\s+/)[0] || null, hasCaption, hasTh, thWithScope, thCount: thEls.length };
    }).filter(i => !i.hasCaption || !i.hasTh || (i.hasTh && i.thWithScope < i.thCount));
    return {
      count: tables.length,
      issues: issues.slice(0, 5),
      warnings: [
        issues.some(i => !i.hasTh)                            && 'Table(s) missing <th> header cells (WCAG 1.3.1)',
        issues.some(i => !i.hasCaption)                       && 'Table(s) missing <caption> or aria-label (WCAG 1.3.1)',
        issues.some(i => i.hasTh && i.thWithScope < i.thCount) && 'Table <th> element(s) missing scope attribute',
      ].filter(Boolean),
    };
  });
}

async function runDialogAudit(page) {
  return page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('dialog,[role="dialog"],[role="alertdialog"]')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const issues = dialogs.map(el => ({
      tag:        el.tagName.toLowerCase(),
      hasAriaModal: el.getAttribute('aria-modal') === 'true',
      hasLabel:   !!(el.getAttribute('aria-labelledby') || el.getAttribute('aria-label')),
    })).filter(d => !d.hasAriaModal || !d.hasLabel);
    return {
      count:  dialogs.length,
      issues: issues.slice(0, 5),
      warnings: [
        issues.some(d => !d.hasAriaModal) && 'Dialog(s) missing aria-modal="true" (WCAG 4.1.2)',
        issues.some(d => !d.hasLabel)     && 'Dialog(s) missing accessible name via aria-labelledby/aria-label (WCAG 4.1.2)',
      ].filter(Boolean),
    };
  });
}

async function runWidgetAudit(page) {
  return page.evaluate(() => {
    // Toggle buttons with aria-controls but missing aria-expanded
    const toggleBtns = [...document.querySelectorAll('button[aria-controls],[role="button"][aria-controls]')]
      .filter(el => el.getAttribute('aria-expanded') === null)
      .slice(0, 10).map(el => ({ tag: el.tagName.toLowerCase(), text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40), controls: el.getAttribute('aria-controls') }));
    // Tabs pattern
    const tabEls    = [...document.querySelectorAll('[role="tab"]')];
    const tabIssues = tabEls.slice(0, 10).reduce((acc, tab) => {
      const ok = !!tab.closest('[role="tablist"]') && tab.getAttribute('aria-selected') !== null;
      if (!ok) acc.push({ text: tab.textContent.trim().slice(0, 30), hasTablist: !!tab.closest('[role="tablist"]'), hasSelected: tab.getAttribute('aria-selected') !== null });
      return acc;
    }, []);
    // Carousel/slider
    const carousels = [...document.querySelectorAll('[class*="carousel"],[class*="slider"],[class*="swiper"],[class*="splide"],[class*="glide"]')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 100 && r.height > 50; });
    const carouselIssues = carousels.slice(0, 5).map(el => ({
      class:        (el.className || '').trim().split(/\s+/)[0],
      hasPrevNext:  !!(el.querySelector('button') || el.querySelector('[role="button"]')),
      hasRoleDesc:  !!el.getAttribute('aria-roledescription'),
    }));
    // Combobox missing aria-expanded / aria-controls (APG / WCAG 4.1.2)
    const comboboxIssues = [...document.querySelectorAll('[role="combobox"]')].slice(0, 10).reduce((acc, el) => {
      const missingExpanded = el.getAttribute('aria-expanded') === null;
      const controlsId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
      const missingListbox = el.getAttribute('aria-expanded') === 'true' && (!controlsId || !document.getElementById(controlsId)?.matches('[role="listbox"]'));
      if (missingExpanded || missingListbox) acc.push({ id: el.id || null, missingExpanded, missingListbox });
      return acc;
    }, []);
    return {
      toggleButtonsMissingExpanded: toggleBtns.length,
      tabIssues: tabIssues.length,
      carouselCount: carousels.length,
      comboboxIssues: comboboxIssues.length,
      details: { toggleBtns: toggleBtns.slice(0, 5), tabIssues: tabIssues.slice(0, 5), carouselIssues, comboboxIssues },
      warnings: [
        toggleBtns.length > 0                          && `${toggleBtns.length} toggle button(s) missing aria-expanded (WCAG 4.1.2)`,
        tabIssues.length > 0                           && `${tabIssues.length} [role="tab"] element(s) missing tablist parent or aria-selected (WCAG 4.1.2)`,
        carouselIssues.some(c => !c.hasPrevNext)       && 'Carousel(s) missing previous/next navigation buttons (WCAG 2.1.1)',
        comboboxIssues.length > 0                      && `${comboboxIssues.length} combobox element(s) missing aria-expanded or aria-controls→listbox (WCAG 4.1.2)`,
      ].filter(Boolean),
    };
  });
}

async function runSecurityAudit(page) {
  return page.evaluate(() => {
    // target=_blank without rel=noopener/noreferrer (tab-napping)
    const unsafeBlank = [...document.querySelectorAll('a[target="_blank"]')]
      .filter(a => { const rel = (a.getAttribute('rel') || '').split(/\s+/); return !rel.includes('noopener') && !rel.includes('noreferrer'); })
      .slice(0, 10).map(a => ({ href: (a.getAttribute('href') || '').slice(0, 80), text: a.textContent.trim().slice(0, 40) }));
    // Mixed content (http:// on https: page)
    const mixedContent = location.protocol === 'https:' ? (() => {
      const found = [];
      for (const attr of ['src','href','action','data']) {
        for (const el of document.querySelectorAll(`[${attr}^="http://"]`)) {
          if (el.tagName === 'A') continue;
          found.push({ tag: el.tagName.toLowerCase(), attr, value: (el.getAttribute(attr) || '').slice(0, 80) });
        }
      }
      return found.slice(0, 10);
    })() : [];
    return {
      unsafeTargetBlank: unsafeBlank.length,
      mixedContent: mixedContent.length,
      details: { unsafeBlank: unsafeBlank.slice(0, 5), mixedContent: mixedContent.slice(0, 5) },
      warnings: [
        unsafeBlank.length > 0  && `${unsafeBlank.length} link(s) with target="_blank" missing rel="noopener" — tab-napping vulnerability`,
        mixedContent.length > 0 && `${mixedContent.length} element(s) load http:// content on https page — browser will block`,
      ].filter(Boolean),
    };
  });
}

async function runStatusMessageAudit(page) {
  return page.evaluate(() => {
    const sels = ['[class*="toast"]','[class*="alert"]','[class*="notification"]','[class*="snackbar"]','[class*="banner"]','[class*="feedback"]','[role="status"]','[role="alert"]','[aria-live]'];
    const all  = [...new Set(sels.flatMap(s => { try { return [...document.querySelectorAll(s)]; } catch { return []; } }))];
    const missingLive = all.filter(el => {
      const role = el.getAttribute('role'), live = el.getAttribute('aria-live');
      return !live && role !== 'alert' && role !== 'status' && role !== 'log' && role !== 'timer';
    }).slice(0, 10).map(el => ({ tag: el.tagName.toLowerCase(), class: (el.className || '').trim().split(/\s+/)[0] || null, role: el.getAttribute('role') || null }));
    return {
      count: all.length,
      missingAriaLive: missingLive.length,
      warnings: missingLive.length > 0 ? [`${missingLive.length} status/notification container(s) missing aria-live or role="status/alert" (WCAG 4.1.3)`] : [],
    };
  });
}

async function runDomSizeAudit(page) {
  return page.evaluate(() => {
    const total = document.querySelectorAll('*').length;
    return {
      totalNodes: total,
      warnings: total > 3000 ? [`DOM has ${total} nodes — severely exceeds Lighthouse 1500-node threshold; layout recalculation is slow`]
              : total > 1500 ? [`DOM has ${total} nodes — exceeds Lighthouse 1500-node recommendation`]
              : [],
    };
  });
}

async function runPreconnectAudit(page) {
  return page.evaluate(() => {
    const pageOrigin  = location.origin;
    const resources   = performance.getEntriesByType('resource');
    const thirdOrigins= [...new Set(resources.map(r => { try { return new URL(r.name).origin; } catch { return null; } }).filter(o => o && o !== pageOrigin))];
    const hinted      = new Set([...document.querySelectorAll('link[rel="preconnect"],link[rel="dns-prefetch"]')].map(l => { try { return new URL(l.href).origin; } catch { return null; } }).filter(Boolean));
    const missing     = thirdOrigins.filter(o => !hinted.has(o)).slice(0, 10);
    return {
      thirdPartyOrigins:  thirdOrigins.length,
      preconnected:       hinted.size,
      missingPreconnect:  missing.length,
      details: missing,
      warnings: missing.length > 0 ? [`${missing.length} third-party origin(s) without preconnect/dns-prefetch — adds DNS+TCP+TLS latency`] : [],
    };
  });
}

async function runRtlAudit(page) {
  return page.evaluate(() => {
    const dir = (document.documentElement.getAttribute('dir') || document.body?.getAttribute('dir') || '').toLowerCase();
    if (dir !== 'rtl') return { isRtl: false, issues: [], warnings: [] };
    const PHYSICAL = ['margin-left','margin-right','padding-left','padding-right','border-left','border-right','border-left-width','border-right-width'];
    const issues = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (!(rule instanceof CSSStyleRule)) continue;
          const sel = (rule.selectorText || '').slice(0, 60);
          for (const p of PHYSICAL) { const v = rule.style.getPropertyValue(p); if (v) { issues.push({ selector: sel, property: p, value: v.slice(0, 30) }); break; } }
          const fl = rule.style.getPropertyValue('float'), ta = rule.style.getPropertyValue('text-align');
          if (fl === 'left' || fl === 'right') issues.push({ selector: sel, property: 'float', value: fl });
          if (ta === 'left' || ta === 'right') issues.push({ selector: sel, property: 'text-align', value: ta });
        }
      } catch {}
    }
    const unique = [...new Map(issues.map(x => [x.selector + x.property, x])).values()].slice(0, 10);
    return {
      isRtl: true, issues: unique,
      warnings: unique.length > 0 ? [`${unique.length} CSS rule(s) use physical directional properties on RTL page — use logical properties`] : [],
    };
  });
}

// ── New flag-gated audit functions ─────────────────────────────────────────────

async function runBodyTextContrast(page) {
  function linearize(c) { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
  function luminance(r, g, b) { return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b); }
  function contrastRatio(l1, l2) { const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return parseFloat(((hi + 0.05) / (lo + 0.05)).toFixed(2)); }
  function parseRGB(s) { const m = (s || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/); return m ? [+m[1], +m[2], +m[3]] : null; }
  const samples = await page.evaluate(() =>
    [...document.querySelectorAll('p,li,td,th,h1,h2,h3,h4,h5,h6,label')].filter(el => {
      const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.textContent.trim().length > 3;
    }).slice(0, 120).map(el => {
      const s = window.getComputedStyle(el);
      return { fg: s.color, bg: s.backgroundColor, tag: el.tagName.toLowerCase(), text: el.textContent.trim().slice(0, 30), fontSize: parseFloat(s.fontSize), fontWeight: parseInt(s.fontWeight) };
    })
  );
  const lowContrast = [];
  for (const el of samples) {
    const fg = parseRGB(el.fg), bg = parseRGB(el.bg);
    if (!fg || !bg) continue;
    const isLarge    = el.fontSize >= 18 || (el.fontWeight >= 700 && el.fontSize >= 14);
    const required   = isLarge ? 3.0 : 4.5;
    const ratio      = contrastRatio(luminance(...fg), luminance(...bg));
    if (ratio < required) lowContrast.push({ tag: el.tag, text: el.text, contrast: ratio, required, fg: el.fg, bg: el.bg });
  }
  const unique = [...new Map(lowContrast.map(x => [x.fg + x.bg, x])).values()].slice(0, 20);
  return { checked: samples.length, lowContrast: unique.length, details: unique, warnings: unique.length > 0 ? [`${unique.length} text element(s) below WCAG 1.4.3 contrast threshold`] : [] };
}

async function runPlaceholderContrast(page) {
  function linearize(c) { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
  function luminance(r, g, b) { return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b); }
  function contrastRatio(l1, l2) { const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return parseFloat(((hi + 0.05) / (lo + 0.05)).toFixed(2)); }
  function parseRGB(s) { const m = (s || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/); return m ? [+m[1], +m[2], +m[3]] : null; }
  const data = await page.evaluate(() => {
    const phColors = [];
    for (const sheet of document.styleSheets) {
      try { for (const rule of sheet.cssRules) { if (rule instanceof CSSStyleRule && /::?-?placeholder/i.test(rule.selectorText || '')) { const c = rule.style.color; if (c) phColors.push(c); } } } catch {}
    }
    const inputs = [...document.querySelectorAll('input[placeholder],textarea[placeholder]')].filter(el => el.getBoundingClientRect().width > 0).slice(0, 20)
      .map(el => ({ bg: window.getComputedStyle(el).backgroundColor, placeholder: (el.getAttribute('placeholder') || '').slice(0, 30), type: el.type || 'text' }));
    return { phColors: phColors.slice(0, 3), inputs };
  });
  if (!data.phColors.length) return { checked: 0, lowContrast: 0, warnings: [] };
  const phColor = data.phColors[0];
  const lowContrast = data.inputs.reduce((acc, inp) => {
    const fg = parseRGB(phColor), bg = parseRGB(inp.bg);
    if (!fg || !bg) return acc;
    const ratio = contrastRatio(luminance(...fg), luminance(...bg));
    if (ratio < 4.5) acc.push({ type: inp.type, placeholder: inp.placeholder, contrast: ratio });
    return acc;
  }, []);
  return { checked: data.inputs.length, lowContrast: lowContrast.length, details: lowContrast.slice(0, 10), warnings: lowContrast.length > 0 ? [`${lowContrast.length} input placeholder(s) with contrast < 4.5:1 (WCAG 1.4.3)`] : [] };
}

async function runNonTextContrast(page) {
  function linearize(c) { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
  function luminance(r, g, b) { return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b); }
  function contrastRatio(l1, l2) { const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return parseFloat(((hi + 0.05) / (lo + 0.05)).toFixed(2)); }
  function parseRGB(s) { const m = (s || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/); return m ? [+m[1], +m[2], +m[3]] : null; }
  const samples = await page.evaluate(() =>
    [...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(el => el.getBoundingClientRect().width > 0).slice(0, 30)
      .map(el => {
        const s  = window.getComputedStyle(el);
        const ps = el.parentElement ? window.getComputedStyle(el.parentElement) : null;
        return { border: s.borderTopColor || s.borderColor, parentBg: ps?.backgroundColor || 'rgb(255,255,255)', tag: el.tagName.toLowerCase(), type: el.type || el.tagName.toLowerCase() };
      })
  );
  const lowContrast = samples.reduce((acc, el) => {
    const fg = parseRGB(el.border), bg = parseRGB(el.parentBg);
    if (!fg || !bg) return acc;
    const ratio = contrastRatio(luminance(...fg), luminance(...bg));
    if (ratio < 3.0) acc.push({ tag: el.tag, type: el.type, contrast: ratio, border: el.border });
    return acc;
  }, []);
  const unique = [...new Map(lowContrast.map(x => [x.border + x.tag, x])).values()].slice(0, 10);
  return { checked: samples.length, lowContrast: unique.length, details: unique, warnings: unique.length > 0 ? [`${unique.length} form input border(s) with contrast < 3:1 (WCAG 1.4.11)`] : [] };
}

async function runPWAReadiness(page) {
  const hasManifest = await page.evaluate(() => !!document.querySelector('link[rel="manifest"]'));
  const hasSW = await page.evaluate(async () => {
    if (!navigator.serviceWorker) return false;
    try { return (await navigator.serviceWorker.getRegistrations()).length > 0; } catch { return false; }
  });
  return {
    hasManifest, hasServiceWorker: hasSW,
    warnings: [
      !hasManifest && 'No <link rel="manifest"> — PWA is not installable',
      !hasSW       && 'No service worker registered — no offline support',
    ].filter(Boolean),
  };
}

async function runSRIAudit(page) {
  return page.evaluate(() => {
    const origin  = location.origin;
    const missing = [];
    for (const s of document.querySelectorAll('script[src]')) {
      try { if (new URL(s.src).origin !== origin && !s.getAttribute('integrity')) missing.push({ type: 'script', src: s.src.slice(0, 80) }); } catch {}
    }
    for (const l of document.querySelectorAll('link[rel="stylesheet"][href]')) {
      try { if (new URL(l.href).origin !== origin && !l.getAttribute('integrity')) missing.push({ type: 'stylesheet', src: l.href.slice(0, 80) }); } catch {}
    }
    return { missingSRI: missing.length, details: missing.slice(0, 10), warnings: missing.length > 0 ? [`${missing.length} external resource(s) missing integrity attribute — CDN compromise risk`] : [] };
  });
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
async function runFullAudit(page, outPath, outBase, browser, imageFormats = {}) {
  const [
    meta, images, scripts, touchTargets, headings, domA11y, layout, bundle, fonts,
    typography, interactiveStates, cursor, viewportUnits, mediaQuerySupport, formUX,
    animationDurations, stacking, svgA11y, mediaA11y, colorOnly, textSelectability,
    landmarks, tableA11y, dialogs, widgets, security, statusMessages, domSize, preconnect, rtl,
  ] = await Promise.all([
    runMetaAudit(page),
    runImageAudit(page, imageFormats),
    runScriptAudit(page),
    runTouchTargetAudit(page),
    runHeadingAudit(page),
    runDomA11yAudit(page),
    runLayoutAudit(page),
    runBundleAudit(page),
    runFontAudit(page),
    runTypographyAudit(page),
    runInteractiveStateAudit(page),
    runCursorAudit(page),
    runViewportUnitsAudit(page),
    runMediaQueryAudit(page),
    runFormUXAudit(page),
    runAnimationDurationAudit(page),
    runStackingAudit(page),
    runSVGAudit(page),
    runMediaAudit(page),
    runColorOnlyAudit(page),
    runTextSelectabilityAudit(page),
    runLandmarkAudit(page),
    runTableA11yAudit(page),
    runDialogAudit(page),
    runWidgetAudit(page),
    runSecurityAudit(page),
    runStatusMessageAudit(page),
    runDomSizeAudit(page),
    runPreconnectAudit(page),
    runRtlAudit(page),
  ]);

  let darkMode_, darkModeA11y_;
  if (darkMode) {
    const darkOut = await captureDarkMode(page, outPath, true);
    const dmA11y  = await runAxe(page);
    await page.emulateMedia({ colorScheme: 'light' });
    darkMode_     = { out: darkOut };
    darkModeA11y_ = dmA11y;
  }

  let reducedMotion_, forcedColors_, print_;
  if (reducedMotion) reducedMotion_ = { out: await captureReducedMotion(page, outPath) };
  if (forcedColors)  forcedColors_  = { out: await captureForcedColors(page, outPath)  };
  if (printLayout)   print_         = { out: await capturePrintLayout(page, outPath)   };

  let linkCheck;
  if (linkCheckMode) linkCheck = await runLinkCheck(page);

  let reflow;
  if (reflowMode && browser) reflow = await captureReflow(browser, page.url(), outBase, height);

  let paintComplexityResult;
  if (paintComplexity) paintComplexityResult = await runPaintComplexityAudit(page);

  let stateContrastResult;
  if (stateContrast) stateContrastResult = await runStateContrastAudit(page);

  let requiredFieldsResult;
  if (requiredFieldsMode) requiredFieldsResult = await runRequiredFieldsAudit(page);

  if (animFillMode) {
    const fillResult = await runMissingFillModeAudit(page);
    animationDurations.missingFillMode = fillResult.missingFillMode;
    if (fillResult.warnings.length) animationDurations.warnings.push(...fillResult.warnings);
  }

  let emptyStatesResult;
  if (emptyStatesMode) emptyStatesResult = await runEmptyStatesAudit(page);

  let bodyTextContrastResult;
  if (textContrastMode) bodyTextContrastResult = await runBodyTextContrast(page);

  let placeholderContrastResult;
  if (placeholderContrastMode) placeholderContrastResult = await runPlaceholderContrast(page);

  let nonTextContrastResult;
  if (nonTextContrastMode) nonTextContrastResult = await runNonTextContrast(page);

  let pwaResult;
  if (pwaMode) pwaResult = await runPWAReadiness(page);

  let sriResult;
  if (sriMode) sriResult = await runSRIAudit(page);

  // text-spacing must run last (injects CSS that permanently alters the page)
  let textSpacing;
  if (textSpacingMode) textSpacing = await captureTextSpacing(page, outBase);

  return {
    meta, images, scripts, touchTargets, headings, domA11y, layout, bundle, fonts,
    typography, interactiveStates, cursor, viewportUnits, mediaQuerySupport, formUX,
    animationDurations, stacking, svgA11y, mediaA11y, colorOnly, textSelectability,
    landmarks, tableA11y, dialogs, widgets, security, statusMessages, domSize, preconnect, rtl,
    ...(darkMode_                && { darkMode: darkMode_ }),
    ...(darkModeA11y_            && { darkModeA11y: darkModeA11y_ }),
    ...(reducedMotion_           && { reducedMotion: reducedMotion_ }),
    ...(forcedColors_            && { forcedColors: forcedColors_ }),
    ...(print_                   && { print: print_ }),
    ...(linkCheck                && { linkCheck }),
    ...(reflow                   && { reflow }),
    ...(paintComplexityResult    && { paintComplexity: paintComplexityResult }),
    ...(stateContrastResult      && { stateContrast: stateContrastResult }),
    ...(requiredFieldsResult     && { requiredFields: requiredFieldsResult }),
    ...(emptyStatesResult        && { emptyStates: emptyStatesResult }),
    ...(bodyTextContrastResult   && { bodyTextContrast: bodyTextContrastResult }),
    ...(placeholderContrastResult && { placeholderContrast: placeholderContrastResult }),
    ...(nonTextContrastResult    && { nonTextContrast: nonTextContrastResult }),
    ...(pwaResult                && { pwa: pwaResult }),
    ...(sriResult                && { sri: sriResult }),
    ...(textSpacing              && { textSpacing }),
  };
}

// ── Single-page mode ──────────────────────────────────────────────────────────
async function singlePage() {
  const outBase = outArg.replace(/\.png$/i, '');
  const outDir  = path.dirname(outBase);
  if (outDir && outDir !== '.' && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page    = await context.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width, height });

  const tracker = url !== 'about:blank' ? setupResponseTracking(page) : null;
  if (cwvMode && url !== 'about:blank') await installCWVObserver(page);

  if (url === 'about:blank') {
    await page.setContent('<h1 style="font-family:sans-serif;color:green">Playwright E2E OK</h1>');
  } else {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  await page.screenshot({ path: outArg, fullPage: false });

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
  if (url !== 'about:blank') {
    const imageFormats = tracker ? tracker.getImageFormats() : {};
    auditResult = await runFullAudit(page, outArg, outBase, browser, imageFormats);
  }

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
  if (cwv)              result.cwv        = cwv;
  if (diff)             result.diff       = diff;
  if (noJs)             result.noJs       = noJs;
  if (focusAuditResult) result.focusAudit = focusAuditResult;

  process.stdout.write(JSON.stringify(result) + '\n');
}

// ── Multi-page: single-route audit ────────────────────────────────────────────
async function pageChecks(page, pageUrl, outPath, route, browser) {
  const errors = [];
  const errHandler = e => errors.push(e.message);
  page.on('pageerror', errHandler);
  const tracker2 = setupResponseTracking(page);
  try {
    await page.setViewportSize({ width, height });
    if (cwvMode) await installCWVObserver(page);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.screenshot({ path: outPath, fullPage: false });
    const a11y        = await runAxe(page);
    let advanced;
    if (anyAdvFlag) { const detected = await detectFeatures(page); advanced = await runAdvanced(page, outPath.replace(/\.png$/i, ''), detected); }
    const imageFormats2 = tracker2 ? tracker2.getImageFormats() : {};
    const auditResult = await runFullAudit(page, outPath, outPath.replace(/\.png$/i, ''), browser, imageFormats2);
    let cwv;
    if (cwvMode) cwv = await runCWV(page);
    let focusAuditResult;
    if (focusAudit) focusAuditResult = await runFocusAuditFn(page, outPath.replace(/\.png$/i, ''));
    const entry = { ok: true, url: pageUrl, route, out: outPath, width, height, consoleErrors: errors, a11y };
    Object.assign(entry, auditResult);
    if (advanced)         entry.advanced   = advanced;
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

  const browser       = await chromium.launch({ headless: true });
  const sharedContext = await browser.newContext();
  const results       = [];

  if (navStrat === 'tab-click') {
    const page = await sharedContext.newPage();
    await page.setViewportSize({ width, height });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const tabs = await discoverTabs(page);
    if (tabs.length === 0) {
      const outPath = `${prefix}-root.png`;
      await page.screenshot({ path: outPath, fullPage: false });
      const a11y    = await runAxe(page);
      const audit   = await runFullAudit(page, outPath, outPath.replace(/\.png$/i, ''), browser);
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
          const audit   = await runFullAudit(page, outPath, outPath.replace(/\.png$/i, ''), browser);
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
      const entry   = await pageChecks(page, pageUrl, outPath, route, browser);
      results.push(entry);
      await page.close();
    }
  }

  await sharedContext.close();
  await browser.close();

  process.stdout.write(JSON.stringify(results) + '\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────
(multiMode ? multiPage() : singlePage()).catch(e => {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
  process.exit(1);
});
