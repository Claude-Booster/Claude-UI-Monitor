// figma-token-check.js — Compare design tokens against a live app's computed CSS properties.
//
// Usage:
//   node figma-token-check.js <url> [--tokens=<path-to-tokens.json>] [--selector=:root]
//
// Tokens file: W3C DTCG format (Tokens Studio export) OR a flat key→value map.
//   Flat:    { "--color-primary": "#0057ff", "--spacing-md": "16px" }
//   DTCG:    { "color": { "primary": { "$value": "#0057ff", "$type": "color" } } }
//
// The script navigates to <url>, reads all CSS custom properties on <selector>,
// then reports mismatches between the token file and the live computed values.
//
// Output: JSON  { ok, url, selector, checked, mismatches: [{ token, expected, actual }], missing: [] }

const { chromium } = require('playwright');
const fs           = require('path');
const fss          = require('fs');
const path         = require('path');

// Load .env
const envPath = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', '.env');
if (fss.existsSync(envPath)) {
  fss.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  });
}

// ── Args ─────────────────────────────────────────────────────────────────────
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags      = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const eq = a.indexOf('=');
      return eq === -1 ? [a.slice(2), 'true'] : [a.slice(2, eq), a.slice(eq + 1)];
    })
);

const [url = ''] = positional;
const tokensPath  = flags['tokens'] || path.join(
  process.env.USERPROFILE || process.env.HOME, '.claude', 'design-tokens.json'
);
const selector    = flags['selector'] || ':root';

if (!url) {
  process.stderr.write('Usage: node figma-token-check.js <url> [--tokens=<path>] [--selector=:root]\n');
  process.exit(1);
}

// ── Token file parser — handles both flat and W3C DTCG nested format ─────────
function parseTokens(raw) {
  const flat = {};

  function walk(obj, prefix) {
    for (const [key, val] of Object.entries(obj)) {
      if (val && typeof val === 'object' && '$value' in val) {
        // DTCG leaf: { "$value": "...", "$type": "..." }
        const cssVar = '--' + (prefix ? prefix + '-' : '') + key;
        flat[cssVar.replace(/\./g, '-')] = String(val.$value);
      } else if (val && typeof val === 'object' && !key.startsWith('$')) {
        walk(val, prefix ? `${prefix}-${key}` : key);
      } else if (typeof val === 'string' || typeof val === 'number') {
        // Flat format: { "--color-primary": "#0057ff" }
        const cssVar = key.startsWith('--') ? key : '--' + key;
        flat[cssVar] = String(val);
      }
    }
  }

  walk(raw, '');
  return flat;
}

// Normalize a CSS value for comparison (trim, lowercase hex, strip extra spaces)
function normalise(v) {
  return (v || '').trim()
    .replace(/\s+/g, ' ')
    .replace(/#([0-9a-fA-F]{6})/g, s => s.toLowerCase())
    .replace(/#([0-9a-fA-F]{3})\b/g, s => s.toLowerCase());
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  // Load tokens
  if (!fss.existsSync(tokensPath)) {
    process.stdout.write(JSON.stringify({
      ok: false, url, error: `Tokens file not found: ${tokensPath}. ` +
        'Export from Tokens Studio (Figma plugin) or create a flat JSON map of CSS variable → value.',
    }) + '\n');
    process.exit(0);
  }
  const tokensRaw = JSON.parse(fss.readFileSync(tokensPath, 'utf8'));
  const expected  = parseTokens(tokensRaw);
  const tokenKeys = Object.keys(expected);

  if (tokenKeys.length === 0) {
    process.stdout.write(JSON.stringify({ ok: false, url, error: 'No tokens parsed from file' }) + '\n');
    process.exit(0);
  }

  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Read all CSS custom properties from the selector element
  const computed = await page.evaluate(sel => {
    const el = document.querySelector(sel) || document.documentElement;
    const styles = getComputedStyle(el);
    const result = {};
    for (const prop of styles) {
      if (prop.startsWith('--')) {
        result[prop] = styles.getPropertyValue(prop).trim();
      }
    }
    return result;
  }, selector);

  await browser.close();

  const mismatches = [];
  const missing    = [];

  for (const [token, exp] of Object.entries(expected)) {
    if (!(token in computed)) {
      missing.push({ token, expected: exp });
    } else if (normalise(computed[token]) !== normalise(exp)) {
      mismatches.push({ token, expected: exp, actual: computed[token] });
    }
  }

  const result = {
    ok:         mismatches.length === 0 && missing.length === 0,
    url,
    selector,
    checked:    tokenKeys.length,
    liveVars:   Object.keys(computed).length,
    mismatches,
    missing,
    summary:    mismatches.length === 0 && missing.length === 0
      ? `All ${tokenKeys.length} tokens match`
      : `${mismatches.length} mismatch(es), ${missing.length} missing from live app`,
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 2); // exit 2 = token drift found (not a script error)
})().catch(e => {
  process.stdout.write(JSON.stringify({ ok: false, url, error: e.message }) + '\n');
  process.exit(1);
});
