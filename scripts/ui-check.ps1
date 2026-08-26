#!/usr/bin/env pwsh
# PostToolUse hook — fires after Edit/Write, triggers autonomous UI check when dev server is live.

param()
$ErrorActionPreference = 'Stop'   # catch unexpected errors explicitly; targeted silencing below

# ── Read the PostToolUse event from stdin ─────────────────────────────────────
try {
    $raw = [Console]::In.ReadToEnd()
    if (-not $raw) { exit 0 }
    $ev = $raw | ConvertFrom-Json -ErrorAction Stop
} catch { exit 0 }

$filePath = $ev.tool_input.file_path
if (-not $filePath) { exit 0 }

# ── Filter: only UI-bearing file extensions ───────────────────────────────────
$uiExts = @(
    '.html', '.htm', '.css', '.scss', '.sass', '.less',
    '.svelte', '.vue', '.tsx', '.jsx',
    '.ts', '.js', '.py'
)
$ext = [IO.Path]::GetExtension($filePath).ToLower()
if ($ext -notin $uiExts) { exit 0 }

# Skip test/spec/config/build/backend-only files
if ($filePath -match '\.(spec|test|config|setup|seed|migration)\.(ts|js|py)$') { exit 0 }
if ($filePath -match '[\\/](node_modules|dist|build|__pycache__|\.git|coverage|\.nyc_output)[\\/]') { exit 0 }
# Skip obvious server-side TS/JS (routes, controllers, models, etc.)
if ($ext -in @('.ts', '.js') -and
    $filePath -match '[\\/](routes|controllers|resolvers|models|migrations|seeds|services|middleware|api)[\\/]') { exit 0 }
# Skip Python non-UI files
if ($ext -eq '.py' -and $filePath -notmatch '(app|dashboard|web|ui|streamlit|server|main|demo|serve)\.py$') { exit 0 }

# ── Auto-fix CSS/SCSS with Stylelint (runs before screenshot so fixes are visible) ───
if ($ext -in @('.css', '.scss', '.sass', '.less')) {
    $stylelintConfig = "$env:USERPROFILE\.claude\.stylelintrc.json"
    if ((Get-Command stylelint -ErrorAction SilentlyContinue) -and (Test-Path $stylelintConfig)) {
        stylelint --fix --config $stylelintConfig $filePath 2>$null
    }
}

# ── Playwright pre-flight: browser binaries + weekly package sync ─────────────
$scriptsDir = $PSScriptRoot   # same directory as ui-check.ps1
# Ensure chromium binaries exist (installs only when absent — fast no-op otherwise)
if (-not (Test-Path "$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-*\chrome-headless-shell-win64\chrome-headless-shell.exe")) {
    if (Test-Path $scriptsDir) {
        Push-Location $scriptsDir
        try { npx playwright install chromium 2>&1 | Out-Null } catch {}
        Pop-Location
    }
}
# Weekly drift check: keeps scripts/node_modules in sync with the latest npx/MCP version
# Skipped when UI_MONITOR_SKIP_SYNC=1 (set by test suite to prevent npm calls during testing)
if (-not $env:UI_MONITOR_SKIP_SYNC) {
    $pwSentinel = "$env:USERPROFILE\.claude\.pw-drift-check"
    $needsSync = -not (Test-Path $pwSentinel) -or
                 ((Get-Date) - (Get-Item $pwSentinel -ErrorAction SilentlyContinue).LastWriteTime).TotalDays -gt 7
    if ($needsSync -and (Test-Path $scriptsDir)) {
        Push-Location $scriptsDir
        try {
            npm update playwright @playwright/test 2>&1 | Out-Null
            npx playwright install chromium 2>&1 | Out-Null
        } catch {}
        Pop-Location
        Set-Content $pwSentinel (Get-Date -Format 'o') -ErrorAction SilentlyContinue
    }
}

