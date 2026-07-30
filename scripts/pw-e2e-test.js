// pw-e2e-test.js — Playwright UI/UX audit tool.
//
// Single-page: node pw-e2e-test.js <url> <out.png> [width] [height] [flags]
// Multi-page:  node pw-e2e-test.js <url> <prefix> [w] [h] --routes=auto|/r1,/r2 [--nav=link-crawl|tab-click]
//
// Always-on for real URLs (zero overhead):
//   meta            title, viewport, blocksZoom (WCAG 1.4.4), lang, charset, dir
//   images          broken, missingAlt, oversized, lazy-above-fold, missingFetchPriority, missingSrcset
//   scripts         render-blocking third-party scripts (delays page display)
//   touchTargets    interactive elements < 24×24px (WCAG 2.5.8)
//   headings        h1 count, heading level skips (WCAG 2.4.6)
//   domA11y         broken ARIA ID refs, unlabeled form inputs (WCAG 1.3.1)
//   layout          horizontal scroll / viewport overflow
//   bundle          JS/CSS/image KB, largest + slowest resources
//   fonts           loaded/failed, FOIT/FOUT risk
//   redirects       3xx redirect chain (only present when redirects occur)
//
// Flag-gated checks:
//   --dark-mode       screenshot + axe in dark mode → darkMode, darkModeA11y
//   --cwv             LCP, CLS+sources, FCP, TTFB, TBT → cwv
//   --compare=<path>  pixel-diff vs baseline → diff
//   --reduced-motion  prefers-reduced-motion screenshot → reducedMotion
//   --forced-colors   forced-colors: active screenshot → forcedColors
//   --print           media: print screenshot → print
//   --no-js           JS-disabled screenshot → noJs
//   --focus-audit     keyboard focus ring audit → focusAudit
//   --link-check      broken internal link check (HEAD, cap 20) → linkCheck
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

const darkMode     = flags['dark-mode']      === 'true';
const cwvMode      = flags['cwv']            === 'true';
const comparePath  = flags['compare']        || null;
const reducedMotion= flags['reduced-motion'] === 'true';
const forcedColors = flags['forced-colors']  === 'true';
const printLayout  = flags['print']          === 'true';
const noJsMode     = flags['no-js']          === 'true';
const focusAudit   = flags['focus-audit']    === 'true';
const linkCheckMode= flags['link-check']     === 'true';

// ── Response tracking (redirect chain + image formats) ────────────────────────
function setupResponseTracking(page) {
  const imageFormats  = {};
  const redirectChain = [];

  page.on('response', response => {
    try {
      const status  = response.status();
      const headers = response.headers();
      const resUrl  = response.url();

      if ([301, 302, 303, 307, 308].includes(status)) {
        redirectChain.push({ from: resUrl, status, to: headers['location'] || null });
      }

      const ct = headers['content-type'];
      if (ct && ct.startsWith('image/')) {
        imageFormats[resUrl] = ct.split(';')[0].trim();
      }
    } catch {}
  });

  return {
    getImageFormats:  () => imageFormats,
    getRedirectChain: () => redirectChain,
  };
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
    return {
      title: document.title || null,
      viewport: viewportContent,
      blocksZoom, lang, charset, dir, issues,
    };
  });
}

