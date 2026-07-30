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
Record baseline `performance / accessibility` scores before any fix.

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
- `meta.issues[]` — viewport blocks zoom (WCAG 1.4.4), missing `<html lang>` (WCAG 3.1.1)
- `meta.lang` / `meta.charset` / `meta.dir` — HTML language, character set, text direction
- `images.broken` / `images.missingAlt` / `images.oversized` — flag if > 0
- `images.lazyAboveFold` — above-fold images marked `loading=lazy` (hurts LCP); flag if > 0
- `images.missingFetchPriority` — large above-fold images without `fetchpriority="high"`; flag if > 0
- `images.missingSrcset` — images > 200px wide without `srcset` (no responsive images); flag if > 0
- `images.missingHeight` — `<img>` elements > 100px wide without a `height` attribute (causes layout shift); flag if > 0
- `scripts.renderBlocking` — third-party scripts that delay page display; flag if > 0
- `touchTargets.warnings[]` — interactive elements below 24×24px (WCAG 2.5.8); flag if > 0
- `headings.h1Count` / `headings.skips[]` — missing/multiple h1, heading level skips (h2→h4 etc.)
- `domA11y.brokenAriaRefs[]` — `aria-labelledby/describedby/controls` pointing at non-existent IDs
- `domA11y.unlabeledInputs` — form inputs with no accessible label (WCAG 1.3.1); flag if > 0
- `domA11y.iconOnlyButtons` — buttons containing only icons with no `aria-label`/text/title; flag if > 0
- `domA11y.titleOnlyInteractive` — interactive elements using `title` as sole label (invisible on touch); flag if > 0
- `layout.hasHorizontalScroll` / `layout.wideElements[]` — viewport overflow (mobile breakage)
- `layout.hiddenOverflowElements[]` — elements where `overflow:hidden` is clipping content; flag if > 0
- `layout.stickyFixed[]` — sticky/fixed elements at `top:0`/`bottom:0` ≥ 40px tall; may hide scrolled-to content; flag if height > 80px
- `fonts.failed[]` / `fonts.foitRisk[]` — failed fonts or FOIT (invisible text flash) risk
- `typography.smallText[]` — elements with font-size < 16px on mobile (triggers iOS auto-zoom); flag if > 0
- `typography.tightLineHeight[]` — elements with line-height < 1.2 (WCAG 1.4.12); flag if > 0
- `typography.truncated[]` — elements silently clipping text with `text-overflow:ellipsis`; flag if > 0
- `interactiveStates.warnings[]` — missing `:hover`/`:focus`/`:disabled` CSS rules; flag if not empty
- `interactiveStates.removedFocusOutline[]` — `:focus { outline:0/none }` without `:focus-visible` replacement (WCAG 2.4.7); flag if > 0
- `cursor.missingPointer` — interactive elements without `cursor:pointer`; flag if > 0
- `cursor.pointerEventsNone` — visible interactive elements with `pointer-events:none` (look clickable, aren't); flag if > 0
- `viewportUnits.unsafeVhCount` — CSS rules using `height:100vh` (clipped on mobile); flag if > 0
- `mediaQuerySupport.hasDarkModeCSS` / `.hasReducedMotionCSS` — CSS media query presence; flag if false
- `mediaQuerySupport.hasResponsiveBreakpoints` / `.breakpointCount` — any `@media (max/min-width)` present; flag if false
- `formUX.missingAutocomplete[]` — email/password/tel inputs missing `autocomplete`; flag if > 0
- `animationDurations.longTransitions[]` — transitions > 300ms (sluggish hover/focus); flag if > 0
- `animationDurations.longAnimations[]` — animations > 1s (feels slow); flag if > 0
- `animationDurations.infiniteAnimations[]` — infinite animations without pause mechanism (WCAG 2.2.2); flag if > 0
- `stacking.veryHighZIndex[]` — elements with z-index > 9999 (stacking anomalies); flag if > 0
- `svgA11y.missingRole` / `.missingTitle` — informative SVGs missing `role="img"` or `<title>`; flag if > 0
- `mediaA11y.autoplayWithoutMuted[]` — `<video autoplay>` without `muted` (WCAG 1.4.2); flag if > 0
- `mediaA11y.missingCaptions[]` — `<video>` without a `<track kind="captions">` (WCAG 1.2.2); flag if > 0
- `colorOnly.colorOnlyLinks[]` — inline links distinguished from body text only by color (WCAG 1.4.1); flag if > 0
- `textSelectability.count` — text blocks with `user-select:none` that users can't copy; flag if > 0
- `bundle.jsKB` / `bundle.cssKB` / `bundle.totalTransferKB` — resource sizes for jank diagnosis
- `landmarks.hasMain` / `.hasNav` / `.hasBanner` / `.hasContentinfo` — ARIA landmark presence (WCAG 2.4.1); flag any false
- `landmarks.warnings[]` — missing landmark regions; flag if not empty
- `tableA11y.issues[]` — tables missing <th>, <caption>, or scope attribute (WCAG 1.3.1); flag if > 0
- `dialogs.issues[]` — visible dialogs missing aria-modal or accessible name (WCAG 4.1.2); flag if > 0
- `widgets.toggleButtonsMissingExpanded` — toggle buttons with aria-controls but no aria-expanded (WCAG 4.1.2); flag if > 0
- `widgets.tabIssues` — [role="tab"] elements missing tablist parent or aria-selected; flag if > 0
- `widgets.carouselCount` — carousels detected; check `.details.carouselIssues[]` for missing prev/next buttons
- `security.unsafeTargetBlank` — links with target="_blank" missing rel="noopener" (tab-napping); flag if > 0
- `security.mixedContent` — elements loading http:// on an https page (browser blocks); flag if > 0
- `statusMessages.missingAriaLive` — toast/alert/notification containers without aria-live (WCAG 4.1.3); flag if > 0
- `domSize.totalNodes` — total DOM nodes; flag if > 1500 (Lighthouse threshold)
- `preconnect.missingPreconnect` — third-party origins without preconnect/dns-prefetch hints; flag if > 0
- `rtl.issues[]` — physical CSS directional properties on RTL pages (margin-left, float, text-align); flag if > 0
- `meta.metaDescription.missing` — page missing <meta name="description"> (SEO); flag if true
- `meta.openGraphMissing[]` — missing og:title / og:description / og:image tags (social sharing); flag if not empty
- `meta.noindex` — page is noindex (search engine excluded); flag if true
- `meta.hasFavicon` — page has a favicon link; flag if false
- `domA11y.duplicateIds[]` — duplicate id attributes breaking ARIA references (WCAG 4.1.1); flag if > 0
- `domA11y.genericLinks` — links whose text is "click here", "read more", etc. (WCAG 2.4.4); flag if > 0
- `domA11y.ariaHiddenInteractive` — interactive elements hidden from AT with aria-hidden (WCAG 4.1.2); flag if > 0
- `domA11y.hasSkipLink` — page has a skip-navigation link (WCAG 2.4.1); flag if false
- `domA11y.labelInNameViolations` — visible label text not in accessible name (WCAG 2.5.3); flag if > 0
- `domA11y.iframesMissingTitle` — <iframe> elements without a title attribute (WCAG 4.1.2); flag if > 0
- `formUX.placeholderOnlyLabel` — inputs using placeholder as sole label (disappears on focus); flag if > 0
- `formUX.missingFieldset` — radio/checkbox groups not wrapped in <fieldset><legend> (WCAG 1.3.1); flag if > 0
- `typography.longLines` — text blocks estimated > 80 chars/line (WCAG 1.4.8 readability); flag if > 0
- `typography.allCapsBlocks` — text-transform:uppercase on blocks > 30 chars (readability); flag if > 0
- `layout.missingSafeArea` — fixed-bottom elements without env(safe-area-inset-bottom) (iPhone notch); flag if > 0
- `layout.consecutiveBr` — consecutive <br><br> used for spacing instead of CSS margins; flag if > 0
- `fonts.missingFontPreload` — @font-face custom fonts without matching <link rel="preload"> hint; flag if > 0
- `cwv.inp` / `cwv.ratings.inp` — Interaction to Next Paint (new CWV replacing FID); flag if > 200ms
- `scripts.firstPartyRenderBlocking` — first-party render-blocking scripts (defer/async missing); flag if > 0
- `scripts.stylesheetInBody` — `<link rel="stylesheet">` inside `<body>` causing FOUC and blocking LCP; flag if > 0
- `images.iframesWithoutLazy` — third-party/below-fold iframes without `loading="lazy"` (blocks main thread); flag if > 0
- `meta.missingTitle` — empty or missing `<title>` element (WCAG 2.4.2); flag if true
- `meta.orientationLock` — CSS hides content in one orientation (WCAG 1.3.4); flag if true
- `mediaQuerySupport.hasPrefersContrastCSS` — CSS media query `prefers-contrast` present; flag if false
- `domA11y.positiveTabindex` — elements with `tabindex > 0` disrupting focus order (WCAG 2.4.3); flag if > 0
- `domA11y.ariaInvalidMissingMessage` — `aria-invalid="true"` without linked error message (WCAG 3.3.1); flag if > 0
- `domA11y.missingAriaCurrent` — active nav link missing `aria-current="page"` (WCAG 2.4.8); flag if true
- `domA11y.rolePresentationFocusable` — `role="none/presentation"` on natively focusable elements (WCAG 4.1.2); flag if > 0
- `domA11y.menuRoleMisuse` — `role="menu"` used for navigation instead of actions (WCAG 4.1.2); flag if > 0
- `widgets.comboboxIssues` — `[role="combobox"]` missing aria-expanded or aria-controls→listbox (WCAG 4.1.2); flag if > 0
- `formUX.passwordAutocompleteOff` — password inputs with `autocomplete="off"` blocking password managers (WCAG 3.3.8); flag if > 0
- `formUX.missingInputMode` — numeric/tel-like text inputs missing `inputmode` (wrong soft keyboard on mobile); flag if > 0
- `layout.willChangeCount` / `layout.willChangeAll` — `will-change` on > 4 elements wastes VRAM; `will-change:all` is always wrong
- `layout.contentVisibilityMissingIntrinsic` — `content-visibility:auto` without `contain-intrinsic-size` causes CLS; flag if > 0

**Step 7a — Advanced UI check** (only when desktop JSON output contains an `advanced` field)
- **FPS** (`advanced.fps`): < 55 = flag jank | 30–54 = reduced | < 30 = janky; investigate CSS animation performance
- **Animation frames** (`advanced.frames[]`): Read each PNG — verify animation progresses correctly, no frozen/stuck states
- **Hover states** (`advanced.hover[]`): Read each PNG — verify hover effects render, transitions not broken
- **Scroll positions** (`advanced.scroll[]`): Read each PNG — verify scroll-triggered animations fire, no content missing
- **WebGL / Canvas** (`advanced.detected.hasWebGL` or `hasCanvas`): Prioritise console errors; note render quality requires human review
- **Video** (`advanced.video`): Note the .webm path for external viewing if animation issues need deeper investigation

**Step 8 — Fix** any issues by editing source files

**Step 9 — Lighthouse AFTER** (chrome-devtools-mcp `lighthouse_audit`)
Compare `performance / accessibility` scores to BEFORE. If either dropped by >2 points → revert the fix and retry.

**Step 10 — Re-screenshot** desktop to confirm fix visually

**Step 11 — Audit log** — append one JSON line to `~/.claude/ui-audit-log.jsonl`:
```json
{"ts":"<ISO>","project":"<name>","port":<n>,"url":"<url>","trigger":"edit","file_edited":"<path>",
 "screenshots":{"desktop":"...","mobile":"...","tablet":"..."},
 "lighthouse_before":{"performance":<n>,"accessibility":<n>},
 "lighthouse_after":{"performance":<n>,"accessibility":<n>},
 "issues":["..."],"fixes":["..."],"duration_s":<n>}
```

**Step 12 — Summary**: 2 sentences — what was found and fixed (or "no issues found").

The `ui-monitor` agent in `~/.claude/agents/ui-monitor.md` has full instructions including
dynamic port discovery, framework detection, and framework-specific checks.

## Known UI Projects

| Project directory | Framework | Dev port | Start command |
|---|---|---|---|
| `fullstack-demo` | Angular 17 + GraphQL | 4200 | `ng serve` (in frontend/) |
| `codex proj 1` (Scribbly) | SvelteKit 2 + TipTap | 5173 | `npm run dev` |
| `SEO Audit` | Streamlit | 8501 | `streamlit run app.py` |
| `Sonnet Comp` (NexusFlow) | Flask dashboard | 5001 | `python web_dashboard.py` |
| `Claude Code Comp` (AgentPulse) | Flask dashboard | 8090 | `python web_dashboard.py` |

Ports and framework fingerprints: `~/.claude/framework-registry.json`
Per-project metadata (path, start command): `~/.claude/project-registry.json`

## MCP Tools for UI Work

- **playwright** MCP: `browser_navigate`, `browser_take_screenshot`, `browser_snapshot`, `browser_click`, `browser_type`
- **chrome-devtools-mcp** MCP: `list_console_messages`, `list_network_requests`, `lighthouse_audit`, `take_screenshot`
- **figma** MCP: `get_screenshot` (frame → PNG), `get_metadata` (layer tree), `get_variable_defs` (design tokens, Desktop only), `get_design_context` (React/Tailwind spec)

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
- **pw-e2e-test.js**: `node ~/.claude/scripts/pw-e2e-test.js <url> <out.png> [width] [height]` — screenshot + axe-core + full UI/UX audit (always-on). Outputs JSON.
- **pw-e2e-test.js (multi-page)**: `node ~/.claude/scripts/pw-e2e-test.js <url> <prefix> 1280 800 --routes=auto --nav=link-crawl` — screenshots every route/tab; outputs JSON array.
- **pw-e2e-test.js (extended flags)**:
  - `--dark-mode` — extra screenshot + axe-core run with `prefers-color-scheme: dark` emulated → `darkMode.out` + `darkModeA11y`
  - `--cwv` — Core Web Vitals: LCP, CLS+sources, FCP, TTFB, TBT via PerformanceObserver (~5-8s extra) → `cwv`
  - `--compare=<baseline.png>` — pixel-diff current screenshot vs baseline (creates baseline on first run; needs `pixelmatch`/`pngjs` — installed) → `diff`
  - `--reduced-motion` — extra screenshot with `prefers-reduced-motion: reduce` (WCAG 2.3.3) → `reducedMotion.out`
  - `--forced-colors` — extra screenshot with Windows High Contrast Mode (`forced-colors: active`) → `forcedColors.out`
  - `--print` — extra screenshot with `media: print` emulated (print stylesheet check) → `print.out`
  - `--no-js` — extra screenshot with JavaScript disabled; flags blank SPAs without SSR → `noJs`
  - `--focus-audit` — tab through up to 20 focusable elements; flag missing focus rings (WCAG 2.4.7) → `focusAudit`
  - `--link-check` — HEAD-check internal links (cap 20); flag broken ones → `linkCheck`
  - `--reflow` — 320px viewport screenshot + layout check (WCAG 1.4.10 Reflow) → `reflow`
  - `--text-spacing` — inject WCAG 1.4.12 overrides; screenshot + detect clipped content → `textSpacing`
  - `--paint-complexity` — detect expensive paint properties (filter/backdrop-filter/multi-shadow) on large elements → `paintComplexity`
  - `--state-contrast` — WCAG 1.4.3 contrast check in default + hover state for interactive elements → `stateContrast`
  - `--required-fields` — required form fields missing `aria-required="true"` → `requiredFields`
  - `--animation-fill` — animations missing `fill-mode:forwards/both` (element snaps back after animation) → `animationDurations.missingFillMode`
  - `--empty-states` — stuck loading spinners + empty list/grid containers with no empty-state UI → `emptyStates`
  - `--text-contrast` — WCAG 1.4.3 contrast check for body text, headings, labels, list items (samples up to 120 elements) → `bodyTextContrast`
  - `--placeholder-contrast` — contrast check for CSS ::placeholder text against input background (WCAG 1.4.3) → `placeholderContrast`
  - `--non-text-contrast` — WCAG 1.4.11 contrast check for form input borders against their parent background → `nonTextContrast`
  - `--pwa` — PWA readiness: checks for <link rel="manifest"> and registered service worker → `pwa`
  - `--sri` — Subresource Integrity check: flags external <script src> and <link rel="stylesheet"> missing integrity attribute → `sri`
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
