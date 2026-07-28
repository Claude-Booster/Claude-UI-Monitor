// Standalone Playwright smoke test — no MCP layer involved.
//
// Single-page (backward-compat):
//   node pw-e2e-test.js <url> <out.png> [width] [height]
//   → stdout: JSON object { ok, url, out, width, height, consoleErrors, a11y }
//
// Multi-page:
//   node pw-e2e-test.js <url> <out-prefix> [width] [height] --routes=auto|/r1,/r2 [--nav=link-crawl|tab-click]
//   → stdout: JSON array  [{ ok, url, route, out, ... }, ...]
//
// --routes=auto        Discover routes automatically (uses --nav strategy)
// --routes=/,/about    Explicit comma-separated route list
// --nav=link-crawl     (default) follow internal <a href> links
// --nav=tab-click      click [role=tab] / data-testid=stTab / .tab-nav elements
//
// Cap: 15 routes max for link-crawl auto-discovery; 10 tabs max for tab-click.

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
const routeArg  = flags['routes'];          // undefined | 'auto' | '/,/about'
const navStrat  = flags['nav'] || 'link-crawl';
const multiMode = !!routeArg;

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
          if (u.host !== new URL(base).host) return acc; // external
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
  // Try selectors in priority order; return first family that has >= 2 tabs
  const selectors = [
    '[data-testid="stTab"]',   // Streamlit
    '.tab-nav button',          // Gradio
    '[role="tab"]',             // generic ARIA
    'button[class*="tab"]',    // Panel / catch-all
  ];
  for (const sel of selectors) {
    const els = await page.$$(sel);
    if (els.length >= 2) {
      return els.slice(0, 10).map((_, i) => ({ selector: sel, index: i }));
    }
  }
  return [];
}

function routeSlug(route) {
  return route === '/' ? 'root' : route.replace(/^\//, '').replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40);
}

// ── Single-page mode (backward-compat) ───────────────────────────────────────
async function singlePage() {
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

  await browser.close();
  process.stdout.write(
    JSON.stringify({ ok: true, url, out: outArg, width, height, consoleErrors: errors, a11y }) + '\n'
  );
}

// ── Multi-page mode ───────────────────────────────────────────────────────────
async function multiPage() {
  // outArg used as a filename prefix (strip trailing .png if user added one)
  const prefix  = outArg.replace(/\.png$/i, '');
  const outDir  = path.dirname(prefix);
  if (outDir && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const results = [];

  if (navStrat === 'tab-click') {
    // ── Tab-click: stay on root URL, click each tab element ──────────────────
    const page = await browser.newPage();
    await page.setViewportSize({ width, height });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const tabs = await discoverTabs(page);

    if (tabs.length === 0) {
      // No tabs found — single root screenshot
      const outPath = `${prefix}-root.png`;
      await page.screenshot({ path: outPath, fullPage: false });
      results.push({ ok: true, url, route: '/', out: outPath, width, height,
                     consoleErrors: [], a11y: await runAxe(page), note: 'no-tabs-found' });
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
          await page.waitForTimeout(700); // let content settle

          const outPath = `${prefix}-tab-${label}.png`;
          await page.screenshot({ path: outPath, fullPage: false });
          results.push({ ok: true, url, route: `tab:${label}`, tab: tab.index,
                         out: outPath, width, height, consoleErrors: errors,
                         a11y: await runAxe(page) });
        } catch (e) {
          results.push({ ok: false, url, route: `tab:${tab.index}`, error: e.message });
        } finally {
          page.off('pageerror', errHandler);
        }
      }
    }
    await page.close();

  } else {
    // ── Link-crawl: navigate to each route in a fresh page context ────────────
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
      const errors  = [];
      page.on('pageerror', e => errors.push(e.message));

      try {
        await page.setViewportSize({ width, height });
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.screenshot({ path: outPath, fullPage: false });
        results.push({ ok: true, url: pageUrl, route, out: outPath, width, height,
                       consoleErrors: errors, a11y: await runAxe(page) });
      } catch (e) {
        results.push({ ok: false, url: pageUrl, route, error: e.message });
      } finally {
        await page.close();
      }
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
