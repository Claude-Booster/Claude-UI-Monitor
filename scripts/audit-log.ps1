#!/usr/bin/env pwsh
# audit-log.ps1 — read and display the persistent UI audit log.
#
# Usage:
#   pwsh -File audit-log.ps1                   # last 20 entries
#   pwsh -File audit-log.ps1 -Last 50          # last 50 entries
#   pwsh -File audit-log.ps1 -Project SEO      # filter by project name
#   pwsh -File audit-log.ps1 -Summary          # per-project stats
#   pwsh -File audit-log.ps1 -Issues           # only entries that had issues
#   pwsh -File audit-log.ps1 -Since 2026-07-01 # entries after a date

param(
    [int]    $Last    = 20,
    [string] $Project = '',
    [string] $Since   = '',
    [switch] $Summary,
    [switch] $Issues
)

$auditLog = "$env:USERPROFILE\.claude\ui-audit-log.jsonl"

if (-not (Test-Path $auditLog)) {
    Write-Host "`n  No audit log yet at $auditLog" -ForegroundColor Yellow
    Write-Host "  Run a UI sweep or trigger a UI check to create it.`n"
    exit 0
}

$entries = Get-Content $auditLog -ErrorAction SilentlyContinue |
    ForEach-Object { try { $_ | ConvertFrom-Json -ErrorAction Stop } catch {} } |
    Where-Object { $_ }

if ($Project) { $entries = $entries | Where-Object { $_.project -like "*$Project*" } }
if ($Since)   {
    $sinceDate = [datetime]::Parse($Since)
    $entries   = $entries | Where-Object { [datetime]::Parse($_.ts) -ge $sinceDate }
}
if ($Issues)  { $entries = $entries | Where-Object { $_.issues.Count -gt 0 -or $_.a11y_violations -gt 0 } }

if (-not $entries) {
    Write-Host "`n  No matching entries.`n" -ForegroundColor Yellow
    exit 0
}

# ── Summary mode ─────────────────────────────────────────────────────────────
if ($Summary) {
    Write-Host "`n  UI Audit Summary" -ForegroundColor Cyan
    Write-Host "  $(($entries | Measure-Object).Count) total entries across $(($entries | Select-Object -ExpandProperty project -Unique | Measure-Object).Count) project(s)`n"

    $entries | Group-Object project | Sort-Object Name | ForEach-Object {
        $grp    = $_.Group
        $latest = $grp | Sort-Object ts | Select-Object -Last 1
        $fixes  = ($grp | ForEach-Object { $_.fixes.Count } | Measure-Object -Sum).Sum
        $a11y   = ($grp | ForEach-Object { $_.a11y_violations } | Measure-Object -Maximum).Maximum
        $triggers = ($grp | Group-Object trigger | ForEach-Object { "$($_.Count)×$($_.Name)" }) -join '  '

        Write-Host "  $($_.Name)" -ForegroundColor White
        Write-Host "    Checks    : $($grp.Count)   Last: $($latest.ts -replace 'T',' ' -replace 'Z','')"
        Write-Host "    Triggers  : $triggers"
        Write-Host "    Fixes     : $fixes total applied"
        Write-Host "    Peak A11y : $a11y violation(s)"
        if ($latest.lighthouse_after) {
            $lh = $latest.lighthouse_after
            Write-Host "    Lighthouse: perf=$($lh.performance)  a11y=$($lh.accessibility)  bp=$($lh.best_practices)  seo=$($lh.seo)"
        }
        Write-Host ""
    }
    return
}

# ── Detail mode ───────────────────────────────────────────────────────────────
Write-Host "`n  Last $Last entries$(if ($Project) { " for '$Project'" })`n" -ForegroundColor Cyan

$entries | Select-Object -Last $Last | ForEach-Object {
    $hasIssues = $_.issues.Count -gt 0 -or $_.a11y_violations -gt 0
    $hasFixes  = $_.fixes.Count -gt 0
    $hdrColor  = if ($hasFixes) { 'Yellow' } elseif ($hasIssues) { 'Red' } else { 'Green' }

    $tsDisplay = $_.ts -replace 'T',' ' -replace 'Z',''
    Write-Host "  [$tsDisplay] $($_.project) — $($_.trigger)" -ForegroundColor $hdrColor
    Write-Host "    URL  : $($_.url)"

    if ($_.file_edited) { Write-Host "    File : $($_.file_edited)" }

    $ssCount = if ($_.screenshots) { ($_.screenshots.PSObject.Properties | Measure-Object).Count } else { 0 }
    Write-Host "    SS   : $ssCount viewport(s) captured"

    if ($_.a11y_violations -gt 0) {
        Write-Host "    A11y : $($_.a11y_violations) violation(s)  critical=$($_.a11y_critical)" -ForegroundColor Red
    }

    if ($_.lighthouse_before -and $_.lighthouse_after) {
        $b = $_.lighthouse_before; $a = $_.lighthouse_after
        $delta = "perf $($b.performance)→$($a.performance)  " +
                 "a11y $($b.accessibility)→$($a.accessibility)  " +
                 "bp $($b.best_practices)→$($a.best_practices)  " +
                 "seo $($b.seo)→$($a.seo)"
        Write-Host "    LH Δ : $delta" -ForegroundColor Cyan
    }

    if ($_.issues.Count -gt 0) {
        Write-Host "    Issues: $($_.issues -join ' | ')" -ForegroundColor Yellow
    }
    if ($_.fixes.Count -gt 0) {
        Write-Host "    Fixes : $($_.fixes -join ' | ')" -ForegroundColor Cyan
    }
    if ($_.duration_s) { Write-Host "    Time  : $($_.duration_s)s" }
    Write-Host ""
}