# ── Detect running dev server ─────────────────────────────────────────────────
# Port list is loaded from framework-registry.json so adding a new framework
# there is the only change needed — no edits required here.
$registryPath = "$env:USERPROFILE\.claude\framework-registry.json"
$serverMap = @()
if (Test-Path $registryPath) {
    try {
        $reg = Get-Content $registryPath -Raw | ConvertFrom-Json -ErrorAction Stop
        $seenPorts = @{}
        foreach ($fw in $reg.frameworks) {
            foreach ($port in $fw.ports) {
                $p = [int]$port
                if (-not $seenPorts.ContainsKey($p)) {
                    $seenPorts[$p] = $true
                    $serverMap += @{ Port = $p; Label = $fw.name }
                }
            }
        }
    } catch {}
}
# Fallback: minimal list if registry is missing or unreadable
if ($serverMap.Count -eq 0) {
    $serverMap = @(
        @{ Port = 4200; Label = 'Angular'   },
        @{ Port = 5173; Label = 'Vite'      },
        @{ Port = 3000; Label = 'React'     },
        @{ Port = 8501; Label = 'Streamlit' },
        @{ Port = 5000; Label = 'Flask'     },
        @{ Port = 8000; Label = 'Django'    },
        @{ Port = 8080; Label = 'HTTP'      }
    )
}

# Probe each registry port; build a list of live ports for fingerprint disambiguation.
# IMPORTANT: only call EndConnect when WaitOne returns true — calling it on a still-pending
# async operation blocks until the OS-level TCP timeout (~20–30 s), not the 200 ms we want.
$livePorts = @()
foreach ($s in $serverMap) {
    $tcp = [Net.Sockets.TcpClient]::new()
    try {
        $ar        = $tcp.BeginConnect('127.0.0.1', $s.Port, $null, $null)
        $completed = $ar.AsyncWaitHandle.WaitOne(200)
        if ($completed) {
            try { [void]$tcp.EndConnect($ar) } catch {}   # EndConnect only when op finished
            if ($tcp.Connected) { $livePorts += $s }
        }
        # Timeout path: skip EndConnect — Dispose() below will abort the pending op cleanly
    } catch {}
    finally { $tcp.Dispose() }
}