async function runImageAudit(page) {
  return page.evaluate(() => {
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
      };
    });
    const lazyAboveFold  = imgs.filter(i => i.foldIssue === 'LAZY_ABOVE_FOLD');
    const heroCandidates = imgs.filter(i => i.isHeroCandidate);
    const missingSrcset  = imgs.filter(i => i.missingSrcset);
    return {
      total:   imgs.length,
      broken:  imgs.filter(i => i.broken).length,
      missingAlt: imgs.filter(i => i.missingAlt).length,
      oversized:  imgs.filter(i => i.oversized).length,
      notLazy:    imgs.filter(i => !i.lazy && i.displayW > 100).length,
      lazyAboveFold:        lazyAboveFold.length,
      missingFetchPriority: heroCandidates.length,
      missingSrcset:        missingSrcset.length,
      details: {
        broken:       imgs.filter(i => i.broken).map(i => i.src),
        missingAlt:   imgs.filter(i => i.missingAlt).map(i => i.src || '(no src)'),
        oversized:    imgs.filter(i => i.oversized).map(i => ({ src: i.src, natural: `${i.naturalW}×${i.naturalH}`, display: `${i.displayW}×${i.displayH}` })),
        lazyAboveFold:lazyAboveFold.map(i => i.src),
        heroMissingFP:heroCandidates.map(i => i.src),
        missingSrcset:missingSrcset.map(i => i.src).slice(0, 5),
      },
      warnings: [
        lazyAboveFold.length  > 0 && `${lazyAboveFold.length} above-fold image(s) marked lazy — hurts LCP`,
        heroCandidates.length > 0 && `${heroCandidates.length} large above-fold image(s) missing fetchpriority="high"`,
        missingSrcset.length  > 0 && `${missingSrcset.length} image(s) > 200px wide missing srcset`,
      ].filter(Boolean),
    };
  });
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

async function runScriptAudit(page) {
  return page.evaluate(() => {
    const pageOrigin = location.origin;
    const scripts = [...document.querySelectorAll('script[src]')].map(s => {
      let origin;
      try { origin = new URL(s.src).origin; } catch { return null; }
      return { isThirdParty: origin !== pageOrigin, isAsync: s.async, isDefer: s.defer, isModule: s.type === 'module' };
    }).filter(Boolean);
    const thirdParty     = scripts.filter(s => s.isThirdParty);
    const renderBlocking = thirdParty.filter(s => !s.isAsync && !s.isDefer && !s.isModule);
    return {
      total:           scripts.length,
      thirdPartyCount: thirdParty.length,
      renderBlocking:  renderBlocking.length,
      warnings: renderBlocking.length > 0
        ? [`${renderBlocking.length} render-blocking third-party script(s) delay page display`]
        : [],
    };
  });
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
    return {
      brokenAriaRefs: brokenAriaRefs.slice(0, 10),
      unlabeledInputs: unlabeled.length,
      warnings: [
        brokenAriaRefs.length > 0 && `${brokenAriaRefs.length} broken ARIA reference(s)`,
        unlabeled.length > 0      && `${unlabeled.length} form input(s) missing accessible label (WCAG 1.3.1)`,
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
    return {
      hasHorizontalScroll, excessPx, wideElements,
      warnings: hasHorizontalScroll ? [`Page is ${excessPx}px wider than viewport — likely mobile breakage`] : [],
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
  const [meta, images, scripts, touchTargets, headings, domA11y, layout, bundle, fonts] = await Promise.all([
    runMetaAudit(page),
    runImageAudit(page),
    runScriptAudit(page),
    runTouchTargetAudit(page),
    runHeadingAudit(page),
    runDomA11yAudit(page),
    runLayoutAudit(page),
    runBundleAudit(page),
    runFontAudit(page),
  ]);

  const redirectChain = tracker.getRedirectChain();

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

  return {
    meta, images, scripts, touchTargets, headings, domA11y, layout, bundle, fonts,
    ...(redirectChain.length > 0 && { redirects: redirectChain }),
    ...(darkMode_     && { darkMode: darkMode_ }),
    ...(darkModeA11y_ && { darkModeA11y: darkModeA11y_ }),
    ...(reducedMotion_&& { reducedMotion: reducedMotion_ }),
    ...(forcedColors_ && { forcedColors: forcedColors_ }),
    ...(print_        && { print: print_ }),
    ...(linkCheck     && { linkCheck }),
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
  if (cwv)              result.cwv        = cwv;
  if (diff)             result.diff       = diff;
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
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.screenshot({ path: outPath, fullPage: false });
    const a11y        = await runAxe(page);
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

  process.stdout.write(JSON.stringify(results) + '\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────
(multiMode ? multiPage() : singlePage()).catch(e => {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
  process.exit(1);
});
