#Requires -Version 7
# install.ps1 — Claude UI Monitor installer
# Run from the repo root: pwsh -File install.ps1
#
# What this does:
#   1. Copies scripts, agents, registry, and config files to ~/.claude/
#   2. Merges the PostToolUse hook into ~/.claude/settings.json
#   3. Merges MCP server entries into ~/.claude.json
#   4. Appends UI Monitor instructions to ~/.claude/CLAUDE.md
#   5. Installs npm dependencies and Playwright Chromium
#   6. Installs stylelint globally
#
# Safe to re-run — all steps are idempotent.

$ErrorActionPreference = 'Stop'
$repoRoot   = $PSScriptRoot
$claudeDir  = Join-Path $env:USERPROFILE '.claude'
$ok   = 'Green'
$skip = 'DarkGray'
$warn = 'Yellow'

function Step($msg) { Write-Host "  $msg" }
function OK($msg)   { Write-Host "  [+] $msg" -ForegroundColor $ok }
function Skip($msg) { Write-Host "  [-] $msg" -ForegroundColor $skip }
function Warn($msg) { Write-Host "  [!] $msg" -ForegroundColor $warn }

Write-Host "`n=== Claude UI Monitor — Installer ===" -ForegroundColor Cyan
Write-Host "    Installing to: $claudeDir`n"

# ── 1. Scripts ────────────────────────────────────────────────────────────────
$targetScripts = Join-Path $claudeDir 'scripts'
if (-not (Test-Path $targetScripts)) { New-Item -ItemType Directory -Path $targetScripts | Out-Null }
Get-ChildItem (Join-Path $repoRoot 'scripts') -File |
    Where-Object { $_.Name -ne 'node_modules' } |
    ForEach-Object { Copy-Item $_.FullName -Destination $targetScripts -Force }
OK "Scripts copied to $targetScripts"

# ── 2. Agents ─────────────────────────────────────────────────────────────────
$targetAgents = Join-Path $claudeDir 'agents'
if (-not (Test-Path $targetAgents)) { New-Item -ItemType Directory -Path $targetAgents | Out-Null }
Copy-Item (Join-Path $repoRoot 'agents\*') -Destination $targetAgents -Force
OK "Agents copied to $targetAgents"

# ── 3. framework-registry.json (always update — tool-maintained) ──────────────
Copy-Item (Join-Path $repoRoot 'framework-registry.json') -Destination $claudeDir -Force
OK "framework-registry.json updated"

# ── 4. project-registry.json (create from template only if absent) ────────────
$projReg = Join-Path $claudeDir 'project-registry.json'
if (-not (Test-Path $projReg)) {
    Copy-Item (Join-Path $repoRoot 'project-registry.template.json') -Destination $projReg
    OK "project-registry.json created — edit it to add your projects"
} else {
    Skip "project-registry.json already exists — not overwritten"
}

# ── 5. .stylelintrc.json ──────────────────────────────────────────────────────
Copy-Item (Join-Path $repoRoot '.stylelintrc.json') -Destination $claudeDir -Force
OK ".stylelintrc.json updated"

# ── 6. .env (create from example only if absent) ─────────────────────────────
$envFile = Join-Path $claudeDir '.env'
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $repoRoot '.env.example') -Destination $envFile
    OK ".env created from template — add your API keys"
} else {
    Skip ".env already exists — not overwritten"
}

# ── 7. ui-screenshots dir ────────────────────────────────────────────────────
$ssDir = Join-Path $claudeDir 'ui-screenshots'
if (-not (Test-Path $ssDir)) {
    New-Item -ItemType Directory -Path $ssDir | Out-Null
    OK "ui-screenshots/ directory created"
} else {
    Skip "ui-screenshots/ already exists"
}

# ── 8. CLAUDE.md — append UI Monitor section if not already present ───────────
$claudeMd     = Join-Path $claudeDir 'CLAUDE.md'
$repoMd       = Get-Content (Join-Path $repoRoot 'CLAUDE.md') -Raw
$monitorMark  = '## Autonomous UI Monitor'

if (-not (Test-Path $claudeMd)) {
    Set-Content -Path $claudeMd -Value $repoMd -Encoding UTF8
    OK "CLAUDE.md created"
} elseif ((Get-Content $claudeMd -Raw) -notmatch [regex]::Escape($monitorMark)) {
    Add-Content -Path $claudeMd -Value "`n$repoMd" -Encoding UTF8
    OK "UI Monitor section appended to existing CLAUDE.md"
} else {
    Skip "CLAUDE.md already contains UI Monitor section"
}

