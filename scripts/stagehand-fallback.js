/**
 * Stagehand fallback for dynamic DOMs — use when Playwright selectors fail on
 * heavily dynamic SPAs, shadow DOM components, or canvas-rendered UIs.
 *
 * Priority order for LLM provider (first key found wins):
 *   1. ANTHROPIC_API_KEY  → Claude claude-sonnet-4-5 (best tool-use reliability)
 *   2. GROQ_API_KEY       → openai/gpt-oss-120b via Groq's OpenAI-compatible API
 *   3. OPENAI_API_KEY     → gpt-4o
 *   4. BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID → Browserbase cloud (no local LLM key needed)
 *
 * Usage:
 *   node stagehand-fallback.js <url> "<task description>"
 *
 * Examples:
 *   node stagehand-fallback.js http://localhost:5173 "click the login button and check for errors"
 *   node stagehand-fallback.js http://localhost:8501 "check if the DataFrame table rendered correctly"
 */
const { Stagehand } = require('@browserbasehq/stagehand');
const { z }         = require('zod');
const path          = require('path');

// Load .env from ~/.claude/.env — dotenv is now in package.json so require always resolves
require('dotenv').config({ path: path.join(process.env.USERPROFILE, '.claude', '.env') });

const [,, url, task = 'screenshot the page and check for visible errors'] = process.argv;

if (!url) {
  console.error('Usage: node stagehand-fallback.js <url> "<task>"');
  process.exit(1);
}

function resolveProvider() {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      modelName: 'claude-sonnet-4-5',
      modelClientOptions: { apiKey: process.env.ANTHROPIC_API_KEY },
    };
  }
  if (process.env.GROQ_API_KEY) {
    // Groq is OpenAI-compatible — use the OpenAI provider pointed at Groq's endpoint.
    // openai/gpt-oss-120b: Groq's recommended replacement for llama-3.3-70b-versatile
    //   (deprecated Aug 16 2026), strongest tool-calling reliability on Groq.
    // Alternative: qwen/qwen3.6-27b — faster and cheaper, also supports parallel tool use.
    return {
      modelName: 'openai/gpt-oss-120b',
      modelClientOptions: {
        apiKey: process.env.GROQ_API_KEY,
        baseURL: 'https://api.groq.com/openai/v1',
      },
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      modelName: 'gpt-4o',
      modelClientOptions: { apiKey: process.env.OPENAI_API_KEY },
    };
  }
  if (process.env.BROWSERBASE_API_KEY) {
    return null; // cloud mode — no local LLM needed
  }
  throw new Error(
    'No LLM key found. Set ANTHROPIC_API_KEY, GROQ_API_KEY, OPENAI_API_KEY, or BROWSERBASE_API_KEY.'
  );
}

(async () => {
  const useBrowserbase = !!process.env.BROWSERBASE_API_KEY && !process.env.ANTHROPIC_API_KEY
                      && !process.env.GROQ_API_KEY && !process.env.OPENAI_API_KEY;
  const provider = useBrowserbase ? null : resolveProvider();

  console.log(`  Provider: ${provider ? provider.modelName : 'Browserbase cloud'}`);

  const stagehand = new Stagehand({
    env: useBrowserbase ? 'BROWSERBASE' : 'LOCAL',
    verbose: 1,
    debugDom: false,
    ...(useBrowserbase ? {
      apiKey: process.env.BROWSERBASE_API_KEY,
      projectId: process.env.BROWSERBASE_PROJECT_ID,
    } : {
      localChromium: true,
    }),
    ...(provider ?? {}),
  });

  await stagehand.init();
  const page = stagehand.page;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // Screenshot first
  const screenshotPath = path.join(
    process.env.USERPROFILE, '.claude', 'ui-screenshots',
    `stagehand-${Date.now()}.png`
  );
  await page.screenshot({ path: screenshotPath });
  console.log(`Screenshot: ${screenshotPath}`);

  // Execute the task using Stagehand AI reasoning
  const result = await stagehand.act({ action: task });
  console.log('Task result:', JSON.stringify(result, null, 2));

  // Extract visible errors or issues — Stagehand 2+ requires a Zod schema
  const IssuesSchema = z.object({ issues: z.array(z.string()) });
  const issues = await stagehand.extract({
    instruction: 'Extract any visible error messages, broken UI elements, or UI issues',
    schema: IssuesSchema,
  });
  console.log('Issues found:', JSON.stringify(issues, null, 2));

  await stagehand.close();
  process.stdout.write(JSON.stringify({ ok: true, url, screenshot: screenshotPath, result, issues }) + '\n');
})().catch(e => {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
  process.exit(1);
});
