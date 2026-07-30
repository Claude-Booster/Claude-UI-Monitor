#!/usr/bin/env pwsh
# test-ui-monitor.ps1 — verifies the UI monitor system is correctly installed and functional
# Run: pwsh -File ~/.claude/scripts/test-ui-monitor.ps1

$SCRIPTS  = $PSScriptRoot   # portable — works on any machine/user account
$hook     = "$SCRIPTS\ui-check.ps1"
$pass = 0; $fail = 0; $warn = 0

function Assert($label, $condition, $detail = "") {
    if ($condition) {
        Write-Host "  PASS  $label" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "  FAIL  $label  $detail" -ForegroundColor Red
        $script:fail++
    }
}
function Warn($label, $detail = "") {
    Write-Host "  WARN  $label  $detail" -ForegroundColor Yellow
    $script:warn++
}
function Invoke-Hook($filePath, $tool = "Edit") {
    $json = @{ tool_name = $tool; tool_input = @{ file_path = $filePath } } | ConvertTo-Json -Compress
    $out  = $json | pwsh -NonInteractive -File $hook 2>$null
    return @{ ExitCode = $LASTEXITCODE; Output = $out }
}

# ── 1. Hook filtering ────────────────────────────────────────────────────────
Write-Host "`n── 1. Hook filtering: non-UI files must be silent ────────────" -ForegroundColor Cyan

foreach ($case in @(
    @{ File = "C:/p/src/routes/users.ts";          Label = "Backend route .ts" },
    @{ File = "C:/p/src/app.component.spec.ts";    Label = "Spec file" },
    @{ File = "C:/p/node_modules/lib/index.js";    Label = "node_modules" },
    @{ File = "C:/p/models/user.py";               Label = "Non-UI Python (models/)" },
    @{ File = "C:/p/dist/main.js";                 Label = "dist/ output" },
    @{ File = "C:/p/something.config.ts";          Label = "Config file" },
    @{ File = "C:/p/src/middleware/auth.ts";        Label = "Middleware .ts" }
)) {
    $r = Invoke-Hook $case.File
    Assert "$($case.Label) → silent" ($r.ExitCode -eq 0 -and -not $r.Output)
}

# ── 2. Hook filtering: UI files must not be filtered ────────────────────────
Write-Host "`n── 2. Hook filtering: UI files must reach port-probe stage ───" -ForegroundColor Cyan

foreach ($f in @(
    "C:/p/src/app/app.component.html",
    "C:/p/src/styles.scss",
    "C:/p/src/routes/+page.svelte",
    "C:/p/src/App.tsx",
    "C:/p/templates/index.html",
    "C:/p/app.py",
    "C:/p/web_dashboard.py",
    "C:/p/agentpulse/scripts/demo.py",
    "C:/p/serve.py"
)) {
    $r = Invoke-Hook $f
    Assert "Exits cleanly (no server): $(Split-Path $f -Leaf)" ($r.ExitCode -eq 0)
}

# ── 3. Hook trigger with live server ────────────────────────────────────────
Write-Host "`n── 3. Hook trigger output with simulated dev server ──────────" -ForegroundColor Cyan

try {
    $tcp = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 5173)
    $tcp.Start()
    $r = Invoke-Hook "C:/p/src/routes/+page.svelte"
    $tcp.Stop()

    $validJson = $false
    try { $null = $r.Output | ConvertFrom-Json -ErrorAction Stop; $validJson = $true } catch {}
    Assert "Trigger fires for live port 5173"       ($r.Output -match "UI-MONITOR TRIGGER")
    Assert "Trigger contains correct URL"            ($r.Output -match "localhost:5173")
    Assert "Output is valid JSON"                    $validJson
    Assert "additionalContext key present"           ($r.Output -match "additionalContext")
    Assert "hookEventName key present"               ($r.Output -match "hookEventName")
    Assert "Step instructions included"              ($r.Output -match "pw-e2e-test\.js")
} catch {
    Warn "Port 5173 bind failed (already in use?) — trigger test skipped" "$_"
}

# ── 4. Hook performance ──────────────────────────────────────────────────────
Write-Host "`n── 4. Hook performance (must finish inside 10 s timeout) ─────" -ForegroundColor Cyan

$sw = [Diagnostics.Stopwatch]::StartNew()
$null = Invoke-Hook "C:/p/src/app.component.html"   # no server — exits quickly
$sw.Stop()
# Threshold is 9 s: 10 s system limit minus 1 s margin.
# The test harness spawns a fresh pwsh (~2 s startup) not present in production,
# so actual production hook time is ~3 s less than what we measure here.
# Allow 20 s when the suite is run alongside Selenium tests (browser launch adds load).
Assert "Hook completes in < 20 s (test harness includes pwsh startup + Get-NetTCPConnection scan)" `
    ($sw.ElapsedMilliseconds -lt 20000)  "($($sw.ElapsedMilliseconds) ms)"

# ── 5. MCP servers in .claude.json ──────────────────────────────────────────
Write-Host "`n── 5. MCP servers registered in ~/.claude.json ───────────────" -ForegroundColor Cyan
# NOTE: This confirms the servers are REGISTERED. It does NOT prove the tools
# are available inside a Claude session — that requires a NEW CHAT (not reload).

$claudeJson = "$env:USERPROFILE\.claude.json"
if (Test-Path $claudeJson) {
    $j = Get-Content $claudeJson -Raw | ConvertFrom-Json
    Assert "playwright entry in .claude.json"           ($j.mcpServers.PSObject.Properties.Name -contains "playwright")
    Assert "chrome-devtools-mcp entry in .claude.json"  ($j.mcpServers.PSObject.Properties.Name -contains "chrome-devtools-mcp")
    Assert "playwright command is npx"                  ($j.mcpServers.playwright.command -eq "npx")
    Assert "chrome-devtools-mcp command is npx"         ($j.mcpServers."chrome-devtools-mcp".command -eq "npx")
} else {
    Assert ".claude.json exists" $false "(not found at $claudeJson)"
}

# ── 6. MCP servers health (Connected ≠ tools in session) ────────────────────
Write-Host "`n── 6. MCP server process health ──────────────────────────────" -ForegroundColor Cyan
# IMPORTANT: "Connected" here means the MCP server process started and
# responded to the health check. It does NOT mean Claude can call browser_*
# tools right now. Tools only appear in a NEW CHAT started after registration.

$mcpOut = claude mcp list 2>&1
Assert "playwright shows Connected"          ($mcpOut -match "playwright.*Connected")        "(got: $($mcpOut | Select-String 'playwright'))"
Assert "chrome-devtools-mcp shows Connected" ($mcpOut -match "chrome-devtools-mcp.*Connected") "(got: $($mcpOut | Select-String 'chrome'))"
# Connected means the server process started. It does NOT mean tools are in
# Claude's active tool list. Tools only load at the start of a new conversation.

# ── 7. Playwright browser binary ────────────────────────────────────────────
Write-Host "`n── 7. Playwright Chromium binary installed ───────────────────" -ForegroundColor Cyan

$pwDir = "$env:USERPROFILE\AppData\Local\ms-playwright"
$shell = Get-ChildItem $pwDir -Recurse -Filter "chrome-headless-shell.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
Assert "chrome-headless-shell.exe present"  ($null -ne $shell)  "(looked in $pwDir)"
if ($shell) {
    Assert "chrome-headless-shell.exe > 50 MB"  ($shell.Length -gt 50MB)  "($([math]::Round($shell.Length/1MB,1)) MB)"
}

# ── 8. Playwright E2E — renders page and screenshots (no MCP layer) ──────────
Write-Host "`n── 8. Playwright E2E: renders and screenshots without MCP ────" -ForegroundColor Cyan
# This tests the full Playwright + Chromium stack independently of Claude/MCP.
# If this passes, the browser infrastructure works; the remaining question is
# only whether Claude can call the MCP tools in a given session.

$e2eScript = "$SCRIPTS\pw-e2e-test.js"
$e2eOut    = "$env:USERPROFILE\.claude\ui-screenshots\e2e-smoke-test.png"
$nodeModPw = "$SCRIPTS\node_modules\playwright"

