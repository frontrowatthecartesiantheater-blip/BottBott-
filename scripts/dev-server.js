// Local dev server: serves the static site AND runs the api/ handlers the
// same way Vercel does (default-exported (req, res) functions). Lets the
// admin UI be exercised end to end without deploying.
//
// Usage:
//   ADMIN_MOCK=1 node scripts/dev-server.js          (mock data, no creds)
//   node scripts/dev-server.js                        (real creds from .env)
//
// In mock mode the role comes from ?role=creator|editor on first load, stored
// in a cookie the dev server reads back as the x-mock-role header. This is
// dev-only plumbing; production uses real Google OAuth sessions.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 3000;
// Mock mode via env var OR --mock flag (the flag is cross-platform on Windows).
const MOCK = process.env.ADMIN_MOCK === '1' || process.argv.includes('--mock');
if (MOCK) process.env.ADMIN_MOCK = '1'; // handlers read the env var

try { process.loadEnvFile(); } catch { /* mock mode needs no .env */ }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  // cleanUrls parity: /blog/foo -> /blog/foo.html when no extension
  let filePath = path.join(repoRoot, rel);
  if (!path.extname(filePath)) {
    try { await stat(`${filePath}.html`); filePath += '.html'; } catch { /* fall through */ }
  }
  if (!filePath.startsWith(repoRoot)) { res.statusCode = 403; return res.end('forbidden'); }
  try {
    const body = await readFile(filePath);
    res.setHeader('content-type', MIME[path.extname(filePath)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}

// Map /api/<segments> to api/<segments>.js
async function routeApi(req, res, urlPath) {
  const clean = urlPath.split('?')[0].replace(/\/$/, '');
  const handlerPath = path.join(repoRoot, `${clean}.js`);
  if (!handlerPath.startsWith(path.join(repoRoot, 'api'))) { res.statusCode = 403; return res.end('forbidden'); }

  // Dev-only mock role plumbing.
  if (MOCK) {
    const url = new URL(req.url, 'http://local');
    const roleFromQuery = url.searchParams.get('role');
    const cookieRole = (req.headers.cookie || '').match(/mock_role=(\w+)/)?.[1];
    const role = roleFromQuery || cookieRole || 'editor';
    req.headers['x-mock-role'] = role;
  }

  try {
    const mod = await import(`file://${handlerPath}?t=${Date.now()}`); // bust cache for edits
    await mod.default(req, res);
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') { res.statusCode = 404; return res.end('no such endpoint'); }
    console.error(`api error on ${clean}:`, err);
    if (!res.headersSent) { res.statusCode = 500; res.setHeader('content-type', 'application/json'); }
    res.end(JSON.stringify({ error: err.message }));
  }
}

createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // In mock mode, set the role cookie so reloads keep the chosen role.
  if (MOCK && urlPath === '/admin/') {
    const role = new URL(req.url, 'http://local').searchParams.get('role');
    if (role) res.setHeader('set-cookie', `mock_role=${role}; Path=/`);
  }

  if (urlPath.startsWith('/api/')) return routeApi(req, res, urlPath);
  return serveStatic(req, res, urlPath);
}).listen(PORT, () => {
  console.log(`dev server on http://localhost:${PORT}  (ADMIN_MOCK=${MOCK ? '1' : '0'})`);
  if (MOCK) {
    console.log('  editor view:  http://localhost:' + PORT + '/admin/?role=editor');
    console.log('  creator view: http://localhost:' + PORT + '/admin/?role=creator');
  }
});
