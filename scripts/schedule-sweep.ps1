#!/usr/bin/env pwsh
# schedule-sweep.ps1 — registers / removes a daily UI sweep in Windows Task Scheduler.
# The sweep runs headlessly (no Claude session required) via sweep-all.ps1.
#
# Usage:
#   pwsh -File schedule-sweep.ps1              # register at 09:00 daily (default)
#   pwsh -File schedule-sweep.ps1 -Time 14:30  # register at a custom time
#   pwsh -File schedule-sweep.ps1 -Remove      # unregister the task
#   pwsh -File schedule-sweep.ps1 -Status      # show current task status

param(
    [string] $Time   = '09:00',
    [switch] $Remove,
    [switch] $Status
)

$taskName    = 'Claude UI Sweep'
$sweepScript = "$env:USERPROFILE\.claude\scripts\sweep-all.ps1"
$logOutput   = "$env:USERPROFILE\.claude\ui-sweep-scheduler.log"

# ── Status ────────────────────────────────────────────────────────────────────
if ($Status) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
        Write-Host "`n  Task     : $taskName" -ForegroundColor Cyan
        Write-Host "  State    : $($task.State)"
        Write-Host "  Last run : $($info.LastRunTime)"
        Write-Host "  Last result: $($info.LastTaskResult)"
        Write-Host "  Next run : $($info.NextRunTime)`n"
    } else {
        Write-Host "`n  Task '$taskName' is not registered.`n" -ForegroundColor Yellow
    }
    exit 0
}

# ── Remove ────────────────────────────────────────────────────────────────────
if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "`n  Task '$taskName' removed.`n" -ForegroundColor Yellow
    exit 0
}

# ── Register ──────────────────────────────────────────────────────────────────
if (-not (Test-Path $sweepScript)) {
    Write-Error "sweep-all.ps1 not found at $sweepScript"
    exit 1
}

$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
if (-not $pwsh) { $pwsh = 'pwsh' }

$action   = New-ScheduledTaskAction `
    -Execute $pwsh `
    -Argument "-NonInteractive -File `"$sweepScript`" -Quiet *>> `"$logOutput`""

$trigger  = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -RunOnlyIfNetworkAvailable:$false

try {
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action   $action `
        -Trigger  $trigger `
        -Settings $settings `
        -Force | Out-Null

    Write-Host "`n  Registered: '$taskName'" -ForegroundColor Green
    Write-Host "  Schedule : daily at $Time"
    Write-Host "  Script   : $sweepScript"
    Write-Host "  Log      : $logOutput"
    Write-Host "  Status   : pwsh -File schedule-sweep.ps1 -Status"
    Write-Host "  Remove   : pwsh -File schedule-sweep.ps1 -Remove`n"
} catch {
    Write-Error "Failed to register task: $_"
    Write-Host "  Try running this script as Administrator if registration fails." -ForegroundColor Yellow
    exit 1
}
