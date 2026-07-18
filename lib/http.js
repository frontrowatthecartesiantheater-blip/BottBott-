// Minimal request/response helpers using only standard Node APIs, so the
// same api/ handlers run under Vercel's Node runtime and the local dev
// server (scripts/dev-server.js) unchanged.

export function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

export function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
}

export function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('location', location);
  res.end();
}

/** Parse the JSON body. Uses req.body if the runtime already parsed it
 * (Vercel does for application/json), otherwise reads the stream. */
export async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export function getQuery(req) {
  return Object.fromEntries(new URL(req.url, 'http://local').searchParams);
}

/** Base URL of the current deployment, for OAuth redirect URIs. */
export function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
