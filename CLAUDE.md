# Global Claude Code Instructions

## Autonomous UI Monitor

A PostToolUse hook (`~/.claude/scripts/ui-check.ps1`) fires after every `Edit` or `Write`
on a frontend file while a dev server is running. When you see a **UI-MONITOR TRIGGER**
in your context, execute ALL steps below immediately and autonomously — no confirmation needed.

### 12-Step Protocol

**Step 1 — Chrome debug port** (avoids collision when multiple checks run simultaneously)
```
$debugPort = <app_port> + 10000   # e.g. 8501 → 18501,  5001 → 15001
Start-Process chrome "--remote-debugging-port=$debugPort --headless=new <url>"
Start-Sleep 3
```

**Step 2 — Lighthouse BEFORE** (chrome-devtools-mcp `lighthouse_audit`)
Record baseline `performance / accessibility / best_practices / seo` scores before any fix.

**Step 3 — Screenshots via PowerShell** (always works — no MCP session dependency)
```
node $env:USERPROFILE\.claude\scripts\pw-e2e-test.js <url> <path>-desktop.png 1280 800 --detect-advanced
node $env:USERPROFILE\.claude\scripts\pw-e2e-test.js <url> <path>-mobile.png  390  844
node $env:USERPROFILE\.claude\scripts\pw-e2e-test.js <url> <path>-tablet.png  768  1024
```
Save to `~/.claude/ui-screenshots/`. Then **Read each .png** with the Read tool to see them.
MCP `browser_take_screenshot` is a useful secondary confirmation if available.

`--detect-advanced` auto-detects CSS animations, WebGL, canvas, GSAP, Framer Motion, Lottie etc. and
auto-enables multi-frame capture, hover states, and scroll capture when relevant features are found.

**Step 4 — Console errors** (chrome-devtools-mcp `list_console_messages`) → flag JS errors/warnings

**Step 5 — Network failures** (chrome-devtools-mcp `list_network_requests`) → flag 4xx/5xx

**Step 6 — Accessibility** (playwright MCP `browser_snapshot` + `a11y.violations` in the pw-e2e-test.js JSON output)

**Step 7 — Visual inspection** — read all 3 screenshots and check:
- Desktop (1280×800): layout breaks, overflow, missing content, wrong colors, misaligned elements
- Mobile (390×844): collapsed nav broken, horizontal scroll, touch targets <44px, text too small
- Tablet (768×1024): mid-size layout adaptation, panels stacking wrong
- All viewports: broken fonts, low contrast, broken images, empty states

Also check these JSON fields from the desktop pw-e2e-test.js output (included automatically):
- `meta.issues[]` — missing title/description/og:image/canonical; flag any entries
- `images.broken` / `images.missingAlt` / `images.oversized` — flag if > 0
- `bundle.warnings[]` — flag JS > 512KB or total transfer > 2MB
- `fonts.failed[]` / `fonts.foitRisk[]` — failed fonts or FOIT (invisible text flash) risk
- `securityHeaders.missing[]` — flag missing CSP, HSTS, or X-Frame-Options on production URLs

**Step 7a — Advanced UI check** (only when desktop JSON output contains an `advanced` field)
- **FPS** (`advanced.fps`): < 55 = flag jank | 30–54 = reduced | < 30 = janky; investigate CSS animation performance
- **Animation frames** (`advanced.frames[]`): Read each PNG — verify animation progresses correctly, no frozen/stuck states
- **Hover states** (`advanced.hover[]`): Read each PNG — verify hover effects render, transitions not broken
- **Scroll positions** (`advanced.scroll[]`): Read each PNG — verify scroll-triggered animations fire, no content missing
- **WebGL / Canvas** (`advanced.detected.hasWebGL` or `hasCanvas`): Prioritise console errors; note render quality requires human review
- **Video** (`advanced.video`): Note the .webm path for external viewing if animation issues need deeper investigation

**Step 8 — Fix** any issues by editing source files

**Step 9 — Lighthouse AFTER** (chrome-devtools-mcp `lighthouse_audit`)
Compare to BEFORE scores. If any score dropped by >2 points → revert the fix and retry.

**Step 10 — Re-screenshot** desktop to confirm fix visually

**Step 11 — Audit log** — append one JSON line to `~/.claude/ui-audit-log.jsonl`:
```json
{"ts":"<ISO>","project":"<name>","port":<n>,"url":"<url>","trigger":"edit","file_edited":"<path>",
 "screenshots":{"desktop":"...","mobile":"...","tablet":"..."},
 "lighthouse_before":{"performance":<n>,"accessibility":<n>,"best_practices":<n>,"seo":<n>},
 "lighthouse_after":{"performance":<n>,"accessibility":<n>,"best_practices":<n>,"seo":<n>},
 "issues":["..."],"fixes":["..."],"duration_s":<n>}
```