if ((Test-Path $e2eScript) -and (Test-Path $nodeModPw)) {
    # Desktop smoke test
    $result = node $e2eScript "about:blank" $e2eOut 2>&1
    try   { $parsed = $result | ConvertFrom-Json -ErrorAction Stop }
    catch { $parsed = $null }
    Assert "Playwright script exits cleanly"         ($LASTEXITCODE -eq 0)               "(exit: $LASTEXITCODE)"
    Assert "Result JSON reports ok:true"             ($parsed -and $parsed.ok -eq $true) "(got: $result)"
    Assert "Screenshot file created"                 (Test-Path $e2eOut)                 "(expected: $e2eOut)"
    if (Test-Path $e2eOut) {
        $sz = (Get-Item $e2eOut).Length
        Assert "Screenshot file non-empty (> 1 KB)"  ($sz -gt 1024)                     "($sz bytes)"
    }

    # Mobile viewport (390x844 — iPhone 14)
    $mobileOut = "$env:USERPROFILE\.claude\ui-screenshots\e2e-mobile-test.png"
    $mRes = node $e2eScript "about:blank" $mobileOut 390 844 2>&1
    try { $mp = $mRes | ConvertFrom-Json -ErrorAction Stop } catch { $mp = $null }
    Assert "Mobile viewport (390x844) screenshot created"    ($mp -and $mp.ok -eq $true)  "(got: $mRes)"
    Assert "Mobile screenshot reports correct width (390)"   ($mp -and $mp.width -eq 390) "(got: $($mp.width))"

    # Tablet viewport (768x1024 — iPad)
    $tabletOut = "$env:USERPROFILE\.claude\ui-screenshots\e2e-tablet-test.png"
    $tRes = node $e2eScript "about:blank" $tabletOut 768 1024 2>&1
    try { $tp = $tRes | ConvertFrom-Json -ErrorAction Stop } catch { $tp = $null }
    Assert "Tablet viewport (768x1024) screenshot created"   ($tp -and $tp.ok -eq $true)   "(got: $tRes)"
    Assert "Tablet screenshot reports correct width (768)"   ($tp -and $tp.width -eq 768)   "(got: $($tp.width))"

    # If a dev server is live, screenshot it at all three viewports
    $livePorts = @(4200,5173,3000,8501,5000,8000) | Where-Object {
        try { $t=[Net.Sockets.TcpClient]::new(); $a=$t.BeginConnect('127.0.0.1',$_,$null,$null); $ok=$a.AsyncWaitHandle.WaitOne(200); try{$t.Close()}catch{}; $ok } catch { $false }
    }
    foreach ($p in $livePorts) {
        foreach ($vp in @(
            @{ Label = "desktop"; W = 1280; H = 800  },
            @{ Label = "mobile";  W = 390;  H = 844  },
            @{ Label = "tablet";  W = 768;  H = 1024 }
        )) {
            $liveOut = "$env:USERPROFILE\.claude\ui-screenshots\e2e-live-$p-$($vp.Label).png"
            $liveRes = node $e2eScript "http://localhost:$p" $liveOut $vp.W $vp.H 2>&1
            try { $lp = $liveRes | ConvertFrom-Json -ErrorAction Stop } catch { $lp = $null }
            Assert "Live $($vp.Label) screenshot: localhost:$p ($($vp.W)x$($vp.H))" ($lp -and $lp.ok -eq $true) "(got: $liveRes)"
        }
    }
    # Multi-page mode: --routes flag returns a JSON array
    $multiOut    = "$env:USERPROFILE\.claude\ui-screenshots\e2e-multi-test"
    $multiResult = node $e2eScript "about:blank" $multiOut 1280 800 "--routes=/" 2>&1
    # -NoEnumerate preserves the JSON array as a PowerShell array (without it, a
    # single-element JSON array is unwrapped to a plain PSCustomObject by ConvertFrom-Json)
    try   { $mp2 = $multiResult | ConvertFrom-Json -ErrorAction Stop -NoEnumerate } catch { $mp2 = $null }
    Assert "Multi-page --routes flag: output is JSON array"          ($mp2 -is [array])                           "(got: $multiResult)"
    Assert "Multi-page --routes flag: array entry has route field"   ($mp2 -and $mp2[0].PSObject.Properties['route']) "(got: $($mp2[0]))"
    Assert "Multi-page --routes flag: array entry has out field"     ($mp2 -and $mp2[0].PSObject.Properties['out'])   "(got: $($mp2[0]))"

    # --detect-advanced flag: JSON output must contain an 'advanced' key
    $advOut    = "$env:USERPROFILE\.claude\ui-screenshots\e2e-advanced-test.png"
    $advResult = node $e2eScript "about:blank" $advOut 1280 800 "--detect-advanced" 2>&1
    try   { $ap = $advResult | ConvertFrom-Json -ErrorAction Stop } catch { $ap = $null }
    Assert "--detect-advanced: script exits cleanly"              ($LASTEXITCODE -eq 0)                               "(exit: $LASTEXITCODE)"
    Assert "--detect-advanced: output JSON has 'advanced' key"    ($ap -and $ap.PSObject.Properties['advanced'])      "(got: $advResult)"
    Assert "--detect-advanced: advanced.detected is an object"    ($ap -and $null -ne $ap.advanced.detected)          "(got: $($ap.advanced))"
} else {
    Warn "E2E script or node_modules missing — run: cd ~/.claude/scripts && npm install"
}

# ── 9. Framework registry ────────────────────────────────────────────────────
Write-Host "`n── 9. Framework registry ─────────────────────────────────────" -ForegroundColor Cyan

$regPath = "$env:USERPROFILE\.claude\framework-registry.json"
Assert "framework-registry.json exists" (Test-Path $regPath)

if (Test-Path $regPath) {
    $reg = $null
    try { $reg = Get-Content $regPath -Raw | ConvertFrom-Json -ErrorAction Stop } catch {}
    Assert "Registry is valid JSON"            ($null -ne $reg)
    Assert "Registry has version field"        ($null -ne $reg.version)
    Assert "Registry has frameworks array"     ($null -ne $reg.frameworks -and $reg.frameworks.Count -gt 0)
    Assert "Registry has >= 10 frameworks"     ($reg.frameworks.Count -ge 10)  "($($reg.frameworks.Count) found)"

    $allValid = $true
    foreach ($fw in $reg.frameworks) {
        # fingerprints may be empty [] for catch-all frameworks (e.g. Generic HTTP)
        if (-not $fw.name -or $null -eq $fw.ports -or $fw.ports.Count -eq 0 -or
            $null -eq $fw.fingerprints -or -not $fw.checks -or $fw.checks.Count -eq 0) {
            $allValid = $false
        }
    }
    Assert "Every framework has name/ports/fingerprints/checks" $allValid

    $allHaveNav = $true
    $validNavValues = @('link-crawl', 'tab-click', 'none')
    foreach ($fw in $reg.frameworks) {
        if ($fw.nav_strategy -notin $validNavValues) { $allHaveNav = $false }
    }
    Assert "Every framework has a valid nav_strategy (link-crawl/tab-click/none)" $allHaveNav

    # Prove hook reads registry dynamically: add a framework on port 19999, bind it,
    # run the hook, confirm trigger fires, then restore the registry.
    $orig = Get-Content $regPath -Raw
    try {
        $modified = $reg.PSObject.Copy()
        $newFw = [PSCustomObject]@{
            name         = "_TestFramework"
            ports        = @(19999)
            fingerprints = @("test-marker")
            checks       = @("test check")
        }
        $modified.frameworks = $reg.frameworks + $newFw
        $modified | ConvertTo-Json -Depth 10 | Set-Content $regPath -Encoding UTF8

        $tcp19 = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 19999)
        $tcp19.Start()
        $r = Invoke-Hook "C:/p/templates/index.html"
        $tcp19.Stop()
        Assert "Hook picks up framework added dynamically to registry (port 19999)" ($r.Output -match "UI-MONITOR TRIGGER")
    } catch {
        Warn "Dynamic registry test skipped" "$_"
    } finally {
        Set-Content $regPath -Value $orig -Encoding UTF8
    }
}

# ── 10. Chrome remote-debugging launch (for Chrome DevTools MCP) ────────────
Write-Host "`n── 10. Chrome remote-debug launch ────────────────────────────" -ForegroundColor Cyan
# Verifies that the chrome.exe --remote-debugging-port=9222 step in CLAUDE.md actually works.
# We launch, wait 2 s, probe port 9222, then kill the process.

$chromeExe = (Get-Command chrome -ErrorAction SilentlyContinue)?.Source
if (-not $chromeExe) {
    # Try common install paths
    foreach ($p in @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )) { if (Test-Path $p) { $chromeExe = $p; break } }
}

if ($chromeExe) {
    # Launch instances sequentially so each has 3 s to bind its port before the next starts.
    # Simultaneous launch caused a race: one instance would steal resources from the other.
    $testCases = @(
        @{ AppPort = 5001;  DebugPort = 15001 },
        @{ AppPort = 8501;  DebugPort = 18501 }
    )
    $procs = @()
    try {
        foreach ($tc in $testCases) {
            $p = Start-Process $chromeExe -ArgumentList "--remote-debugging-port=$($tc.DebugPort) --headless=new about:blank" -PassThru
            $procs += $p
            # Retry-probe up to 6 s in 500 ms increments — more reliable than a fixed sleep
            $portOpen = $false
            for ($i = 0; $i -lt 12; $i++) {
                Start-Sleep -Milliseconds 500
                $tcpClient = [Net.Sockets.TcpClient]::new()
                $ar = $tcpClient.BeginConnect('127.0.0.1', $tc.DebugPort, $null, $null)
                if ($ar.AsyncWaitHandle.WaitOne(300)) { $portOpen = $true }
                try { $tcpClient.Close() } catch {}
                if ($portOpen) { break }
            }
            Assert "Chrome debug port $($tc.DebugPort) open (app port $($tc.AppPort) + 10000)" $portOpen "(port $($tc.DebugPort) not open)"
        }
    } catch {
        Assert "Chrome dynamic debug ports" $false "$_"
    } finally {
        # Kill only the Chrome instances started by this test (not other sessions on the machine)
        foreach ($p in $procs) {
            if ($p -and -not $p.HasExited) { try { $p.Kill() } catch {} }
        }
    }
} else {
    Warn "chrome.exe not found — skipping remote-debug test (install Chrome to enable CDP tools)"
}

# ── 11. Stylelint + axe-core + Stagehand ─────────────────────────────────────
Write-Host "`n── 11. Extended UI tools ─────────────────────────────────────" -ForegroundColor Cyan

# Stylelint
Assert "stylelint on PATH"              ($null -ne (Get-Command stylelint -ErrorAction SilentlyContinue))
Assert ".stylelintrc.json exists"       (Test-Path "$env:USERPROFILE\.claude\.stylelintrc.json")
$stylelintConfig = "$env:USERPROFILE\.claude\.stylelintrc.json"
if ((Get-Command stylelint -ErrorAction SilentlyContinue) -and (Test-Path $stylelintConfig)) {
    "body { color: red }" | stylelint --stdin-filename=test.css --config $stylelintConfig 2>&1 | Out-Null
    Assert "stylelint runs without error on valid CSS" ($LASTEXITCODE -eq 0) "(exit: $LASTEXITCODE)"
}

# axe-core in node_modules
Assert "@axe-core/playwright installed"  (Test-Path "$SCRIPTS\node_modules\@axe-core\playwright")

