# Claude UI Monitor

Autonomous UI health monitoring for Claude Code. Every time you edit a frontend file while a dev server is running, Claude automatically takes desktop/mobile/tablet screenshots, runs Lighthouse, checks accessibility, and fixes what it finds — all without you asking.

## What it does

1. **Hook fires on save** — PostToolUse hook in Claude Code detects edits to frontend files
2. **Discovers the live server** — scans open TCP ports, identifies the framework automatically
3. **Screenshots 3 viewports** — desktop (1280×800), mobile (390×844), tablet (768×1024)
4. **Lighthouse audit** — performance, accessibility, best practices, SEO (before and after any fix)
5. **Accessibility** — axe-core violations on every screenshot run
6. **Console + network errors** — flags JS errors, 4xx/5xx via chrome-devtools MCP
7. **Fixes and re-screenshots** — edits source files, confirms visually
8. **Audit log** — every run appended to `~/.claude/ui-audit-log.jsonl`
9. **Figma comparison** (optional) — diff live UI against Figma designs at the pixel level

Works on **17 frameworks** out of the box: Angular, React, Vue, Svelte/SvelteKit, Next.js, Nuxt, Remix, Astro, Vite, Flask, Streamlit, FastAPI, Gradio, Panel, Solara, and more. Unknown frameworks are identified and auto-registered.

## Prerequisites

- Windows 10/11 with PowerShell 7+ (`winget install Microsoft.PowerShell`)
- [Claude Code](https://claude.ai/code) (CLI or desktop app)
- Node.js 18+ (`winget install OpenJS.NodeJS`)
- At least one free LLM API key for the AI browser fallback:
  - [Groq](https://console.groq.com) (recommended — fast and free)
  - OR [OpenAI](https://platform.openai.com) or [Anthropic](https://console.anthropic.com)

## Install

```powershell
git clone https://github.com/YOUR_USERNAME/claude-ui-monitor.git
cd claude-ui-monitor
pwsh -File install.ps1
```

The installer is idempotent — safe to re-run after updates.

After installing:
1. Edit `~/.claude/project-registry.json` — add your projects
2. Open a **new** Claude Code chat — MCP servers load at conversation start
3. Start your dev server, edit a frontend file — the hook fires automatically

## Adding a project

Edit `~/.claude/project-registry.json`:

```json
{
  "projects": [
    {
      "name": "My App",
      "path": "C:\\Users\\yourname\\my-app",
      "framework": "React",
      "port": 3000,
      "start": "npm run dev",
      "routes": null
    }
  ]
}
```

`routes` options:
- `null` — check homepage only (default)
- `"auto"` — discover and check all routes/tabs automatically
- `["/", "/about", "/dashboard"]` — check specific pages

## Configuration

| File | Purpose |
|---|---|
| `~/.claude/project-registry.json` | Your projects (paths, ports, start commands) |
| `~/.claude/framework-registry.json` | Framework fingerprints and nav strategies (tool-managed) |
| `~/.claude/.env` | API keys (LLM for Stagehand, Figma token) |
| `~/.claude/ui-audit-log.jsonl` | Audit history (one JSON line per run) |

## Commands

```powershell
# View audit history
pwsh -File ~/.claude/scripts/audit-log.ps1 -Summary

# Manual sweep of all live projects
pwsh -File ~/.claude/scripts/sweep-all.ps1

# Manual sweep with auto-fix
pwsh -File ~/.claude/scripts/sweep-all.ps1 -Fix

# Screenshot a URL manually
node ~/.claude/scripts/pw-e2e-test.js http://localhost:3000 out.png 1280 800

# Multi-page screenshot
node ~/.claude/scripts/pw-e2e-test.js http://localhost:3000 out 1280 800 --routes=auto --nav=link-crawl

# Schedule automatic nightly sweeps
pwsh -File ~/.claude/scripts/schedule-sweep.ps1
```

## Figma integration (optional, Starter plan compatible)

1. Figma → Settings → Security → Personal access tokens → create with `file_content:read` scope
2. Add `FIGMA_ACCESS_TOKEN=your_token` to `~/.claude/.env`
3. Add the same token to `mcpServers.figma.env.FIGMA_ACCESS_TOKEN` in `~/.claude.json`
4. Restart Claude Code — `figma_get_screenshot` appears in the tool list
5. Install free **Tokens Studio** plugin in Figma → export tokens → save to `~/.claude/design-tokens.json`

```powershell
# List all frames in a Figma file
node ~/.claude/scripts/figma-baseline.js --file=YOUR_FILE_KEY --list

# Export specific frames as PNG baselines
node ~/.claude/scripts/figma-baseline.js --file=YOUR_FILE_KEY --nodes=ID1,ID2

# Compare live app CSS against design tokens
node ~/.claude/scripts/figma-token-check.js http://localhost:3000 --tokens=~/.claude/design-tokens.json
```

## How it works

```
Edit frontend file
      │
      ▼
ui-check.ps1 (PostToolUse hook, <10s)
      │  Scans open TCP ports
      │  Identifies framework via fingerprints
      │  Emits JSON trigger → Claude's context
      ▼
Claude executes 12-step protocol
      │  Lighthouse before
      │  Screenshots: desktop / mobile / tablet
      │  Console errors, network failures
      │  Accessibility (axe-core)
      │  [Figma diff if token set]
      │  Fix issues in source files
      │  Lighthouse after
      │  Re-screenshot
      │  Write audit log entry
      ▼
      Done (2-sentence summary)
```

MCP servers (playwright, chrome-devtools-mcp, figma) provide browser control. The Node.js scripts (`pw-e2e-test.js`) are the fallback when MCP tools aren't available mid-session.

## Codex / other agents

The Node.js scripts work on any platform and can be called manually or from CI:

```bash
node scripts/pw-e2e-test.js http://localhost:3000 out.png
node scripts/figma-baseline.js --file=KEY --list
node scripts/figma-token-check.js http://localhost:3000
```

The automatic hook and CLAUDE.md protocol are Claude Code-specific.

## Updating

```powershell
cd claude-ui-monitor
git pull
pwsh -File install.ps1   # re-run installer — safe, idempotent
```

`framework-registry.json` is always updated on install. Your `project-registry.json` and `.env` are never overwritten.

## License

MIT