# Disambiguate shared ports via HTTP fingerprints when multiple frameworks claim the same port
$found = $null
if ($livePorts.Count -gt 0 -and (Test-Path $registryPath)) {
    $reg = try { Get-Content $registryPath -Raw | ConvertFrom-Json -ErrorAction Stop } catch { $null }
    foreach ($s in $livePorts) {
        if ($found) { break }
        # Collect all frameworks that declare this port
        $candidates = if ($reg) {
            $reg.frameworks | Where-Object { $_.ports -contains $s.Port }
        } else { $null }

        if ($candidates -and ($candidates | Measure-Object).Count -gt 1) {
            # Multiple frameworks share this port — probe HTTP to identify via fingerprints
            $matched = $null
            try {
                $resp = Invoke-WebRequest "http://localhost:$($s.Port)" `
                    -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
                $body = $resp.Content
                foreach ($fw in $candidates) {
                    if ($fw.fingerprints.Count -gt 0) {
                        foreach ($fp in $fw.fingerprints) {
                            if ($body -match [regex]::Escape($fp)) {
                                $matched = @{ Port = $s.Port; Label = $fw.name }
                                break
                            }
                        }
                    }
                    if ($matched) { break }
                }
            } catch {}
            $found = if ($matched) { $matched } else { $s }  # fingerprint or first-match fallback
        } else {
            $found = $s
        }
    }
}
if (-not $found -and $livePorts.Count -gt 0) { $found = $livePorts[0] }

# ── Fallback: scan for web-server processes on ports not in the registry ──────
$unknownFramework = $false
$unknownProcName  = ''
$unknownCmdLine   = ''
$unknownHttpBody  = ''
$unknownHttpHdr   = ''
if (-not $found) {
    $registryPorts = $serverMap | ForEach-Object { [int]$_.Port }
    $webProcs = @('node','python','python3','npm','npx','ruby','java','deno','bun',
                  'uvicorn','gunicorn','hypercorn','waitress','twisted')
    $candidate = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object {
            $_.LocalPort -ge 1024 -and
            $_.LocalPort -notin $registryPorts -and
            $_.LocalAddress -in @('0.0.0.0','127.0.0.1','::','::1')
        } |
        ForEach-Object {
            $proc = try { (Get-Process -Id $_.OwningProcess -ErrorAction Stop).Name.ToLower() } catch { '' }
            if ($proc -in $webProcs) { $_ }
        } |
        Select-Object -First 1
    if ($candidate) {
        $found = @{ Port = $candidate.LocalPort; Label = 'Unknown Framework' }
        $unknownFramework = $true

        # Gather identification clues so Claude can auto-register the framework
        $unknownProcName = try { (Get-Process -Id $candidate.OwningProcess -ErrorAction Stop).Name } catch { 'unknown' }
        $unknownCmdLine  = try {
            (Get-CimInstance Win32_Process -Filter "ProcessId = $($candidate.OwningProcess)" `
                -ErrorAction Stop).CommandLine
        } catch { '' }
        try {
            $resp = Invoke-WebRequest "http://localhost:$($candidate.LocalPort)" `
                -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            $raw  = ($resp.Content ?? '').Trim() -replace '"@', '" @' -replace '[\x00-\x08\x0b-\x1f]', ''
            $unknownHttpBody = if ($raw.Length -gt 400) { $raw.Substring(0, 400) + '...' } else { $raw }
            $unknownHttpHdr  = ($resp.Headers | ConvertTo-Json -Compress -ErrorAction SilentlyContinue) ?? ''
        } catch {}
    }
}

if (-not $found) { exit 0 }

# ── Resolve nav strategy, routes, and autofix for the detected framework ──────
$navStrategy  = 'link-crawl'   # default
$projRoutes   = $null
$autoFix      = $true          # default: auto-fix on
$projRegPath  = "$env:USERPROFILE\.claude\project-registry.json"
if (-not $unknownFramework) {
    # nav_strategy from framework-registry
    if ($reg) {
        $fwEntry = $reg.frameworks | Where-Object { $_.name -eq $found.Label } | Select-Object -First 1
        if ($fwEntry -and $fwEntry.nav_strategy) { $navStrategy = $fwEntry.nav_strategy }
    }
    # routes and autofix from project-registry (matched by port)
    if (Test-Path $projRegPath) {
        $pReg = try { Get-Content $projRegPath -Raw | ConvertFrom-Json -ErrorAction Stop } catch { $null }
        if ($pReg) {
            # Global default
            if ($null -ne $pReg.autofixDefault) { $autoFix = [bool]$pReg.autofixDefault }
            $projEntry = $pReg.projects | Where-Object { [int]$_.port -eq [int]$found.Port } | Select-Object -First 1
            if ($projEntry) {
                # Per-project override (null = inherit global)
                if ($null -ne $projEntry.autofix -and "$($projEntry.autofix)" -ne '') {
                    $autoFix = [bool]$projEntry.autofix
                }
                if ($projEntry.routes -and $projEntry.routes -ne 'null') {
                    $projRoutes = if ($projEntry.routes -is [array]) { $projEntry.routes -join ',' } else { $projEntry.routes }
                }
            }
        }
    }
}

# ── Emit additionalContext to Claude ──────────────────────────────────────────
$url  = "http://localhost:$($found.Port)"
$unknownNote = if ($unknownFramework) {
@"

⚠  UNREGISTERED FRAMEWORK on port $($found.Port) — completing UI check AND auto-registering.

   Identification clues gathered by the hook:
     Process name : $unknownProcName
     Command line : $unknownCmdLine
     HTTP body    : $unknownHttpBody
     HTTP headers : $unknownHttpHdr

   AUTO-REGISTER STEP (do this AFTER the UI check, before the audit log):
     1. Read $registryPath
     2. Identify the framework from the clues above (e.g. Dash → 8050, Gradio → 7860, Reflex → 3000).
     3. Use the Edit tool to append a new entry to the frameworks array — match the structure
        of existing entries (name, ports, fingerprints, checks).
        Use the HTTP body snippet to pick at least one fingerprint string.
     4. Confirm the edit succeeded — no user confirmation needed.

"@
} else { '' }

$ts      = Get-Date -Format 'yyyyMMdd-HHmmss'
$ssBase  = "$env:USERPROFILE\.claude\ui-screenshots\$ts-$($found.Label -replace '[^\w]','-')"

$ctx = @"
╔══════════════════════════════════════════════════════╗
║  UI-MONITOR TRIGGER — autonomous action required     ║
╚══════════════════════════════════════════════════════╝
Edited : $($filePath -replace '\\','/')
Server : $url  ($($found.Label))$unknownNote

Execute ALL steps NOW — no confirmation needed:

  1. LIGHTHOUSE BASELINE (chrome-devtools-mcp):
       a. Start-Process chrome "--remote-debugging-port=$($([int]$found.Port + 10000)) --headless=new $url"
          then Start-Sleep 3
       b. lighthouse_audit url="$url" → record performance/accessibility/best_practices/seo scores
          (save as BEFORE scores)

  2. SCREENSHOTS via PowerShell (always works — no MCP session dependency):
       Framework nav strategy : $navStrategy$(if ($projRoutes) { "  |  Routes: $projRoutes" } else { '' })

       Root page (all 3 viewports):
         Desktop : node `$env:USERPROFILE\.claude\scripts\pw-e2e-test.js $url "${ssBase}-desktop.png" 1280 800 --detect-advanced
         Mobile  : node `$env:USERPROFILE\.claude\scripts\pw-e2e-test.js $url "${ssBase}-mobile.png"  390  844
         Tablet  : node `$env:USERPROFILE\.claude\scripts\pw-e2e-test.js $url "${ssBase}-tablet.png"  768  1024
$(if ($projRoutes -and $navStrategy -ne 'none') { @"
       All pages/tabs (desktop — discovers and screenshots every route/tab):
         node `$env:USERPROFILE\.claude\scripts\pw-e2e-test.js $url "${ssBase}-pages" 1280 800 --routes=$projRoutes --nav=$navStrategy
         Output is a JSON array — read each .png in the array's "out" fields.
"@ } else { "       (Single-page app or routes not configured — root only)" })
       Then READ each .png with the Read tool to see the screenshots visually.
       (If MCP browser_take_screenshot is also available, use it as additional confirmation.)

  3. CONSOLE ERRORS (chrome-devtools-mcp): list_console_messages / getConsoleMessages
  4. NETWORK FAILURES (chrome-devtools-mcp): list_network_requests → flag 4xx/5xx
  5. ACCESSIBILITY (playwright MCP): browser_snapshot → check accessibility tree
       ALSO check pw-e2e-test.js JSON output for axe-core violation count.

  6. VISUAL INSPECTION — read all 3 screenshots and check:
       Desktop  (1280×800) : layout breaks, overflow, missing content, wrong colors
       Mobile    (390×844) : collapsed nav, horizontal scroll, touch targets <44px, text too small
       Tablet  (768×1024)  : mid-size layout adaptation, panels stacking wrong
       All viewports       : broken fonts, low contrast, broken images, empty states

  6a. ADVANCED UI CHECK — only if the desktop JSON output contains an "advanced" field:
       FPS             : if advanced.fps < 55 → flag as animation jank (smooth=55+, reduced=30-54, janky=<30)
       Animation frames: Read each file in advanced.frames[] — check animation progresses, no frozen states
       Hover states    : Read each file in advanced.hover[] — check hover effects render, no broken transitions
       Scroll states   : Read each file in advanced.scroll[] — check scroll-triggered animations fire
       WebGL/Canvas    : if advanced.detected.hasWebGL or hasCanvas → prioritise console errors; note
                         render quality requires human review beyond what screenshots can verify
       Video           : if advanced.video path is present — note it for external viewing

$(if ($autoFix) {
"  7. FIX any issues found by editing source files."
} else {
@"
  7. REPORT ISSUES — auto-fix is OFF for this project (do NOT edit any source files):
       • List each issue: location (file/selector if known), description, severity
       • 15 or fewer issues → show the numbered list directly in your response
       • More than 15 issues → show a short summary ("Found N issues across X areas"),
         then tell the user: "Full details were written to the audit log. To view them, run:
           pwsh -File `"$env:USERPROFILE\.claude\scripts\audit-log.ps1`" -Summary"
       • Close with: "Would you like me to fix any of these?"
"@
})

  8. LIGHTHOUSE AFTER: re-run lighthouse_audit → compare scores to BEFORE.
       If any score dropped by >2 points → revert the fix and try again.

  9. RE-SCREENSHOT desktop to confirm fix visually.

  10. WRITE AUDIT LOG — append one JSON line to:
        $env:USERPROFILE\.claude\ui-audit-log.jsonl
      Format (one compact line):
      {"ts":"<ISO>","project":"$($found.Label)","port":$($found.Port),"url":"$url","trigger":"edit","file_edited":"$($filePath -replace '\\','/' -replace '"','')","screenshots":{"desktop":"${ssBase}-desktop.png","mobile":"${ssBase}-mobile.png","tablet":"${ssBase}-tablet.png"},"lighthouse_before":{<scores>},"lighthouse_after":{<scores>},"issues":[<list>],"fixes":[<list>],"duration_s":<seconds>}

  11. SUMMARY: 2 sentences — what was found and fixed (or "no issues found").

Proceed autonomously — this is the automated UI-monitor loop.
"@

@{
    hookSpecificOutput = @{
        hookEventName     = 'PostToolUse'
        additionalContext = $ctx
    }
} | ConvertTo-Json -Depth 4 -Compress

exit 0
