// Whitelist + role guard for the admin API.
//
// Roles:
//   creator — (legacy) record-only view; no longer assigned. Kept defined so
//             the role type stays valid if it is reintroduced later.
//   editor  — everything (Record, Review, Add Content)
//
// Access was flattened: both whitelisted accounts now map to 'editor' so they
// get identical access to all three tabs. The whitelist membership is
// unchanged — both emails (client-config.js) are still required to log in.
//
// ADMIN_MOCK=1 (local dev server only, never set in Vercel) bypasses the
// cookie and takes the role from the x-mock-role header so the UI can be
// exercised without Google credentials.

import { readSession } from './session.js';
import { sendJson } from './http.js';
import { isMock } from './mock.js';
import { CLIENT } from './client-config.js';

export const WHITELIST = {
  [CLIENT.creatorGoogleAccount]: 'editor',
  [CLIENT.editorGoogleAccount]: 'editor',
};

export function getSession(req) {
  if (isMock()) {
    const role = req.headers['x-mock-role'] === 'creator' ? 'creator' : 'editor';
    return { email: `mock-${role}@local`, role };
  }
  const session = readSession(req);
  if (!session) return null;
  // Re-derive the role from the whitelist on every request rather than trusting
  // the role baked into the cookie at login. This makes whitelist/role changes
  // take effect immediately for existing sessions (no re-login needed), and an
  // email removed from the whitelist loses access at once.
  const role = WHITELIST[session.email];
  if (!role) return null;
  return { email: session.email, role };
}

/** Returns the session, or responds 401/403 and returns null. */
export function requireRole(req, res, roles) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'not signed in' });
    return null;
  }
  if (!roles.includes(session.role)) {
    sendJson(res, 403, { error: 'not allowed for this role' });
    return null;
  }
  return session;
}