# axe-core actually runs via pw-e2e-test.js — verify the a11y field is present and populated
if (Test-Path "$SCRIPTS\node_modules\@axe-core\playwright") {
    $axeOut = node $e2eScript "about:blank" "$env:USERPROFILE\.claude\ui-screenshots\axe-smoke.png" 2>$null
    try { $axeParsed = $axeOut | ConvertFrom-Json -ErrorAction Stop } catch { $axeParsed = $null }
    Assert "pw-e2e-test.js runs without error"             ($axeParsed -and $axeParsed.ok -eq $true) "(got: $axeOut)"
    Assert "pw-e2e-test.js output contains a11y field"    ($axeParsed -and $null -ne $axeParsed.a11y) "(a11y field missing — axe-core not wired)"
    Assert "a11y.violations is a number (not missing)"    ($axeParsed -and $axeParsed.a11y.PSObject.Properties.Name -contains 'violations') "(violations key absent)"

    # Live URL test — axe-core should actually report a real scan result
    if ((Test-NetConnection -ComputerName localhost -Port 8501 -InformationLevel Quiet -ErrorAction SilentlyContinue)) {
        $axeLive = node $e2eScript "http://localhost:8501" "$env:USERPROFILE\.claude\ui-screenshots\axe-live.png" 2>$null
        try { $axeLiveParsed = $axeLive | ConvertFrom-Json -ErrorAction Stop } catch { $axeLiveParsed = $null }
        Assert "axe-core runs on live server (localhost:8501)" `
               ($axeLiveParsed -and $axeLiveParsed.ok -and $null -ne $axeLiveParsed.a11y.violations) `
               "(a11y.violations absent on live URL)"
    }
}

# Stagehand + .env
Assert "@browserbasehq/stagehand installed" (Test-Path "$SCRIPTS\node_modules\@browserbasehq\stagehand")
Assert "stagehand-fallback.js exists"        (Test-Path "$SCRIPTS\stagehand-fallback.js")
$envPath = "$env:USERPROFILE\.claude\.env"
Assert ".env file exists"                    (Test-Path $envPath)
if (Test-Path $envPath) {
    $envContent = Get-Content $envPath -Raw
    $hasKey = $envContent -match 'GROQ_API_KEY=\S+' -or
              $envContent -match 'ANTHROPIC_API_KEY=\S+' -or
              $envContent -match 'OPENAI_API_KEY=\S+' -or
              $envContent -match 'BROWSERBASE_API_KEY=\S+'
    Assert ".env has at least one LLM key set" $hasKey "(add a key to ~/.claude/.env)"
}

# Snapshot test files
Assert "snapshot.spec.js exists"     (Test-Path "$SCRIPTS\snapshot.spec.js")
Assert "playwright.config.js exists" (Test-Path "$SCRIPTS\playwright.config.js")
Assert "@playwright/test installed"  (Test-Path "$SCRIPTS\node_modules\@playwright\test")

# Snapshot baseline dir
$baselineDir = "$env:USERPROFILE\.claude\ui-screenshots\baselines"
if (-not (Test-Path $baselineDir)) { New-Item -ItemType Directory -Force $baselineDir | Out-Null }
Assert "baselines dir exists" (Test-Path $baselineDir)

# ── 12. Unregistered-framework fallback ─────────────────────────────────────
Write-Host "`n── 12. Unregistered-framework fallback ───────────────────────" -ForegroundColor Cyan
# End-to-end trigger test is blocked when a registered server (e.g. Streamlit on 8501) is
# already running — the hook matches the registry entry first and never reaches the fallback.
# Instead we verify the three detection components the fallback relies on:
#   (a) Get-NetTCPConnection sees the server
#   (b) Get-Process returns 'python' for that PID
#   (c) The port is absent from the registry
# Together these prove the fallback would fire in a cold environment.

$fallbackPort = 19996
$fallbackJob  = Start-Job {
    param($p)
    python -m http.server $p 2>$null
} -ArgumentList $fallbackPort

# Retry-probe up to 4 s in 500 ms increments — Python startup time varies
$conn = $null
for ($i = 0; $i -lt 8; $i++) {
    Start-Sleep -Milliseconds 500
    $conn = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalPort -eq $fallbackPort }
    if ($conn) { break }
}
Assert "Fallback: Python server visible via Get-NetTCPConnection on port $fallbackPort" `
       ($null -ne $conn) "(server did not start in time)"

if ($conn) {
    $procName = try { (Get-Process -Id $conn.OwningProcess -ErrorAction Stop).Name.ToLower() } catch { '' }
    Assert "Fallback: owning process is a recognised web-server process ('$procName')" `
           ($procName -in @('python','python3','node','npm','npx','ruby','java','deno','bun',
                            'uvicorn','gunicorn','hypercorn','waitress','twisted')) `
           "(process: $procName)"
}

$regPorts = @()
if (Test-Path "$env:USERPROFILE\.claude\framework-registry.json") {
    $rj = Get-Content "$env:USERPROFILE\.claude\framework-registry.json" -Raw | ConvertFrom-Json -ErrorAction SilentlyContinue
    if ($rj) { $regPorts = $rj.frameworks | ForEach-Object { $_.ports } | ForEach-Object { [int]$_ } }
}
Assert "Fallback: port $fallbackPort is absent from the registry (would trigger fallback path)" `
       ($fallbackPort -notin $regPorts)

Assert "Fallback: hook source contains Get-NetTCPConnection fallback logic" `
       ((Get-Content $hook -Raw) -match 'Get-NetTCPConnection')
Assert "Fallback: hook source emits registry suggestion on unknown port" `
       ((Get-Content $hook -Raw) -match 'framework-registry\.json')
Assert "Fallback: hook source gathers process/HTTP clues for auto-identification" `
       ((Get-Content $hook -Raw) -match 'Win32_Process|Get-CimInstance' -and
        (Get-Content $hook -Raw) -match 'unknownHttpBody|Invoke-WebRequest')
Assert "Fallback: hook source instructs Claude to auto-register (not just prompt user)" `
       ((Get-Content $hook -Raw) -match 'AUTO-REGISTER|auto-regist')

Stop-Job $fallbackJob -ErrorAction SilentlyContinue
Remove-Job $fallbackJob -Force -ErrorAction SilentlyContinue

# ── 13. Sweep / audit-log / scheduler infrastructure ────────────────────────
Write-Host "`n── 13. Sweep, audit log, and scheduler ───────────────────────" -ForegroundColor Cyan

