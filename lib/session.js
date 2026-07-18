// Signed session cookies. HMAC-SHA256 over a base64url JSON payload using
// SESSION_SECRET; no session store needed. Standard library only, portable
// between the local dev server and Vercel's Node runtime.

import crypto from 'node:crypto';

const COOKIE_NAME = 'admin_session';
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return secret;
}

function sign(data) {
  return crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
}

export function createSessionCookie({ email, role }) {
  const payload = Buffer.from(
    JSON.stringify({ email, role, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS }),
  ).toString('base64url');
  const value = `${payload}.${sign(payload)}`;
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
}

/** Returns { email, role } or null. */
export function readSession(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  const [payload, signature] = match[1].split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!session.exp || session.exp < Date.now() / 1000) return null;
    return { email: session.email, role: session.role };
  } catch {
    return null;
  }
}
