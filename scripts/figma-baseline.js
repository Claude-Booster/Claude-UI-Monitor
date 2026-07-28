// figma-baseline.js — Export Figma frames as PNG baselines for design-vs-live comparison.
//
// Usage:
//   node figma-baseline.js --file=<fileKey> --nodes=<id1,id2,...> [--out=<dir>] [--scale=2]
//   node figma-baseline.js --file=<fileKey> --list                   # list all top-level frames
//
// Requires FIGMA_ACCESS_TOKEN in ~/.claude/.env  (Figma → Settings → Security → Access tokens)
// File key is the alphanumeric ID in your Figma URL: figma.com/design/<FILE_KEY>/...
//
// Output: PNG files saved to <out>/<sanitised-frame-name>.png  (default: ~/.claude/ui-screenshots/figma/)
//         stdout: JSON array of { name, nodeId, file } entries

const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { URL } = require('url');

// Load .env from ~/.claude/.env
const envPath = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  });
}

// ── Argument parsing ─────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const eq = a.indexOf('=');
      return eq === -1 ? [a.slice(2), 'true'] : [a.slice(2, eq), a.slice(eq + 1)];
    })
);

const TOKEN    = process.env.FIGMA_ACCESS_TOKEN || '';
const fileKey  = args['file'] || process.env.FIGMA_FILE_KEY || '';
const nodeArg  = args['nodes'] || '';
const outDir   = args['out']   || path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'ui-screenshots', 'figma');
const scale    = parseFloat(args['scale'] || '2');
const listMode = args['list'] === 'true';

if (!TOKEN) {
  process.stderr.write('ERROR: FIGMA_ACCESS_TOKEN not set. Add it to ~/.claude/.env\n');
  process.exit(1);
}
if (!fileKey) {
  process.stderr.write('ERROR: --file=<key> required (the ID from your Figma URL)\n');
  process.exit(1);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function figmaGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.figma.com',
      path,
      method:  'GET',
      headers: { 'X-Figma-Token': TOKEN },
    };
    https.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Figma API ${res.statusCode}: ${data.slice(0, 200)}`));
        } else {
          resolve(JSON.parse(data));
        }
      });
    }).on('error', reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const u    = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: {} }, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        download(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

function slug(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').slice(0, 60).toLowerCase();
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  if (listMode) {
    // List all top-level frames in the file
    const file = await figmaGet(`/v1/files/${fileKey}?depth=1`);
    const pages = file.document?.children || [];
    const frames = [];
    for (const page of pages) {
      for (const node of page.children || []) {
        if (['FRAME', 'COMPONENT', 'COMPONENT_SET'].includes(node.type)) {
          frames.push({ page: page.name, name: node.name, id: node.id });
        }
      }
    }
    process.stdout.write(JSON.stringify(frames, null, 2) + '\n');
    return;
  }

  if (!nodeArg) {
    process.stderr.write('ERROR: --nodes=<id1,id2> or --list required\n');
    process.exit(1);
  }

  const nodeIds = nodeArg.split(',').map(n => n.trim()).filter(Boolean);

  // Fetch node metadata to get frame names
  const meta = await figmaGet(`/v1/files/${fileKey}/nodes?ids=${nodeIds.join(',')}`);

  // Fetch rendered image URLs
  const imgData = await figmaGet(
    `/v1/images/${fileKey}?ids=${nodeIds.join(',')}&format=png&scale=${scale}`
  );
  if (imgData.err) throw new Error(`Image export error: ${imgData.err}`);

  const results = [];
  for (const nodeId of nodeIds) {
    const nodeInfo = meta.nodes?.[nodeId]?.document;
    const name     = nodeInfo?.name || nodeId;
    const imgUrl   = imgData.images?.[nodeId];
    if (!imgUrl) {
      process.stderr.write(`WARN: no image URL for node ${nodeId}\n`);
      continue;
    }

    const fileName = `${slug(name)}.png`;
    const filePath = path.join(outDir, fileName);
    await download(imgUrl, filePath);
    results.push({ name, nodeId, file: filePath });
    process.stderr.write(`  Saved: ${filePath}\n`);
  }

  process.stdout.write(JSON.stringify(results) + '\n');
})().catch(e => {
  process.stderr.write(`ERROR: ${e.message}\n`);
  process.exit(1);
});