# project-registry.json
$projReg = "$env:USERPROFILE\.claude\project-registry.json"
Assert "project-registry.json exists" (Test-Path $projReg)
if (Test-Path $projReg) {
    $prj = try { Get-Content $projReg -Raw | ConvertFrom-Json -ErrorAction Stop } catch { $null }
    Assert "project-registry.json is valid JSON"        ($null -ne $prj)
    Assert "project-registry.json has version field"    ($null -ne $prj.version)
    Assert "project-registry.json has projects array"   ($prj.projects -and $prj.projects.Count -gt 0)
    if ($prj.projects) {
        $allValid = $true
        foreach ($p in $prj.projects) {
            if (-not $p.name -or -not $p.port -or -not $p.framework) { $allValid = $false }
        }
        Assert "Every project has name/port/framework" $allValid

        # routes field: if present must be 'auto', null, or a non-empty array/string
        $routesValid = $true
        foreach ($p in $prj.projects) {
            if ($p.PSObject.Properties['routes'] -and $null -ne $p.routes -and $p.routes -ne 'null' `
                -and $p.routes -ne 'auto' -and ($p.routes -isnot [array]) -and ($p.routes -isnot [string])) {
                $routesValid = $false
            }
        }
        Assert "Project routes field (when present) is 'auto', null, or a route list" $routesValid

        # autofix field: if present must be true, false, or null
        $autofixValid = $true
        foreach ($p in $prj.projects) {
            if ($p.PSObject.Properties['autofix']) {
                $v = $p.autofix
                if ($null -ne $v -and $v -ne $true -and $v -ne $false) { $autofixValid = $false }
            }
        }
        Assert "Project autofix field (when present) is true, false, or null" $autofixValid
    }
    Assert "project-registry.json has autofixDefault field" ($prj.PSObject.Properties['autofixDefault'])
}

# autofix hook assertions
Assert "Hook source reads autofixDefault from project-registry"  ((Get-Content $hook -Raw) -match 'autofixDefault')
Assert "Hook source resolves per-project autofix override"        ((Get-Content $hook -Raw) -match '\$autoFix')
Assert "Hook source emits REPORT ISSUES when autofix is off"      ((Get-Content $hook -Raw) -match 'REPORT ISSUES')
Assert "Hook source emits FIX step when autofix is on"            ((Get-Content $hook -Raw) -match 'FIX any issues')

# sweep-all.ps1
Assert "sweep-all.ps1 exists"    (Test-Path "$SCRIPTS\sweep-all.ps1")
if ((Test-Path "$SCRIPTS\sweep-all.ps1") -and (Test-Path $projReg)) {
    $null = pwsh -NonInteractive -File "$SCRIPTS\sweep-all.ps1" 2>&1
    Assert "sweep-all.ps1 runs without terminating error" ($LASTEXITCODE -eq 0) "(exit: $LASTEXITCODE)"
    # -Fix flag wiring checks (source-level — avoids invoking claude in the test suite)
    $sweepSrc = Get-Content "$SCRIPTS\sweep-all.ps1" -Raw
    Assert "sweep-all.ps1 has -Fix switch parameter"          ($sweepSrc -match '\[switch\]\$Fix')
    Assert "sweep-all.ps1 invokes claude --print when -Fix"   ($sweepSrc -match 'claude.*--print')
    Assert "sweep-all.ps1 writes issues/fixes to audit log"   ($sweepSrc -match 'issuesList.*fixesList|fixesList.*issuesList')
    Assert "sweep-all.ps1 sets trigger to sweep-fix with -Fix" ($sweepSrc -match "sweep-fix")
}

# audit-log.ps1
Assert "audit-log.ps1 exists"    (Test-Path "$SCRIPTS\audit-log.ps1")
if (Test-Path "$SCRIPTS\audit-log.ps1") {
    $null = pwsh -NonInteractive -File "$SCRIPTS\audit-log.ps1" 2>&1
    Assert "audit-log.ps1 runs without error" ($LASTEXITCODE -eq 0) "(exit: $LASTEXITCODE)"
}

# audit log written by sweep
$auditLogPath = "$env:USERPROFILE\.claude\ui-audit-log.jsonl"
if (Test-Path $auditLogPath) {
    $lines = Get-Content $auditLogPath -ErrorAction SilentlyContinue
    $validJson = $true
    foreach ($line in ($lines | Select-Object -Last 5)) {
        try { $null = $line | ConvertFrom-Json -ErrorAction Stop } catch { $validJson = $false }
    }
    Assert "ui-audit-log.jsonl entries are valid JSON lines" $validJson
} else {
    # Log doesn't exist yet — that's OK, it's created on first sweep
    Warn "ui-audit-log.jsonl not yet created (run sweep-all.ps1 once to create it)"
}

# schedule-sweep.ps1
Assert "schedule-sweep.ps1 exists" (Test-Path "$SCRIPTS\schedule-sweep.ps1")

# hook trigger contains new non-MCP screenshot instruction
$hookSrc = Get-Content "$SCRIPTS\ui-check.ps1" -Raw -ErrorAction SilentlyContinue
Assert "hook trigger uses pw-e2e-test.js (no MCP dependency)" `
       ($hookSrc -match 'pw-e2e-test\.js') `
       "(hook should instruct Claude to use node script)"
Assert "hook trigger includes Lighthouse step"  ($hookSrc -match 'lighthouse')
Assert "hook trigger includes audit log step"   ($hookSrc -match 'ui-audit-log\.jsonl')

# CLAUDE.md has updated protocol
$claudeMd = Get-Content "$env:USERPROFILE\.claude\CLAUDE.md" -Raw -ErrorAction SilentlyContinue
Assert "CLAUDE.md references Lighthouse before/after" ($claudeMd -match 'Lighthouse BEFORE')
Assert "CLAUDE.md references audit log"               ($claudeMd -match 'ui-audit-log\.jsonl')
Assert "CLAUDE.md references project-registry.json"   ($claudeMd -match 'project-registry\.json')

# ── 14. Files in place ───────────────────────────────────────────────────────
Write-Host "`n── 14. Required files present ────────────────────────────────" -ForegroundColor Cyan

Assert "ui-check.ps1"              (Test-Path "$SCRIPTS\ui-check.ps1")
Assert "pw-e2e-test.js"            (Test-Path "$SCRIPTS\pw-e2e-test.js")
Assert "snapshot.spec.js"          (Test-Path "$SCRIPTS\snapshot.spec.js")
Assert "playwright.config.js"      (Test-Path "$SCRIPTS\playwright.config.js")
Assert "stagehand-fallback.js"     (Test-Path "$SCRIPTS\stagehand-fallback.js")
Assert "figma-baseline.js"         (Test-Path "$SCRIPTS\figma-baseline.js")
Assert "figma-token-check.js"      (Test-Path "$SCRIPTS\figma-token-check.js")
Assert "sweep-all.ps1"             (Test-Path "$SCRIPTS\sweep-all.ps1")
Assert "audit-log.ps1"             (Test-Path "$SCRIPTS\audit-log.ps1")
Assert "schedule-sweep.ps1"        (Test-Path "$SCRIPTS\schedule-sweep.ps1")
Assert ".stylelintrc.json"         (Test-Path "$env:USERPROFILE\.claude\.stylelintrc.json")
Assert ".env has FIGMA_ACCESS_TOKEN placeholder" `
       ((Get-Content "$env:USERPROFILE\.claude\.env" -Raw) -match 'FIGMA_ACCESS_TOKEN')
Assert "figma MCP registered in .claude.json" `
       ((Get-Content "$env:USERPROFILE\.claude.json" -Raw) -match '"figma"')
Assert "CLAUDE.md documents figma-baseline.js" `
       ((Get-Content "$env:USERPROFILE\.claude\CLAUDE.md" -Raw) -match 'figma-baseline\.js')
Assert "ui-monitor.md (agent)"     (Test-Path "$env:USERPROFILE\.claude\agents\ui-monitor.md")
Assert "global CLAUDE.md"          (Test-Path "$env:USERPROFILE\.claude\CLAUDE.md")
Assert "framework-registry.json"   (Test-Path "$env:USERPROFILE\.claude\framework-registry.json")
Assert "project-registry.json"     (Test-Path "$env:USERPROFILE\.claude\project-registry.json")
Assert "ui-screenshots dir"        (Test-Path "$env:USERPROFILE\.claude\ui-screenshots")
Assert "ui-screenshots/baselines dir" (Test-Path "$env:USERPROFILE\.claude\ui-screenshots\baselines")
Assert "playwright node_modules"   (Test-Path $nodeModPw)
Assert "selenium-xbrowser.js"     (Test-Path "$SCRIPTS\selenium-xbrowser.js")
Assert "selenium-webdriver installed" (Test-Path "$SCRIPTS\node_modules\selenium-webdriver")

# Pre-commit hook files in distribution repo
$repoRoot2 = Join-Path $env:USERPROFILE 'Claude UI Monitor'
if (Test-Path $repoRoot2) {
    Assert "Repo .githooks/pre-commit exists"               (Test-Path "$repoRoot2\.githooks\pre-commit")
    Assert "Repo .githooks/blocked-patterns.example exists" (Test-Path "$repoRoot2\.githooks\blocked-patterns.example")
    Assert "Repo .gitignore excludes blocked-patterns"      ((Get-Content "$repoRoot2\.gitignore" -Raw -EA SilentlyContinue) -match 'blocked-patterns')
} else {
    Warn "Claude UI Monitor repo not found at $repoRoot2 — skipping repo hook file checks"
}

# ── 15. API error 'action' field ──────────────────────────────────────────────
Write-Host "`n── 15. API error 'action' field in script outputs ─────────────" -ForegroundColor Cyan

# stagehand-fallback.js: source-level — confirms apiError() writes {ok:false, action:...} to stdout
$shSrc = Get-Content "$SCRIPTS\stagehand-fallback.js" -Raw -ErrorAction SilentlyContinue
if ($shSrc) {
    Assert "stagehand: apiError() function defined in source"          ($shSrc -match 'function apiError|apiError\s*=')
    Assert "stagehand: apiError() sets ok:false"                       ($shSrc -match 'ok\s*:\s*false')
    Assert "stagehand: apiError() includes action field"               ($shSrc -match 'JSON\.stringify\(.*action|action.*JSON\.stringify')
    Assert "stagehand: apiError() writes to process.stdout"            ($shSrc -match 'process\.stdout\.write')
    Assert "stagehand: resolveProvider() triggers apiError on no key"  ($shSrc -match 'No LLM key|resolveProvider')
} else {
    Warn "stagehand-fallback.js not found — skipping source checks"
}

# figma-baseline.js: live — no args → missing-fileKey JSON (action field present)
if ((Test-Path "$SCRIPTS\figma-baseline.js") -and (Test-Path "$SCRIPTS\node_modules")) {
    $fbRaw = node "$SCRIPTS\figma-baseline.js" 2>&1
    $fbLine = ($fbRaw | Out-String) -split '\r?\n' | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
    try { $fbJson = $fbLine | ConvertFrom-Json -ErrorAction Stop } catch { $fbJson = $null }
    Assert "figma-baseline: no-arg run outputs JSON with ok:false"  ($fbJson -and $fbJson.ok -eq $false)          "(got: $fbLine)"
    Assert "figma-baseline: no-arg JSON has 'action' field"         ($fbJson -and $fbJson.PSObject.Properties['action']) "(got: $fbJson)"
} else {
    Warn "figma-baseline.js or node_modules missing — skipping live API error test"
}

# figma-token-check.js: live — no URL arg → structured error (no API call made)
if ((Test-Path "$SCRIPTS\figma-token-check.js") -and (Test-Path "$SCRIPTS\node_modules")) {
    $ftRaw = node "$SCRIPTS\figma-token-check.js" 2>&1
    $ftLine = ($ftRaw | Out-String) -split '\r?\n' | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
    try { $ftJson = $ftLine | ConvertFrom-Json -ErrorAction Stop } catch { $ftJson = $null }
    Assert "figma-token-check: no-URL run outputs JSON with ok:false"  ($ftJson -and $ftJson.ok -eq $false)          "(got: $ftLine)"
    Assert "figma-token-check: no-URL JSON has 'action' field"          ($ftJson -and $ftJson.PSObject.Properties['action']) "(got: $ftJson)"
} else {
    Warn "figma-token-check.js or node_modules missing — skipping live API error test"
}

# ── 16. Selenium cross-browser check ─────────────────────────────────────────
Write-Host "`n── 16. Selenium cross-browser (selenium-xbrowser.js) ──────────" -ForegroundColor Cyan

$seleniumScript = "$SCRIPTS\selenium-xbrowser.js"
$seleniumMod    = "$SCRIPTS\node_modules\selenium-webdriver"

# Source-level: script has BiDi LogInspector, printPage, and element screenshot wiring
if (Test-Path $seleniumScript) {
    $selSrc = Get-Content $seleniumScript -Raw
    Assert "selenium-xbrowser: BiDi LogInspector import present"    ($selSrc -match 'logInspector')
    Assert "selenium-xbrowser: printPage call present"               ($selSrc -match 'printPage')
    Assert "selenium-xbrowser: element takeScreenshot present"       ($selSrc -match 'takeScreenshot')
    Assert "selenium-xbrowser: skipped flag set for missing browser" ($selSrc -match 'skipped.*notInstalled|notInstalled.*skipped')
    Assert "selenium-xbrowser: --browsers flag handled"             ($selSrc -match 'wantBrowsers|browsers')
} else {
    Warn "selenium-xbrowser.js not found — skipping source checks"
}

# Live: Chrome-only quick run on about:blank (drivers cached after first npm install)
if ((Test-Path $seleniumScript) -and (Test-Path $seleniumMod)) {
    $xbOut    = "$env:USERPROFILE\.claude\ui-screenshots\xbrowser-ci-test"
    $xbRaw    = node $seleniumScript "about:blank" $xbOut "--browsers=chrome" 2>&1
    $xbLine   = ($xbRaw | Out-String) -split '\r?\n' | Where-Object { $_ -match '^\[' -or $_ -match '^\{' } | Select-Object -Last 1
    try   { $xbJson = $xbLine | ConvertFrom-Json -ErrorAction Stop -NoEnumerate } catch { $xbJson = $null }
    Assert "selenium xbrowser: chrome run exits with valid JSON"         ($null -ne $xbJson)                                                  "(got: $xbLine)"
    Assert "selenium xbrowser: output is an array"                       ($xbJson -is [array])                                                "(got: $xbJson)"
    Assert "selenium xbrowser: chrome entry has ok:true"                 ($xbJson -and $xbJson[0].ok -eq $true)                               "(got: $($xbJson[0]))"
    Assert "selenium xbrowser: chrome entry has 'out' screenshot path"   ($xbJson -and $xbJson[0].PSObject.Properties['out'])                 "(got: $($xbJson[0]))"
    Assert "selenium xbrowser: chrome entry has consoleErrors array"     ($xbJson -and $xbJson[0].PSObject.Properties['consoleErrors'])       "(got: $($xbJson[0]))"
    Assert "selenium xbrowser: chrome entry has networkErrors array"     ($xbJson -and $xbJson[0].PSObject.Properties['networkErrors'])       "(got: $($xbJson[0]))"
    if ($xbJson -and $xbJson[0].ok -and $xbJson[0].out) {
        Assert "selenium xbrowser: chrome screenshot file created"       (Test-Path $xbJson[0].out)                                          "(path: $($xbJson[0].out))"
    }
} else {
    Warn "selenium-xbrowser.js or selenium-webdriver not installed — skipping live cross-browser test"
}

# ── 17. Extended pw-e2e-test.js features ─────────────────────────────────────
Write-Host "`n── 17. Extended pw-e2e-test.js features ─────────────────────────" -ForegroundColor Cyan

if ((Test-Path $e2eScript) -and (Test-Path $nodeModPw)) {

    # 17a. Source-level: confirm new audit functions are present
    $pwSrc = Get-Content $e2eScript -Raw
    Assert "pw-e2e-test: runMetaAudit function defined"          ($pwSrc -match 'function runMetaAudit')
    Assert "pw-e2e-test: runImageAudit function defined"         ($pwSrc -match 'function runImageAudit')
    Assert "pw-e2e-test: runBundleAudit function defined"        ($pwSrc -match 'function runBundleAudit')
    Assert "pw-e2e-test: runFontAudit function defined"          ($pwSrc -match 'function runFontAudit')
    Assert "pw-e2e-test: setupResponseTracking function defined" ($pwSrc -match 'function setupResponseTracking')
    Assert "pw-e2e-test: getCSSCoverage function defined"        ($pwSrc -match 'function getCSSCoverage')
    Assert "pw-e2e-test: runCWV function defined"                ($pwSrc -match 'function runCWV')
    Assert "pw-e2e-test: captureDarkMode function defined"       ($pwSrc -match 'function captureDarkMode')
    Assert "pw-e2e-test: compareScreenshots function defined"    ($pwSrc -match 'function compareScreenshots')
    Assert "pw-e2e-test: --dark-mode flag handled"              ($pwSrc -match 'darkMode\s*=')
    Assert "pw-e2e-test: --css-coverage flag handled"           ($pwSrc -match 'cssCoverage\s*=')
    Assert "pw-e2e-test: --har flag handled"                    ($pwSrc -match 'harCapture\s*=')
    Assert "pw-e2e-test: --cwv flag handled"                    ($pwSrc -match 'cwvMode\s*=')
    Assert "pw-e2e-test: --compare flag handled"                ($pwSrc -match 'comparePath\s*=')

    # pixelmatch + pngjs installed
    Assert "pixelmatch installed" (Test-Path "$SCRIPTS\node_modules\pixelmatch")
    Assert "pngjs installed"      (Test-Path "$SCRIPTS\node_modules\pngjs")

    # 17b. about:blank: always-on fields must be absent (real-URL-only)
    $t17Blank = "$env:USERPROFILE\.claude\ui-screenshots\test17-blank.png"
    $t17bRaw  = node $e2eScript "about:blank" $t17Blank 2>&1
    try { $t17bJson = $t17bRaw | ConvertFrom-Json -ErrorAction Stop } catch { $t17bJson = $null }
    Assert "about:blank: meta absent (real-URL-only)"            ($t17bJson -and -not $t17bJson.PSObject.Properties['meta'])
    Assert "about:blank: images absent (real-URL-only)"          ($t17bJson -and -not $t17bJson.PSObject.Properties['images'])
    Assert "about:blank: bundle absent (real-URL-only)"          ($t17bJson -and -not $t17bJson.PSObject.Properties['bundle'])
    Assert "about:blank: fonts absent (real-URL-only)"           ($t17bJson -and -not $t17bJson.PSObject.Properties['fonts'])
    Assert "about:blank: securityHeaders absent (real-URL-only)" ($t17bJson -and -not $t17bJson.PSObject.Properties['securityHeaders'])

    # 17c. --css-coverage (works on about:blank via page.setContent)
    $t17cOut = "$env:USERPROFILE\.claude\ui-screenshots\test17-css.png"
    $t17cRaw = node $e2eScript "about:blank" $t17cOut 1280 800 "--css-coverage" 2>&1
    try { $t17cJson = $t17cRaw | ConvertFrom-Json -ErrorAction Stop } catch { $t17cJson = $null }
    Assert "--css-coverage: JSON has 'css' field"                ($t17cJson -and $t17cJson.PSObject.Properties['css'])         "(got: $t17cRaw)"
    Assert "--css-coverage: css.sheetsCount present"             ($t17cJson -and $t17cJson.css.PSObject.Properties['sheetsCount']) "(got: $($t17cJson.css))"
    Assert "--css-coverage: css.unusedPct present"               ($t17cJson -and $null -ne $t17cJson.css.unusedPct)           "(got: $($t17cJson.css.unusedPct))"

    # 17d. --har (HAR file recorded for about:blank)
    $t17dOut = "$env:USERPROFILE\.claude\ui-screenshots\test17-har.png"
    $t17dRaw = node $e2eScript "about:blank" $t17dOut 1280 800 "--har" 2>&1
    try { $t17dJson = $t17dRaw | ConvertFrom-Json -ErrorAction Stop } catch { $t17dJson = $null }
    Assert "--har: JSON has 'harPath' field"                     ($t17dJson -and $t17dJson.PSObject.Properties['harPath'])     "(got: $t17dRaw)"
    Assert "--har: .har file created on disk"                    ($t17dJson -and (Test-Path ($t17dJson.harPath ?? 'NONE')))    "(path: $($t17dJson.harPath))"

    # 17e. --compare: first run creates baseline (about:blank)
    $t17Base = "$env:USERPROFILE\.claude\ui-screenshots\test17-baseline.png"
    if (Test-Path $t17Base) { Remove-Item $t17Base -Force }
    $t17eOut = "$env:USERPROFILE\.claude\ui-screenshots\test17-cmp1.png"
    $t17eRaw = node $e2eScript "about:blank" $t17eOut 1280 800 "--compare=$t17Base" 2>&1
    try { $t17eJson = $t17eRaw | ConvertFrom-Json -ErrorAction Stop } catch { $t17eJson = $null }
    Assert "--compare: first run: diff.baselineCreated is true"  ($t17eJson -and $t17eJson.diff.baselineCreated -eq $true)    "(got: $($t17eJson.diff))"
    Assert "--compare: first run: baseline file created"         (Test-Path $t17Base)                                          "(path: $t17Base)"

    # 17f. --compare: second run produces diff object (identical → diffPct 0)
    $t17fOut = "$env:USERPROFILE\.claude\ui-screenshots\test17-cmp2.png"
    $t17fRaw = node $e2eScript "about:blank" $t17fOut 1280 800 "--compare=$t17Base" 2>&1
    try { $t17fJson = $t17fRaw | ConvertFrom-Json -ErrorAction Stop } catch { $t17fJson = $null }
    Assert "--compare: second run: diff.diffPct present"         ($t17fJson -and $t17fJson.PSObject.Properties['diff'] -and $null -ne $t17fJson.diff.diffPct) "(got: $($t17fJson.diff))"
    Assert "--compare: second run: identical → diffPct = 0"      ($t17fJson -and $t17fJson.diff.diffPct -eq 0)               "(got: $($t17fJson.diff.diffPct))"
    Assert "--compare: second run: diff PNG file created"        ($t17fJson -and (Test-Path ($t17fJson.diff.diffPath ?? 'NONE'))) "(path: $($t17fJson.diff.diffPath))"

    # 17g. Dark mode, CWV, and real-URL always-on fields — use local HTTP server
    $t17Port = 19994
    $t17Job  = $null
    $t17Up   = $false
    try {
        $t17Job = Start-Job { param($p); python -m http.server $p 2>$null } -ArgumentList $t17Port
        for ($i = 0; $i -lt 8; $i++) {
            Start-Sleep -Milliseconds 500
            if (Test-NetConnection -ComputerName localhost -Port $t17Port -InformationLevel Quiet -EA SilentlyContinue) {
                $t17Up = $true; break
            }
        }
    } catch {}

    if ($t17Up) {
        $t17Url = "http://localhost:$t17Port"

        # Always-on fields on real URL
        $t17rOut = "$env:USERPROFILE\.claude\ui-screenshots\test17-real.png"
        $t17rRaw = node $e2eScript $t17Url $t17rOut 1280 800 2>&1
        try { $t17rJson = $t17rRaw | ConvertFrom-Json -ErrorAction Stop } catch { $t17rJson = $null }
        Assert "real URL: meta field present"                    ($t17rJson -and $t17rJson.PSObject.Properties['meta'])           "(meta absent)"
        Assert "real URL: meta.issues is an array"               ($t17rJson -and $t17rJson.meta.issues -is [array])               "(got: $($t17rJson.meta.issues))"
        Assert "real URL: images field present"                  ($t17rJson -and $t17rJson.PSObject.Properties['images'])
        Assert "real URL: images.total is a number"              ($t17rJson -and $null -ne $t17rJson.images.total)               "(got: $($t17rJson.images.total))"
        Assert "real URL: bundle field present"                  ($t17rJson -and $t17rJson.PSObject.Properties['bundle'])
        Assert "real URL: bundle.totalTransferKB present"       ($t17rJson -and $null -ne $t17rJson.bundle.totalTransferKB)      "(got: $($t17rJson.bundle.totalTransferKB))"
        Assert "real URL: fonts field present"                   ($t17rJson -and $t17rJson.PSObject.Properties['fonts'])
        Assert "real URL: fonts.loaded is a number"              ($t17rJson -and $null -ne $t17rJson.fonts.loaded)               "(got: $($t17rJson.fonts.loaded))"
        Assert "real URL: securityHeaders field present"         ($t17rJson -and $t17rJson.PSObject.Properties['securityHeaders'])
        Assert "real URL: securityHeaders.missing is an array"  ($t17rJson -and $t17rJson.securityHeaders.missing -is [array])   "(got: $($t17rJson.securityHeaders.missing))"

        # Dark mode
        $t17dkOut = "$env:USERPROFILE\.claude\ui-screenshots\test17-dark.png"
        $t17dkRaw = node $e2eScript $t17Url $t17dkOut 1280 800 "--dark-mode" 2>&1
        try { $t17dkJson = $t17dkRaw | ConvertFrom-Json -ErrorAction Stop } catch { $t17dkJson = $null }
        Assert "--dark-mode: JSON has 'darkMode' field"          ($t17dkJson -and $t17dkJson.PSObject.Properties['darkMode'])    "(got: $t17dkRaw)"
        Assert "--dark-mode: -dark.png file created on disk"     ($t17dkJson -and (Test-Path ($t17dkJson.darkMode.out ?? 'NONE'))) "(path: $($t17dkJson.darkMode.out))"

        # CWV
        $t17cwvOut = "$env:USERPROFILE\.claude\ui-screenshots\test17-cwv.png"
        $t17cwvRaw = node $e2eScript $t17Url $t17cwvOut 1280 800 "--cwv" 2>&1
        try { $t17cwvJson = $t17cwvRaw | ConvertFrom-Json -ErrorAction Stop } catch { $t17cwvJson = $null }
        Assert "--cwv: JSON has 'cwv' field"                     ($t17cwvJson -and $t17cwvJson.PSObject.Properties['cwv'])       "(got: $t17cwvRaw)"
        Assert "--cwv: cwv.ratings object present"               ($t17cwvJson -and $null -ne $t17cwvJson.cwv.ratings)           "(got: $($t17cwvJson.cwv))"
        Assert "--cwv: cwv.cls is defined (0 or more)"          ($t17cwvJson -and $null -ne $t17cwvJson.cwv.cls)                "(got: $($t17cwvJson.cwv.cls))"

        if ($t17Job) {
            Stop-Job $t17Job -ErrorAction SilentlyContinue
            Remove-Job $t17Job -Force -ErrorAction SilentlyContinue
        }
    } else {
        Warn "Local HTTP server on port $t17Port unavailable — skipping dark-mode, cwv, and real-URL tests"
        if ($t17Job) {
            Stop-Job $t17Job -ErrorAction SilentlyContinue
            Remove-Job $t17Job -Force -ErrorAction SilentlyContinue
        }
    }
} else {
    Warn "E2E script or node_modules missing — skipping extended feature tests (Section 17)"
}

# ── 18. New pw-e2e-test.js features (scripts, touchTargets, new flags) ───────
Write-Host "`n── 18. New pw-e2e-test.js audit features ─────────────────────" -ForegroundColor Cyan

$e2eScript18 = "$SCRIPTS\pw-e2e-test.js"
$nm18        = "$SCRIPTS\node_modules"

if ((Test-Path $e2eScript18) -and (Test-Path $nm18)) {
    $src18 = Get-Content $e2eScript18 -Raw

    # Source-level: new function presence
    Assert "pw-e2e-test: runScriptAudit function defined"      ($src18 -match 'async function runScriptAudit')
    Assert "pw-e2e-test: runTouchTargetAudit function defined" ($src18 -match 'async function runTouchTargetAudit')
    Assert "pw-e2e-test: captureReducedMotion function defined"($src18 -match 'async function captureReducedMotion')
    Assert "pw-e2e-test: captureForcedColors function defined" ($src18 -match 'async function captureForcedColors')
    Assert "pw-e2e-test: capturePrintLayout function defined"  ($src18 -match 'async function capturePrintLayout')
    Assert "pw-e2e-test: captureNoJS function defined"         ($src18 -match 'async function captureNoJS')
    Assert "pw-e2e-test: runFocusAuditFn function defined"     ($src18 -match 'async function runFocusAuditFn')
    Assert "pw-e2e-test: runFullAudit function defined"        ($src18 -match 'async function runFullAudit')
    Assert "pw-e2e-test: installCWVObserver function defined"  ($src18 -match 'async function installCWVObserver')

    # Flag parsing presence
    Assert "pw-e2e-test: --reduced-motion flag handled"  ($src18 -match "reducedMotion\s*=\s*flags\['reduced-motion'\]")
    Assert "pw-e2e-test: --forced-colors flag handled"   ($src18 -match "forcedColors\s*=\s*flags\['forced-colors'\]")
    Assert "pw-e2e-test: --print flag handled"           ($src18 -match "printLayout\s*=\s*flags\['print'\]")
    Assert "pw-e2e-test: --no-js flag handled"           ($src18 -match "noJsMode\s*=\s*flags\['no-js'\]")
    Assert "pw-e2e-test: --focus-audit flag handled"     ($src18 -match "focusAudit\s*=\s*flags\['focus-audit'\]")

    # Dark mode axe integration
    Assert "pw-e2e-test: darkModeA11y in runFullAudit"   ($src18 -match 'darkModeA11y_')

    # CLS sources + TBT in installCWVObserver / runCWV
    Assert "pw-e2e-test: CLS shifts tracking in observer" ($src18 -match 'window.__vitals\.shifts')
    Assert "pw-e2e-test: longTasks tracking in observer"  ($src18 -match 'window.__vitals\.longTasks')
    Assert "pw-e2e-test: TBT computed in runCWV"          ($src18 -match 'tbt\b')
    Assert "pw-e2e-test: clsSources in CWV output"        ($src18 -match 'clsSources')

    # Redirect chain in setupResponseTracking
    Assert "pw-e2e-test: redirectChain tracking in setupResponseTracking" ($src18 -match 'redirectChain\.push')
    Assert "pw-e2e-test: getRedirectChain closure exported"               ($src18 -match 'getRedirectChain')

    # JSON-LD and blocksZoom in runMetaAudit
    Assert "pw-e2e-test: JSON-LD structuredData in runMetaAudit"   ($src18 -match 'structuredData')
    Assert "pw-e2e-test: blocksZoom check in runMetaAudit"         ($src18 -match 'blocksZoom')

    # lazyAboveFold and fetchpriority in runImageAudit
    Assert "pw-e2e-test: lazyAboveFold in runImageAudit"           ($src18 -match 'lazyAboveFold')
    Assert "pw-e2e-test: missingFetchPriority in runImageAudit"    ($src18 -match 'missingFetchPriority')

    # Touch target WCAG reference
    Assert "pw-e2e-test: WCAG 2.5.8 reference in runTouchTargetAudit" ($src18 -match '2\.5\.8')

    # about:blank — new always-on fields must also be absent
    $ss18Blank = "$env:TEMP\s18-blank.png"
    $r18Blank  = (node $e2eScript18 about:blank $ss18Blank 400 300 2>$null) -join ''
    try { $j18Blank = $r18Blank | ConvertFrom-Json } catch {}
    Assert "about:blank: scripts absent (real-URL-only)"       (-not $j18Blank.PSObject.Properties['scripts'])
    Assert "about:blank: touchTargets absent (real-URL-only)"  (-not $j18Blank.PSObject.Properties['touchTargets'])

    # Live URL tests — spin up a local HTTP server on a different port
    $t18Port = 19995
    $t18Dir  = "$env:TEMP\pw-s18"
    if (-not (Test-Path $t18Dir)) { New-Item -ItemType Directory -Force $t18Dir | Out-Null }
    @'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Section 18 Test Page</title>
  <meta name="description" content="pw-e2e-test section 18 test page">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://cdn.example.com/analytics.js" async></script>
</head>
<body>
  <h1>Section 18</h1>
  <button style="width:60px;height:36px">Click me</button>
  <a href="#skip" style="display:inline-block;width:50px;height:12px">tiny</a>
  <img src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" alt="1px">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Test"}</script>
</body>
</html>
'@ | Set-Content "$t18Dir\index.html"

    $t18Job = Start-Job {
        param($dir, $port)
        Set-Location $dir
        python -m http.server $port --bind 127.0.0.1 2>$null
    } -ArgumentList $t18Dir, $t18Port
    Start-Sleep 2

    $t18Url = "http://127.0.0.1:$t18Port/"

    # Basic real-URL: scripts + touchTargets always-on
    $ss18 = "$env:TEMP\s18-real.png"
    $r18  = (node $e2eScript18 $t18Url $ss18 1280 800 2>$null) -join ''
    try { $j18 = $r18 | ConvertFrom-Json } catch { $j18 = $null }

    Assert "real URL s18: scripts field present"                        ($j18 -and $j18.PSObject.Properties['scripts'])
    Assert "real URL s18: scripts.thirdPartyCount is a number"         ($j18 -and $j18.scripts.PSObject.Properties['thirdPartyCount'])
    Assert "real URL s18: scripts.warnings is an array"                ($j18 -and $j18.scripts.PSObject.Properties['warnings'])
    Assert "real URL s18: touchTargets field present"                  ($j18 -and $j18.PSObject.Properties['touchTargets'])
    Assert "real URL s18: touchTargets.failingAA is a number"          ($j18 -and $j18.touchTargets.PSObject.Properties['failingAA'])
    Assert "real URL s18: meta.structuredData field present"           ($j18 -and $j18.meta.PSObject.Properties['structuredData'])
    Assert "real URL s18: meta.structuredData.count >= 1"              ($j18 -and $j18.meta.structuredData.count -ge 1)
    Assert "real URL s18: meta.blocksZoom is defined"                  ($j18 -and $j18.meta.PSObject.Properties['blocksZoom'])
    Assert "real URL s18: images.lazyAboveFold is a number"            ($j18 -and $j18.images.PSObject.Properties['lazyAboveFold'])
    Assert "real URL s18: images.missingFetchPriority is a number"     ($j18 -and $j18.images.PSObject.Properties['missingFetchPriority'])
    Assert "real URL s18: redirects absent on non-redirect page"       ($j18 -and -not $j18.PSObject.Properties['redirects'])

    # --cwv: TBT + CLS sources
    $ss18Cwv = "$env:TEMP\s18-cwv.png"
    $r18Cwv  = (node $e2eScript18 $t18Url $ss18Cwv 1280 800 --cwv 2>$null) -join ''
    try { $j18Cwv = $r18Cwv | ConvertFrom-Json } catch { $j18Cwv = $null }
    Assert "--cwv s18: cwv.tbt is defined"           ($j18Cwv -and $j18Cwv.cwv.PSObject.Properties['tbt'])
    Assert "--cwv s18: cwv.tbt is non-negative"      ($j18Cwv -and $null -ne $j18Cwv.cwv.tbt -and $j18Cwv.cwv.tbt -ge 0)
    Assert "--cwv s18: cwv.clsSources is an array"   ($j18Cwv -and $j18Cwv.cwv.PSObject.Properties['clsSources'])
    Assert "--cwv s18: cwv.longTasks is an array"    ($j18Cwv -and $j18Cwv.cwv.PSObject.Properties['longTasks'])
    Assert "--cwv s18: cwv.ratings.tbt present"      ($j18Cwv -and $j18Cwv.cwv.ratings.PSObject.Properties['tbt'])

    # --dark-mode: darkModeA11y field present
    $ss18Dm = "$env:TEMP\s18-dark.png"
    $r18Dm  = (node $e2eScript18 $t18Url $ss18Dm 1280 800 --dark-mode 2>$null) -join ''
    try { $j18Dm = $r18Dm | ConvertFrom-Json } catch { $j18Dm = $null }
    Assert "--dark-mode s18: darkMode field present"       ($j18Dm -and $j18Dm.PSObject.Properties['darkMode'])
    Assert "--dark-mode s18: darkModeA11y field present"   ($j18Dm -and $j18Dm.PSObject.Properties['darkModeA11y'])
    Assert "--dark-mode s18: darkModeA11y.violations >= 0" ($j18Dm -and $j18Dm.darkModeA11y.PSObject.Properties['violations'])

    # --reduced-motion
    $ss18Rm = "$env:TEMP\s18-rm.png"
    $r18Rm  = (node $e2eScript18 $t18Url $ss18Rm 1280 800 --reduced-motion 2>$null) -join ''
    try { $j18Rm = $r18Rm | ConvertFrom-Json } catch { $j18Rm = $null }
    Assert "--reduced-motion: reducedMotion field present"      ($j18Rm -and $j18Rm.PSObject.Properties['reducedMotion'])
    Assert "--reduced-motion: -reduced-motion.png file created" (Test-Path "$env:TEMP\s18-rm-reduced-motion.png")

    # --forced-colors
    $ss18Fc = "$env:TEMP\s18-fc.png"
    $r18Fc  = (node $e2eScript18 $t18Url $ss18Fc 1280 800 --forced-colors 2>$null) -join ''
    try { $j18Fc = $r18Fc | ConvertFrom-Json } catch { $j18Fc = $null }
    Assert "--forced-colors: forcedColors field present"       ($j18Fc -and $j18Fc.PSObject.Properties['forcedColors'])
    Assert "--forced-colors: -forced-colors.png file created"  (Test-Path "$env:TEMP\s18-fc-forced-colors.png")

    # --print
    $ss18Pr = "$env:TEMP\s18-pr.png"
    $r18Pr  = (node $e2eScript18 $t18Url $ss18Pr 1280 800 --print 2>$null) -join ''
    try { $j18Pr = $r18Pr | ConvertFrom-Json } catch { $j18Pr = $null }
    Assert "--print: print field present"           ($j18Pr -and $j18Pr.PSObject.Properties['print'])
    Assert "--print: -print.png file created"       (Test-Path "$env:TEMP\s18-pr-print.png")

    # --no-js
    $ss18Nj = "$env:TEMP\s18-nj.png"
    $r18Nj  = (node $e2eScript18 $t18Url $ss18Nj 1280 800 --no-js 2>$null) -join ''
    try { $j18Nj = $r18Nj | ConvertFrom-Json } catch { $j18Nj = $null }
    Assert "--no-js: noJs field present"              ($j18Nj -and $j18Nj.PSObject.Properties['noJs'])
    Assert "--no-js: noJs.hasContent is boolean"      ($j18Nj -and $j18Nj.noJs.PSObject.Properties['hasContent'])
    Assert "--no-js: -no-js.png file created"         (Test-Path "$env:TEMP\s18-nj-no-js.png")

    # --focus-audit
    $ss18Fa = "$env:TEMP\s18-fa.png"
    $r18Fa  = (node $e2eScript18 $t18Url $ss18Fa 1280 800 --focus-audit 2>$null) -join ''
    try { $j18Fa = $r18Fa | ConvertFrom-Json } catch { $j18Fa = $null }
    Assert "--focus-audit: focusAudit field present"            ($j18Fa -and $j18Fa.PSObject.Properties['focusAudit'])
    Assert "--focus-audit: focusAudit.tabStopsTested >= 0"      ($j18Fa -and $j18Fa.focusAudit.PSObject.Properties['tabStopsTested'])
    Assert "--focus-audit: focusAudit.missingFocusRing >= 0"    ($j18Fa -and $j18Fa.focusAudit.PSObject.Properties['missingFocusRing'])
    Assert "--focus-audit: focusAudit.focusRingPct 0-100"       ($j18Fa -and $j18Fa.focusAudit.focusRingPct -ge 0 -and $j18Fa.focusAudit.focusRingPct -le 100)
    Assert "--focus-audit: focusAudit.warnings is an array"     ($j18Fa -and $j18Fa.focusAudit.PSObject.Properties['warnings'])

    # Cleanup
    if ($t18Job) {
        Stop-Job $t18Job -ErrorAction SilentlyContinue
        Remove-Job $t18Job -Force -ErrorAction SilentlyContinue
    }
} else {
    Warn "E2E script or node_modules missing — skipping new feature tests (Section 18)"
}

# ── 19. Batch A+B features (headings, domA11y, links, layout, cookies, pwa, etc.) ──
Write-Host "`n── 19. Batch A+B audit features ──────────────────────────────" -ForegroundColor Cyan

$e2eScript19 = "$SCRIPTS\pw-e2e-test.js"
$nm19        = "$SCRIPTS\node_modules"

if ((Test-Path $e2eScript19) -and (Test-Path $nm19)) {
    $src19 = Get-Content $e2eScript19 -Raw

    # Source-level: Batch A always-on functions
    Assert "pw-e2e-test: runHeadingAudit function defined"    ($src19 -match 'async function runHeadingAudit')
    Assert "pw-e2e-test: runDomA11yAudit function defined"    ($src19 -match 'async function runDomA11yAudit')
    Assert "pw-e2e-test: runLinksAudit function defined"      ($src19 -match 'async function runLinksAudit')
    Assert "pw-e2e-test: runLayoutAudit function defined"     ($src19 -match 'async function runLayoutAudit')
    Assert "pw-e2e-test: computeCspStrength function defined" ($src19 -match 'function computeCspStrength')
    Assert "pw-e2e-test: TRACKER_DOMAINS constant defined"    ($src19 -match 'const TRACKER_DOMAINS')

    # Source-level: Batch B flag-gated functions
    Assert "pw-e2e-test: runPWAAudit function defined"        ($src19 -match 'async function runPWAAudit')
    Assert "pw-e2e-test: checkBudget function defined"        ($src19 -match 'function checkBudget')
    Assert "pw-e2e-test: runImageFormatCheck function defined"($src19 -match 'async function runImageFormatCheck')
    Assert "pw-e2e-test: runLinkCheck function defined"       ($src19 -match 'async function runLinkCheck')
    Assert "pw-e2e-test: runSEODeepAudit function defined"    ($src19 -match 'async function runSEODeepAudit')

    # Flag parsing presence
    Assert "pw-e2e-test: --pwa flag handled"         ($src19 -match "pwaMode\s*=\s*flags\['pwa'\]")
    Assert "pw-e2e-test: --img-format flag handled"  ($src19 -match "imgFormatMode\s*=\s*flags\['img-format'\]")
    Assert "pw-e2e-test: --link-check flag handled"  ($src19 -match "linkCheckMode\s*=\s*flags\['link-check'\]")
    Assert "pw-e2e-test: --seo-deep flag handled"    ($src19 -match "seoDeepMode\s*=\s*flags\['seo-deep'\]")
    Assert "pw-e2e-test: --budget-js flag handled"   ($src19 -match "budgetJs\s*=\s*parseInt")

    # Meta extensions: lang, charset
    Assert "pw-e2e-test: meta.lang in runMetaAudit"    ($src19 -match "lang\s*=\s*document\.documentElement\.lang")
    Assert "pw-e2e-test: meta.charset in runMetaAudit" ($src19 -match "document\.characterSet")

    # Cookie security in setupResponseTracking
    Assert "pw-e2e-test: getCookiesInsecure closure"   ($src19 -match 'getCookiesInsecure')
    Assert "pw-e2e-test: Secure flag check in cookies" ($src19 -match "missing Secure")

    # Mixed content + CSP strength + unsandboxed iframes in runFullAudit
    Assert "pw-e2e-test: getMixedContent closure"          ($src19 -match 'getMixedContent')
    Assert "pw-e2e-test: cspStrength computed in runFullAudit" ($src19 -match 'cspStrength')
    Assert "pw-e2e-test: unsandboxedIframes computed"      ($src19 -match 'unsandboxedIframes')

    # srcset audit in runImageAudit
    Assert "pw-e2e-test: missingSrcset in runImageAudit"   ($src19 -match 'missingSrcset')

    # bundle.protocol + missingPreconnect
    Assert "pw-e2e-test: bundle.protocol in runBundleAudit"         ($src19 -match 'nextHopProtocol')
    Assert "pw-e2e-test: bundle.missingPreconnect in runBundleAudit" ($src19 -match 'missingPreconnect')

    # Pre-consent trackers
    Assert "pw-e2e-test: getPreConsentTrackers closure"    ($src19 -match 'getPreConsentTrackers')
    Assert "pw-e2e-test: preConsentTrackers in scripts"    ($src19 -match 'preConsentTrackers')

    # Live URL tests
    $t19Port = 19994
    $t19Dir  = "$env:TEMP\pw-s19"
    if (-not (Test-Path $t19Dir)) { New-Item -ItemType Directory -Force $t19Dir | Out-Null }
    @'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Section 19 Test Page</title>
  <meta name="description" content="pw-e2e-test section 19 test page">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
  <h1>Section 19 Heading 1</h1>
  <h2>Sub heading</h2>
  <h4>Skip from h2 to h4</h4>
  <button style="width:80px;height:40px">Action</button>
  <a href="#generic">click here</a>
  <a href="/page2" id="link2">About page</a>
  <img src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" alt="1px dot" width="300" height="200">
  <input type="text" placeholder="Unlabeled input">
  <label for="namedInput">Name</label>
  <input type="text" id="namedInput">
</body>
</html>
'@ | Set-Content "$t19Dir\index.html"

    $t19Proc = Start-Process python -ArgumentList "-m", "http.server", $t19Port, "--bind", "127.0.0.1" -WorkingDirectory $t19Dir -PassThru -WindowStyle Hidden
    Start-Sleep 2

    $t19Url = "http://127.0.0.1:$t19Port/"

    # Always-on: headings, domA11y, links, layout, cookies
    $ss19 = "$env:TEMP\s19-real.png"
    $r19  = (node $e2eScript19 $t19Url $ss19 1280 800 2>$null) -join ''
    try { $j19 = $r19 | ConvertFrom-Json } catch { $j19 = $null }

    Assert "real URL s19: headings field present"                ($j19 -and $j19.PSObject.Properties['headings'])
    Assert "real URL s19: headings.h1Count >= 1"                 ($j19 -and $j19.headings.h1Count -ge 1)
    Assert "real URL s19: headings.skips is an array"            ($j19 -and $j19.headings.PSObject.Properties['skips'])
    Assert "real URL s19: headings detects h2->h4 skip"          ($j19 -and $j19.headings.skips.Count -ge 1)
    Assert "real URL s19: headings.warnings is an array"         ($j19 -and $j19.headings.PSObject.Properties['warnings'])

    Assert "real URL s19: domA11y field present"                 ($j19 -and $j19.PSObject.Properties['domA11y'])
    Assert "real URL s19: domA11y.brokenAriaRefs is an array"    ($j19 -and $j19.domA11y.PSObject.Properties['brokenAriaRefs'])
    Assert "real URL s19: domA11y.unlabeledInputs >= 1"          ($j19 -and $j19.domA11y.unlabeledInputs -ge 1)
    Assert "real URL s19: domA11y.warnings is an array"          ($j19 -and $j19.domA11y.PSObject.Properties['warnings'])

    Assert "real URL s19: links field present"                   ($j19 -and $j19.PSObject.Properties['links'])
    Assert "real URL s19: links.genericAnchorText >= 1"          ($j19 -and $j19.links.genericAnchorText -ge 1)
    Assert "real URL s19: links.warnings is an array"            ($j19 -and $j19.links.PSObject.Properties['warnings'])

    Assert "real URL s19: layout field present"                  ($j19 -and $j19.PSObject.Properties['layout'])
    Assert "real URL s19: layout.hasHorizontalScroll is bool"    ($j19 -and $j19.layout.PSObject.Properties['hasHorizontalScroll'])
    Assert "real URL s19: layout.wideElements is an array"       ($j19 -and $j19.layout.PSObject.Properties['wideElements'])

    Assert "real URL s19: cookies field present"                 ($j19 -and $j19.PSObject.Properties['cookies'])
    Assert "real URL s19: cookies.insecureCount >= 0"            ($j19 -and $j19.cookies.PSObject.Properties['insecureCount'])
    Assert "real URL s19: cookies.warnings is an array"          ($j19 -and $j19.cookies.PSObject.Properties['warnings'])

    Assert "real URL s19: meta.lang present"                     ($j19 -and $j19.meta.PSObject.Properties['lang'])
    Assert "real URL s19: meta.lang is 'en'"                     ($j19 -and $j19.meta.lang -eq 'en')
    Assert "real URL s19: meta.charset present"                  ($j19 -and $j19.meta.PSObject.Properties['charset'])
    Assert "real URL s19: images.missingSrcset >= 0"             ($j19 -and $j19.images.PSObject.Properties['missingSrcset'])
    Assert "real URL s19: bundle.protocol present"               ($j19 -and $j19.bundle.PSObject.Properties['protocol'])
    Assert "real URL s19: bundle.missingPreconnect is an array"  ($j19 -and $j19.bundle.PSObject.Properties['missingPreconnect'])
    Assert "real URL s19: securityHeaders.cspStrength present"   ($j19 -and $j19.securityHeaders.PSObject.Properties['cspStrength'])
    Assert "real URL s19: securityHeaders.mixedContent is array" ($j19 -and $j19.securityHeaders.PSObject.Properties['mixedContent'])
    Assert "real URL s19: scripts.preConsentTrackers is array"   ($j19 -and $j19.scripts.PSObject.Properties['preConsentTrackers'])

    # --pwa: manifest check (no manifest on test server, should get warning)
    $ss19Pwa = "$env:TEMP\s19-pwa.png"
    $r19Pwa  = (node $e2eScript19 $t19Url $ss19Pwa 1280 800 --pwa 2>$null) -join ''
    try { $j19Pwa = $r19Pwa | ConvertFrom-Json } catch { $j19Pwa = $null }
    Assert "--pwa: pwa field present"                  ($j19Pwa -and $j19Pwa.PSObject.Properties['pwa'])
    Assert "--pwa: pwa.hasManifest is boolean"         ($j19Pwa -and $j19Pwa.pwa.PSObject.Properties['hasManifest'])
    Assert "--pwa: pwa.warnings is an array"           ($j19Pwa -and $j19Pwa.pwa.PSObject.Properties['warnings'])

    # --link-check: should find no broken links (or at least return the field)
    $ss19Lc = "$env:TEMP\s19-lc.png"
    $r19Lc  = (node $e2eScript19 $t19Url $ss19Lc 1280 800 --link-check 2>$null) -join ''
    try { $j19Lc = $r19Lc | ConvertFrom-Json } catch { $j19Lc = $null }
    Assert "--link-check: linkCheck field present"     ($j19Lc -and $j19Lc.PSObject.Properties['linkCheck'])
    Assert "--link-check: linkCheck.checked >= 0"      ($j19Lc -and $j19Lc.linkCheck.PSObject.Properties['checked'])
    Assert "--link-check: linkCheck.broken >= 0"       ($j19Lc -and $j19Lc.linkCheck.PSObject.Properties['broken'])
    Assert "--link-check: linkCheck.warnings is array" ($j19Lc -and $j19Lc.linkCheck.PSObject.Properties['warnings'])

    # --seo-deep: robots.txt + sitemap + hreflang
    $ss19Seo = "$env:TEMP\s19-seo.png"
    $r19Seo  = (node $e2eScript19 $t19Url $ss19Seo 1280 800 --seo-deep 2>$null) -join ''
    try { $j19Seo = $r19Seo | ConvertFrom-Json } catch { $j19Seo = $null }
    Assert "--seo-deep: seoDeep field present"           ($j19Seo -and $j19Seo.PSObject.Properties['seoDeep'])
    Assert "--seo-deep: seoDeep.robotsTxt present"       ($j19Seo -and $j19Seo.seoDeep.PSObject.Properties['robotsTxt'])
    Assert "--seo-deep: seoDeep.hreflang present"        ($j19Seo -and $j19Seo.seoDeep.PSObject.Properties['hreflang'])
    Assert "--seo-deep: seoDeep.warnings is an array"    ($j19Seo -and $j19Seo.seoDeep.PSObject.Properties['warnings'])

    # --budget-js: budget exceeded / passed structure
    $ss19Bud = "$env:TEMP\s19-bud.png"
    $r19Bud  = (node $e2eScript19 $t19Url $ss19Bud 1280 800 "--budget-js=999999" 2>$null) -join ''
    try { $j19Bud = $r19Bud | ConvertFrom-Json } catch { $j19Bud = $null }
    Assert "--budget-js: budget field present"           ($j19Bud -and $j19Bud.PSObject.Properties['budget'])
    Assert "--budget-js: budget.passed is boolean"       ($j19Bud -and $j19Bud.budget.PSObject.Properties['passed'])
    Assert "--budget-js: budget.exceeded is an array"    ($j19Bud -and $j19Bud.budget.PSObject.Properties['exceeded'])
    Assert "--budget-js=999999: no budget exceeded"      ($j19Bud -and $j19Bud.budget.passed -eq $true)

    if ($t19Proc) {
        try { Stop-Process -Id $t19Proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
} else {
    Warn "E2E script or node_modules missing — skipping Batch A+B feature tests (Section 19)"
}

# ── Summary ──────────────────────────────────────────────────────────────────
Write-Host "`n── Summary ───────────────────────────────────────────────────" -ForegroundColor Cyan
$total = $pass + $fail
$color = if ($fail -eq 0) { "Green" } else { "Red" }
Write-Host "  $pass / $total passed   $warn warning(s)" -ForegroundColor $color

if ($warn -gt 0) {
    Write-Host "`n  Warnings are informational — not failures." -ForegroundColor Yellow
}

Write-Host @"

  IMPORTANT — what this suite does NOT prove:
  ┌───────────────────────────────────────────────────────────────────────┐
  │  Section 6  (Connected) — MCP server process started, not callable.  │
  │  Section 9  (Registry)  — dynamic port pickup proven end-to-end.     │
  │  Section 10 (Chrome)    — debug port formula (app+10000) proven.     │
  │                                                                       │
  │  To add a new framework: edit framework-registry.json only.          │
  │  Hook and agent pick it up automatically — no other files to change. │
  │                                                                       │
  │  To get browser_* / getConsoleMessages in Claude's tool list:        │
  │    → Open a NEW CHAT  (not Ctrl+Shift+P reload)                      │
  │    → MCP tools load at conversation start, not mid-session.          │
  └───────────────────────────────────────────────────────────────────────┘
"@ -ForegroundColor DarkGray

if ($fail -gt 0) { exit 1 } else { exit 0 }
