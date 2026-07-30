// selenium-xbrowser.js — Real cross-browser health check using Selenium WebDriver.
//
// Takes a URL and screenshots it in real Chrome, Edge, and Firefox (whichever are
// installed), capturing per-browser console errors via WebDriver BiDi.  Complements
// pw-e2e-test.js (Playwright/Chromium) by exercising the actual browsers users have.
//
// Usage:
//   node selenium-xbrowser.js <url> [out-prefix] [--pdf] [--element=SELECTOR]
//
// Flags:
//   --pdf              Print page to PDF via W3C printPage() — tests CSS print layout
//   --element=SEL      Also screenshot the first element matching CSS selector SEL
//   --width=N          Viewport width  (default 1280)
//   --height=N         Viewport height (default 800)
//   --browsers=a,b,c   Comma-separated subset: chrome,edge,firefox  (default: all three)
//
// Output:
//   stdout → JSON array  [{ browser, ok, out, width, height, consoleErrors,
//                           networkErrors, [elementOut], [pdfOut] }, ...]
//   ok:false + skipped:true → browser not installed (non-fatal, caller may ignore)
//
// Driver management:
//   Selenium Manager (bundled in selenium-webdriver 4.27+) auto-downloads
//   chromedriver / msedgedriver / geckodriver — no PATH setup required.
//   Browsers themselves must be present: Chrome and Edge ship with Windows 11;
//   Firefox is optional and silently skipped when absent.
//
// BiDi console capture:
//   WebDriver BiDi LogInspector works across Chrome, Edge, and Firefox — unlike
//   CDP (chrome-devtools-mcp) which is Chromium-only.  This script captures console
//   errors and JS exceptions from all three real browsers.
//
// Print-to-PDF:
//   W3C printPage() works across Chrome, Edge, and Firefox.  Playwright's page.pdf()
//   is Chromium-only.  Use --pdf to compare print layouts across browsers.

'use strict';

const { Builder, Browser, By } = require('selenium-webdriver');
const chrome  = require('selenium-webdriver/chrome');
const firefox = require('selenium-webdriver/firefox');
const edge    = require('selenium-webdriver/edge');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Error helper (consistent with other scripts) ──────────────────────────────
const envFile = path.join(os.homedir(), '.claude', '.env');
function apiError(error, action) {
  process.stdout.write(JSON.stringify({ ok: false, error, action, envFile }) + '\n');
  process.exit(1);
}

// ── Argument parsing ──────────────────────────────────────────────────────────
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags      = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const eq = a.indexOf('=');
      return eq === -1 ? [a.slice(2), 'true'] : [a.slice(2, eq), a.slice(eq + 1)];
    })
);

const [urlArg, outPrefix = 'xbrowser'] = positional;
const width      = parseInt(flags.width  || '1280', 10);
const height     = parseInt(flags.height || '800',  10);
const wantPdf    = flags.pdf     === 'true';
const elementSel = flags.element || null;
const wantBrowsers = flags.browsers
  ? flags.browsers.split(',').map(b => b.trim().toLowerCase())
  : ['chrome', 'edge', 'firefox'];

if (!urlArg) {
  apiError(
    'URL argument required',
    'Usage: node selenium-xbrowser.js <url> [out-prefix] [--pdf] [--element=.selector] [--browsers=chrome,edge,firefox]'
  );
}

// ── Browser build functions ───────────────────────────────────────────────────
// Each returns a built WebDriver promise.  enableBidi() is called on every browser
// so that the BiDi LogInspector (console error capture) works across all three.

const BROWSER_CONFIGS = [
  {
    name: 'chrome',
    build: () => {
      const opts = new chrome.Options()
        .addArguments(
          '--headless=new',             // new headless: Chrome 112+
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          `--window-size=${width},${height}`
        )
        .enableBidi();
      return new Builder().forBrowser(Browser.CHROME).setChromeOptions(opts).build();
    }
  },
  {
    name: 'edge',
    build: () => {
      const opts = new edge.Options()
        .addArguments(
          '--headless=new',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          `--window-size=${width},${height}`
        )
        .enableBidi();
      return new Builder().forBrowser(Browser.EDGE).setEdgeOptions(opts).build();
    }
  },
  {
    name: 'firefox',
    build: () => {
      const opts = new firefox.Options()
        .addArguments('-headless')        // single dash: Firefox CLI flag
        .windowSize({ width, height })
        .enableBidi();
      return new Builder().forBrowser(Browser.FIREFOX).setFirefoxOptions(opts).build();
    }
  }
];