**Step 12 — Summary**: 2 sentences — what was found and fixed (or "no issues found").

The `ui-monitor` agent in `~/.claude/agents/ui-monitor.md` has full instructions including
dynamic port discovery, framework detection, and framework-specific checks.

## Known UI Projects

Edit `~/.claude/project-registry.json` to register your projects. The hook discovers live
servers automatically via port scanning — this table is for quick reference only.

| Project directory | Framework | Dev port | Start command |
|---|---|---|---|
| *(add your projects to project-registry.json)* | | | |

Ports and framework fingerprints: `~/.claude/framework-registry.json`
Per-project metadata (path, start command): `~/.claude/project-registry.json`

## MCP Tools for UI Work

- **playwright** MCP: `browser_navigate`, `browser_take_screenshot`, `browser_snapshot`, `browser_click`, `browser_type`
- **chrome-devtools-mcp** MCP: `list_console_messages`, `list_network_requests`, `lighthouse_audit`, `take_screenshot`
- **figma** MCP: `get_screenshot` (frame → PNG), `get_metadata` (layer tree), `get_design_context` (React/Tailwind spec)

These tools load at new-chat start. When they are available, use them. When they are not
(mid-session, headless run), fall back to the PowerShell node scripts — those always work.

### Figma design-vs-live comparison (when Figma MCP is available)

When `figma` MCP tools are loaded AND a Figma frame URL or node ID is known, add this step
between Step 7 (visual inspection) and Step 8 (fix):

```
figma_get_screenshot  →  save as <ssBase>-figma-design.png
Read <ssBase>-figma-design.png   (Figma design)
Read <ssBase>-desktop.png        (live app)
Compare: flag spacing, color, typography, or layout deviations between the two images.
```

If `get_variable_defs` is available (requires Figma Desktop MCP), also:
```
node ~/.claude/scripts/figma-token-check.js <url> --tokens=~/.claude/design-tokens.json
```
Report any CSS custom property mismatches as additional issues.

## Additional UI Tools (CLI — call via PowerShell tool)

- **Stylelint** (global): `stylelint --fix --config ~/.claude/.stylelintrc.json <file>` — auto-fixes CSS/SCSS. Runs automatically in hook on every CSS/SCSS edit.
- **pw-e2e-test.js**: `node ~/.claude/scripts/pw-e2e-test.js <url> <out.png> [width] [height]` — screenshot + axe-core audit + meta/OG, images, bundle, fonts, security headers (always-on). Outputs JSON.
- **pw-e2e-test.js (multi-page)**: `node ~/.claude/scripts/pw-e2e-test.js <url> <prefix> 1280 800 --routes=auto --nav=link-crawl` — screenshots every route/tab; outputs JSON array.
- **pw-e2e-test.js (extended flags)**:
  - `--dark-mode` — extra screenshot + axe-core run with `prefers-color-scheme: dark` emulated → `darkMode.out` + `darkModeA11y`
  - `--css-coverage` — CSS unused-% report per stylesheet (Playwright built-in) → `css`
  - `--har` — save full network HAR file (`<outBase>.har`) → `harPath`
  - `--cwv` — Core Web Vitals: LCP, CLS+sources, FCP, TTFB, TBT via PerformanceObserver (~5-8s extra) → `cwv`
  - `--compare=<baseline.png>` — pixel-diff current screenshot vs baseline (creates baseline on first run; needs `pixelmatch`/`pngjs` — installed) → `diff`
  - `--reduced-motion` — extra screenshot with `prefers-reduced-motion: reduce` (WCAG 2.3.3) → `reducedMotion.out`
  - `--forced-colors` — extra screenshot with Windows High Contrast Mode (`forced-colors: active`) → `forcedColors.out`
  - `--print` — extra screenshot with `media: print` emulated (print stylesheet check) → `print.out`
  - `--no-js` — extra screenshot with JavaScript disabled; flags blank SPAs without SSR → `noJs`
  - `--focus-audit` — tab through up to 20 focusable elements; flag missing focus rings (WCAG 2.4.7) → `focusAudit`