# ── 9. settings.json — merge PostToolUse hook ─────────────────────────────────
$settingsPath = Join-Path $claudeDir 'settings.json'
$hookCommand  = "pwsh -NonInteractive -File `"$claudeDir\scripts\ui-check.ps1`""

# Use Node.js for safe JSON merge (avoids PowerShell depth/type issues)
$mergeHook = @"
const fs = require('fs');
const p = process.argv[2];
let s = {};
try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
s.hooks = s.hooks || {};
s.hooks.PostToolUse = s.hooks.PostToolUse || [];
const cmd = process.argv[3];
const already = s.hooks.PostToolUse.some(e => (e.hooks || []).some(h => h.command && h.command.includes('ui-check.ps1')));
if (!already) {
  s.hooks.PostToolUse.push({
    matcher: 'Edit|Write',
    hooks: [{ type: 'command', command: cmd, timeout: 10, statusMessage: 'UI monitor checking...' }]
  });
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
  process.exit(0);
} else {
  process.exit(42);
}
"@

$result = node -e $mergeHook -- $settingsPath $hookCommand 2>&1
if ($LASTEXITCODE -eq 0)  { OK "PostToolUse hook added to settings.json" }
elseif ($LASTEXITCODE -eq 42) { Skip "Hook already registered in settings.json" }
else { Warn "settings.json merge failed: $result" }

# ── 10. .claude.json — merge MCP servers ─────────────────────────────────────
$dotClaudeJson = Join-Path $env:USERPROFILE '.claude.json'
if (Test-Path $dotClaudeJson) {
    $mergeMcp = @'
const fs   = require('fs');
const p    = process.argv[2];
let d = {};
try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
d.mcpServers = d.mcpServers || {};
const toAdd = {
  playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  'chrome-devtools-mcp': { type: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
  figma: { type: 'stdio', command: 'npx', args: ['-y', '@figma/mcp'], env: { FIGMA_ACCESS_TOKEN: '' } }
};
let added = [];
for (const [k, v] of Object.entries(toAdd)) {
  if (!d.mcpServers[k]) { d.mcpServers[k] = v; added.push(k); }
}
if (added.length) fs.writeFileSync(p, JSON.stringify(d, null, 2));
process.stdout.write(added.join(','));
process.exit(0);
'@
    $added = node -e $mergeMcp -- $dotClaudeJson 2>&1
    if ($added) {
        OK "MCP servers added to .claude.json: $added"
    } else {
        Skip "All MCP servers already in .claude.json"
    }
} else {
    Warn ".claude.json not found — open Claude Code once, then re-run install.ps1 to register MCP servers"
}

# ── 11. npm install ───────────────────────────────────────────────────────────
Write-Host ""
Step "Installing npm dependencies..."
Push-Location (Join-Path $claudeDir 'scripts')
npm install --silent 2>&1 | Out-Null
Pop-Location
OK "npm install complete"

# ── 12. Playwright Chromium ───────────────────────────────────────────────────
Step "Installing Playwright Chromium..."
$env:PLAYWRIGHT_BROWSERS_PATH = 0   # use default per-package location
& node (Join-Path $claudeDir 'scripts\node_modules\.bin\playwright') install chromium 2>&1 | Out-Null
OK "Playwright Chromium installed"

# ── 13. Stylelint global ──────────────────────────────────────────────────────
Step "Installing stylelint globally..."
npm install -g stylelint stylelint-config-standard 2>&1 | Out-Null
OK "stylelint installed globally"

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host @"

=== Installation complete! ===

Next steps:
  1. Edit ~/.claude/project-registry.json  — add your projects (name, port, framework, path, start)
  2. Open a NEW Claude Code chat            — MCP servers (playwright, chrome-devtools-mcp) load at start
  3. Start your dev server, edit a UI file — the hook fires automatically

Optional (Figma design comparison):
  - Add FIGMA_ACCESS_TOKEN to ~/.claude/.env
  - Add the same token to mcpServers.figma.env.FIGMA_ACCESS_TOKEN in ~/.claude.json
  - Restart Claude Code

Verify install:  pwsh -File ~/.claude/scripts/audit-log.ps1 -Summary
Manual sweep:    pwsh -File ~/.claude/scripts/sweep-all.ps1
"@ -ForegroundColor Cyan