// ── Per-browser check ─────────────────────────────────────────────────────────
async function checkBrowser({ name, build }) {
  let driver    = null;
  let inspector = null;
  const consoleErrors = [];

  try {
    driver = await build();

    // BiDi LogInspector — captures console.error/warn + uncaught JS exceptions.
    // Works on Chrome, Edge, and Firefox.  Falls back silently if BiDi is unavailable
    // (e.g., older browser version or driver mismatch).
    try {
      const LogInspector = require('selenium-webdriver/bidi/logInspector');
      inspector = await LogInspector(driver);

      await inspector.onConsoleEntry(entry => {
        if (entry.level === 'error' || entry.level === 'warning') {
          consoleErrors.push({ level: entry.level, text: entry.text || entry.message || '' });
        }
      });

      await inspector.onJavascriptException(entry => {
        consoleErrors.push({
          level: 'error',
          text:  entry.text || String(entry),
          type:  'js-exception',
          ...(entry.stackTrace?.callFrames?.[0] && {
            source: `${entry.stackTrace.callFrames[0].url}:${entry.stackTrace.callFrames[0].lineNumber}`
          })
        });
      });
    } catch (_biDiErr) {
      // BiDi not available — console errors won't be captured for this browser
    }

    // Navigate and wait for async resources
    await driver.get(urlArg);
    await driver.sleep(1500);

    // Full-page screenshot
    const ssOut = path.resolve(`${outPrefix}-${name}.png`);
    fs.writeFileSync(ssOut, Buffer.from(await driver.takeScreenshot(), 'base64'));

    // Element-level screenshot (--element=SELECTOR)
    // Captures just the matching component — useful for visual component comparison
    let elementOut = null;
    if (elementSel) {
      try {
        const el = await driver.findElement(By.css(elementSel));
        const px = await el.takeScreenshot(true);   // true = scroll into view
        elementOut = path.resolve(`${outPrefix}-${name}-element.png`);
        fs.writeFileSync(elementOut, Buffer.from(px, 'base64'));
      } catch (_elErr) { /* element absent or not screenshottable */ }
    }

    // Network 4xx/5xx via Performance Resource Timing.
    // responseStatus available in Chrome 109+, Firefox 128+, Edge 109+.
    let networkErrors = [];
    try {
      networkErrors = await driver.executeScript(
        `return (window.performance?.getEntriesByType?.('resource') || [])
           .filter(e => typeof e.responseStatus === 'number' && e.responseStatus >= 400)
           .map(e => ({ url: e.name, status: e.responseStatus, type: e.initiatorType }));`
      );
    } catch (_perfErr) { /* Performance API unavailable in this browser/context */ }

    // Print to PDF via W3C printPage() — tests CSS print layout.
    // Works across Chrome, Edge, and Firefox; unlike Playwright page.pdf() (Chromium only).
    let pdfOut = null;
    if (wantPdf) {
      try {
        const base64Pdf = await driver.printPage({ orientation: 'portrait', background: false });
        pdfOut = path.resolve(`${outPrefix}-${name}-print.pdf`);
        fs.writeFileSync(pdfOut, Buffer.from(base64Pdf, 'base64'));
      } catch (_pdfErr) { /* printPage not supported in this mode */ }
    }

    if (inspector) { try { await inspector.close(); } catch {} }
    await driver.quit();

    return {
      browser: name,
      ok:      true,
      out:     ssOut,
      width,
      height,
      consoleErrors,
      networkErrors,
      ...(elementOut && { elementOut }),
      ...(pdfOut     && { pdfOut })
    };

  } catch (err) {
    if (inspector) { try { await inspector.close(); } catch {} }
    if (driver)    { try { await driver.quit();     } catch {} }

    const msg = String(err.message || err);
    // Detect "browser not installed" vs real errors so callers skip gracefully
    const notInstalled = /no such file|cannot find|browsernotfounderror|executable|unable to locate|session not created|not found/i.test(msg);
    return {
      browser: name,
      ok:      false,
      skipped: notInstalled,
      error:   notInstalled
        ? `${name} browser not installed or not on PATH — install it or skip with --browsers=`
        : msg
    };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const active  = BROWSER_CONFIGS.filter(cfg => wantBrowsers.includes(cfg.name));
  const results = [];
  for (const cfg of active) {
    results.push(await checkBrowser(cfg));
  }
  process.stdout.write(JSON.stringify(results) + '\n');
})().catch(err => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err.message || err) }) + '\n');
  process.exit(1);
});