- **Figma baseline export**: `node ~/.claude/scripts/figma-baseline.js --file=<key> --nodes=<id1,id2>` — fetch Figma frames as PNG baselines (requires `FIGMA_ACCESS_TOKEN` in `~/.claude/.env`). Use `--list` to see all frames.
- **Design token check**: `node ~/.claude/scripts/figma-token-check.js <url> --tokens=~/.claude/design-tokens.json` — compare CSS custom properties in live app against a design token JSON file.
- **Snapshot baselines**: `cd ~/.claude/scripts && npm run snapshots:update` / `npm run snapshots`
- **Selenium cross-browser check**: `node ~/.claude/scripts/selenium-xbrowser.js <url> <out-prefix>` — screenshots in **real Chrome, Edge, and Firefox** (not Playwright's patched Chromium); captures per-browser console errors via WebDriver BiDi (works on Firefox unlike CDP); optional `--pdf` (W3C print-to-PDF across all browsers), `--element=.selector` (component-level screenshot), `--browsers=chrome,edge,firefox` (subset).
- **Stagehand** (AI browser fallback): `node ~/.claude/scripts/stagehand-fallback.js <url> "<task>"` — uses first available LLM key from `~/.claude/.env`.
- **Proactive sweep**: `pwsh -File ~/.claude/scripts/sweep-all.ps1` — audits all live projects, writes audit log. No Claude session needed.
- **Audit log**: `pwsh -File ~/.claude/scripts/audit-log.ps1 -Summary` — view history across all projects.

## Figma Setup (Starter plan compatible)

1. **Get a Personal Access Token**: Figma → Settings → Security → Personal access tokens → create with `file_content:read` scope.
2. **Add to `~/.claude/.env`**: uncomment and fill `FIGMA_ACCESS_TOKEN` and `FIGMA_FILE_KEY`.
3. **Figma MCP** (optional, richer): Already registered in `~/.claude.json`. Add your token to the `env.FIGMA_ACCESS_TOKEN` field → restart Claude Code → `figma` MCP tools appear automatically. Tools available on Starter: `get_screenshot`, `get_metadata`, `get_design_context`.
4. **Find frame node IDs**: `node ~/.claude/scripts/figma-baseline.js --file=<key> --list` prints all frames with their IDs.
5. **Design tokens** (Starter compatible): Install the free **Tokens Studio** Figma plugin → export tokens → save as `~/.claude/design-tokens.json` (flat `{ "--css-var": "value" }` or W3C DTCG format). Then `figma-token-check.js` reads it. The Variables REST API (Enterprise only) is NOT used.

> Note: `get_variable_defs` MCP tool requires Figma Desktop app — skip it on Starter/remote setups.

## Adding a New Project

1. Add an entry to `~/.claude/project-registry.json` (name, path, framework, port, start command).
2. If the framework is new, add it to `~/.claude/framework-registry.json`.
3. Add the project to the table above.
4. Optionally add a `CLAUDE.md` in the project directory with project-specific UI notes.

## Auto-fix control

By default Claude fixes UI issues automatically. To change this:

**Turn off globally** (all projects report-only):
```json
{ "autofixDefault": false, "projects": [...] }
```

**Turn off for one project** (overrides global default):
```json
{ "name": "My App", "port": 3000, "autofix": false, ... }
```

When auto-fix is **off**, Claude lists issues and asks "Would you like me to fix any of these?" instead of editing files. If there are more than 15 issues it writes the full list to the audit log and gives you the command to view it.

## API key errors and failures

When any script output contains `"ok": false`, **stop and surface the issue to the user immediately** — never silently skip or continue as if the call succeeded.

Use the `action` field in the JSON for the exact fix. Common patterns:

| `error` contains | What to tell the user |
|---|---|
| "not set", "No LLM key", "FIGMA_ACCESS_TOKEN" | "The `<KEY>` is missing. Add it to `~/.claude/.env`: `KEY=your_value`" — show the `envFile` path from the JSON |
| "401", "invalid", "expired", "unauthorized" | "Your API key is set but invalid or expired. Regenerate it at [provider] and update `~/.claude/.env`" |
| "403", "forbidden", "scope" | "Permission denied — your token is missing a required scope. Check the token settings at the provider." |
| "429", "rate limit", "too many requests" | "Rate limited. Wait ~30 seconds and I'll retry." — then retry once automatically |
| "ENOTFOUND", "ECONNREFUSED", "Network error", "fetch failed" | "Cannot reach the API. Check your internet connection." |
| "404", "not found" (Figma) | "Figma file not found. Verify the `--file=<key>` matches your Figma URL." |

After surfacing the error, ask: **"Would you like to add/fix the key now, or skip this step?"** — do not proceed without an answer.

## When There Is No Dev Server Running

Continue with the code fix and note in one line that no live server was found to verify against.
