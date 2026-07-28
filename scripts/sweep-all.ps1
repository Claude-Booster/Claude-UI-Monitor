#!/usr/bin/env pwsh
# sweep-all.ps1 — proactive UI sweep for all known projects.
# Runs pw-e2e-test.js (screenshots + axe-core) on every live project,
# writes a structured entry to ui-audit-log.jsonl for each.
# Designed to run headlessly via Task Scheduler — no Claude session needed.
#
# With -Fix: calls 'claude -p' after each live project to autonomously
# analyze screenshots and apply code fixes. Closes the detect→repair loop
# without requiring an open Claude Code session.

param(
    [string]$ProjectFilter = '',  # only sweep projects matching this name
    [switch]$Fix,                 # call claude -p to auto-repair issues after each sweep
    [switch]$Quiet                # suppress per-project output (for Task Scheduler)
)

$nodeScript  = "$env:USERPROFILE\.claude\scripts\pw-e2e-test.js"
$projectReg  = "$env:USERPROFILE\.claude\project-registry.json"
$auditLog    = "$env:USERPROFILE\.claude\ui-audit-log.jsonl"
$ssDir       = "$env:USERPROFILE\.claude\ui-screenshots"

if (-not (Test-Path $projectReg)) {
    Write-Error "project-registry.json not found at $projectReg"
    exit 1
}
if (-not (Test-Path $ssDir)) { New-Item -ItemType Directory -Force $ssDir | Out-Null }

# Locate the claude CLI
$claudeExe = (Get-Command claude -ErrorAction SilentlyContinue)?.Source
if ($Fix -and -not $claudeExe) {
    Write-Host "  WARNING: -Fix requested but 'claude' not found on PATH. Fix step will be skipped." -ForegroundColor Yellow
}

$reg         = Get-Content $projectReg -Raw | ConvertFrom-Json
$projects    = $reg.projects
if ($ProjectFilter) { $projects = $projects | Where-Object { $_.name -like "*$ProjectFilter*" } }

# Load framework registry once — used to look up nav_strategy per project
$fwRegPath = "$env:USERPROFILE\.claude\framework-registry.json"
$fwReg     = if (Test-Path $fwRegPath) {
    try { Get-Content $fwRegPath -Raw | ConvertFrom-Json -ErrorAction Stop } catch { $null }
} else { $null }

if (-not $Quiet) {
    $mode = if ($Fix) { 'detect + repair' } else { 'detect only' }
    Write-Host "`n  UI Project Sweep [$mode] — $(Get-Date -Format 'yyyy-MM-dd HH:mm')" -ForegroundColor Cyan
    Write-Host "  $($projects.Count) project(s) in registry`n"
}

$swept = 0; $skipped = 0; $fixed = 0

