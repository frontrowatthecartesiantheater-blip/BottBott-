// Google OAuth sign-in for /admin. One endpoint, two phases:
//   GET /api/auth/google           → 302 to Google's consent screen
//   GET /api/auth/google?code=...  → exchange code, check whitelist,
//                                    set session cookie, 302 to /admin/
//
// Setup note: the Google Cloud OAuth client must list
// <deployment-origin>/api/auth/google as an authorized redirect URI.

import { WHITELIST } from '../../lib/admin-auth.js';
import { createSessionCookie } from '../../lib/session.js';
import { redirect, sendHtml, getQuery, getBaseUrl } from '../../lib/http.js';

export default async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return sendHtml(res, 500, '<p>OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing).</p>');
  }

  const redirectUri = `${getBaseUrl(req)}/api/auth/google`;
  const { code, error } = getQuery(req);

  if (error) return sendHtml(res, 400, `<p>Sign-in cancelled (${error}). <a href="/admin/">Back</a></p>`);

  if (!code) {
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid email');
    authUrl.searchParams.set('prompt', 'select_account');
    return redirect(res, authUrl.toString());
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    return sendHtml(res, 502, '<p>Google token exchange failed. <a href="/api/auth/google">Try again</a></p>');
  }

  // The id_token arrives directly from Google over TLS, so its payload is
  // trusted here without local signature verification.
  const { id_token: idToken } = await tokenRes.json();
  const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
  const email = (claims.email || '').toLowerCase();

  if (!claims.email_verified || !WHITELIST[email]) {
    return sendHtml(res, 403, `
      <main style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center">
        <h1>403</h1>
        <p>${email || 'This account'} does not have access to this dashboard.</p>
      </main>`);
  }

  res.setHeader('set-cookie', createSessionCookie({ email, role: WHITELIST[email] }));
  return redirect(res, '/admin/');
}