foreach ($proj in $projects) {
    $url = "http://localhost:$($proj.port)"

    # Probe port — only call EndConnect when WaitOne returns true (op completed).
    # Calling EndConnect on a still-pending BeginConnect blocks until the OS TCP
    # timeout (~20-30 s) — far longer than the 300 ms WaitOne budget.
    $tcp = [Net.Sockets.TcpClient]::new()
    $ok  = $false
    try {
        $ar = $tcp.BeginConnect('127.0.0.1', $proj.port, $null, $null)
        $ok = $ar.AsyncWaitHandle.WaitOne(300)
        if ($ok) {
            try { [void]$tcp.EndConnect($ar) } catch {}   # EndConnect only when op finished
            $ok = $tcp.Connected
        }
        # Timeout path: skip EndConnect — Dispose() below aborts the pending op cleanly
    } catch {}
    finally { $tcp.Dispose() }

    if (-not $ok) {
        if (-not $Quiet) { Write-Host "  SKIP  $($proj.name) (port $($proj.port) not running)" -ForegroundColor DarkGray }
        $skipped++
        continue
    }

    if (-not $Quiet) { Write-Host "  CHECK $($proj.name) @ $url" -ForegroundColor Yellow }
    $swept++
    $sweepStart = Get-Date

    $projTs      = Get-Date -Format 'yyyyMMdd-HHmmss'
    $safeName    = $proj.name -replace '[^\w]','-'
    $screenshots = @{}
    $a11yViolations = 0
    $a11yCritical   = 0
    $nodeErrorLog   = "$ssDir\node-errors.log"

    # Determine routes config and nav strategy for this project
    $projRoutes  = $proj.routes   # 'auto' | '/r1,/r2' | $null
    $navStrategy = 'link-crawl'   # default
    if ($fwReg) {
        $fwEntry = $fwReg.frameworks | Where-Object { $_.name -eq $proj.framework } | Select-Object -First 1
        if ($fwEntry -and $fwEntry.nav_strategy) { $navStrategy = $fwEntry.nav_strategy }
    }

    if ($projRoutes -and $projRoutes -ne 'null') {
        # ── Multi-page mode: one node call discovers/checks all routes at desktop ──
        $routeArg = if ($projRoutes -is [array]) { $projRoutes -join ',' } else { $projRoutes }
        $outPrefix = "$ssDir\$projTs-$safeName"
        $raw = node $nodeScript $url $outPrefix 1280 800 "--routes=$routeArg" "--nav=$navStrategy" 2>>$nodeErrorLog
        try {
            $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
            # Output is a JSON array of per-route results
            $routeResults = if ($parsed -is [array]) { $parsed } else { @($parsed) }
            foreach ($r in $routeResults) {
                if ($r.ok -and $r.out) {
                    $routeKey = ($r.route ?? 'root') -replace '[^a-zA-Z0-9]', '-'
                    $screenshots[$routeKey] = $r.out
                    if ($r.a11y -and $a11yViolations -eq 0) {   # capture from first successful route
                        $a11yViolations = [int]($r.a11y.violations ?? 0)
                        $a11yCritical   = [int]($r.a11y.critical   ?? 0)
                    }
                }
            }
            if (-not $Quiet) {
                Write-Host "    Routes      : $($routeResults.Count) checked ($navStrategy)" -ForegroundColor Cyan
            }
        } catch {
            if (-not $Quiet) { Write-Host "    WARN: multi-route parse failed — see $nodeErrorLog" -ForegroundColor Yellow }
        }

        # Also do mobile + tablet on root only (keep 3-viewport coverage for root)
        foreach ($vp in @(@{ label = 'mobile'; w = 390; h = 844 }, @{ label = 'tablet'; w = 768; h = 1024 })) {
            $outPath = "$ssDir\$projTs-$safeName-$($vp.label).png"
            $raw2 = node $nodeScript $url $outPath $vp.w $vp.h 2>>$nodeErrorLog
            try {
                $p2 = $raw2 | ConvertFrom-Json -ErrorAction Stop
                if ($p2.ok) { $screenshots[$vp.label] = $outPath }
            } catch {}
        }

    } else {
        # ── Single-page mode: 3 viewports on root (original behaviour) ──────────
        $viewports = @(
            @{ label = 'desktop'; w = 1280; h = 800  },
            @{ label = 'mobile';  w = 390;  h = 844  },
            @{ label = 'tablet';  w = 768;  h = 1024 }
        )
        foreach ($vp in $viewports) {
            $outPath = "$ssDir\$projTs-$safeName-$($vp.label).png"
            $raw = node $nodeScript $url $outPath $vp.w $vp.h 2>>$nodeErrorLog
            try {
                $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
                if ($parsed.ok) {
                    $screenshots[$vp.label] = $outPath
                    if ($vp.label -eq 'desktop' -and $parsed.a11y) {
                        $a11yViolations = [int]$parsed.a11y.violations
                        $a11yCritical   = [int]($parsed.a11y.critical ?? 0)
                    }
                }
            } catch {
                if (-not $Quiet) { Write-Host "    WARN: node parse failed for $($vp.label) — see $nodeErrorLog" -ForegroundColor Yellow }
            }
        }
    } # end if/else routes

    if (-not $Quiet) {
        $ssCount  = $screenshots.Count
        $ssColor  = if ($ssCount -gt 0) { 'Green' } else { 'Yellow' }
        $a11yColor = if ($a11yViolations -eq 0) { 'Green' } elseif ($a11yCritical -gt 0) { 'Red' } else { 'Yellow' }
        Write-Host "    Screenshots : $ssCount/3" -ForegroundColor $ssColor
        Write-Host "    A11y        : $a11yViolations violation(s), $a11yCritical critical" -ForegroundColor $a11yColor
    }

    # ── Headless Claude fix ───────────────────────────────────────────────────
    $issuesList = @(); $fixesList = @()
    $claudeOutput = $null

    if ($Fix -and $claudeExe -and $screenshots.Count -gt 0) {
        if (-not $Quiet) { Write-Host "    Calling claude -p to analyze and fix..." -ForegroundColor Magenta }

        $desktopPath = $screenshots['desktop'] ?? ''
        $mobilePath  = $screenshots['mobile']  ?? ''
        $tabletPath  = $screenshots['tablet']  ?? ''

        $fixPrompt = @"
Headless UI repair task for project '$($proj.name)'. No confirmation needed — work autonomously.

Project   : $($proj.name)  ($($proj.framework))
Directory : $($proj.path)
URL       : $url
A11y      : $a11yViolations violation(s), $a11yCritical critical

Screenshots (use the Read tool to view each as an image):
  Desktop  1280x800  : $desktopPath
  Mobile    390x844  : $mobilePath
  Tablet   768x1024  : $tabletPath

Steps — execute in order without asking questions:
1. Read all three screenshot files as images using the Read tool.
2. Identify ALL visible UI issues across the three viewports:
   - Layout breaks, overflow, missing content
   - Mobile: touch targets <44px, horizontal scroll, text too small
   - Any a11y violations visible (missing labels, low contrast, broken focus)
   - Broken images, empty states, wrong colours, misaligned elements
3. For each issue found, edit the source files in $($proj.path) to fix it.
4. If no issues are visible in any viewport, do nothing.
5. Output a JSON object (and nothing else after it) on the last line:
   {"issues":["<description>",...],"fixes":["<description>",...]}
   Use empty arrays if nothing was found or fixed.
"@

        try {
            $claudeOutput = & $claudeExe --print $fixPrompt 2>&1
            $fixed++

            # Extract the trailing JSON summary line Claude emits
            $lastJsonLine = ($claudeOutput | Select-String -Pattern '^\s*\{.*"issues".*"fixes"' |
                             Select-Object -Last 1)?.Line
            if ($lastJsonLine) {
                $summary = $lastJsonLine | ConvertFrom-Json -ErrorAction SilentlyContinue
                if ($summary) {
                    $issuesList = @($summary.issues)
                    $fixesList  = @($summary.fixes)
                }
            }

            if (-not $Quiet) {
                if ($fixesList.Count -gt 0) {
                    Write-Host "    Fixed : $($fixesList -join ' | ')" -ForegroundColor Cyan
                } else {
                    Write-Host "    Result: no issues found" -ForegroundColor Green
                }
            }
        } catch {
            if (-not $Quiet) { Write-Host "    claude -p error: $_" -ForegroundColor Red }
        }
    }

    # ── Audit log entry ───────────────────────────────────────────────────────
    $duration = [int]((Get-Date) - $sweepStart).TotalSeconds
    $trigger  = if ($Fix) { 'sweep-fix' } else { 'sweep' }

    $logEntry = [ordered]@{
        ts              = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ' -AsUTC)
        project         = $proj.name
        framework       = $proj.framework
        port            = $proj.port
        url             = $url
        trigger         = $trigger
        file_edited     = $null
        screenshots     = $screenshots
        a11y_violations = $a11yViolations
        a11y_critical   = $a11yCritical
        lighthouse_before  = $null
        lighthouse_after   = $null
        issues          = $issuesList
        fixes           = $fixesList
        duration_s      = $duration
    } | ConvertTo-Json -Compress -Depth 5

    Add-Content -Path $auditLog -Value $logEntry -Encoding UTF8
}

if (-not $Quiet) {
    Write-Host "`n  Done. Swept: $swept   Fixed: $fixed   Skipped (offline): $skipped" -ForegroundColor Cyan
    Write-Host "  Log: $auditLog"
}
