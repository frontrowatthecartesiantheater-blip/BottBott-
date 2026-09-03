// Editor toggle and Settings-tab source management. Editor role only.
//
// GET returns { editor_toggle, sources }.
// POST {editor_toggle: "on"|"off"} sets the toggle — OFF makes the publish
//   cron auto-publish without review; the admin UI isn't involved on that path.
// POST ?action=add-source {domain} / ?action=remove-source {domain} manage
//   the link sweep's trusted-source allowlist (see lib/admin-data.js).

import { requireRole } from '../../lib/admin-auth.js';
import { sendJson, readJsonBody, getQuery } from '../../lib/http.js';
import {
  getEditorToggle, setEditorToggle,
  getAllowlistedSources, addAllowlistedSource, removeAllowlistedSource,
} from '../../lib/admin-data.js';

// A plain hostname: labels of letters/digits/hyphens, no scheme, no path, no
// port — matches how the link sweep normalizes a candidate URL's hostname
// (lib/links/domains.js domainOf()), so an entry here actually matches what
// the sweep looks up.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function normalizeDomain(raw) {
  return String(raw ?? '')
    .trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

export default async function handler(req, res) {
  const session = requireRole(req, res, ['editor']);
  if (!session) return;

  try {
    if (req.method === 'GET') {
      const [editorToggle, sources] = await Promise.all([getEditorToggle(), getAllowlistedSources()]);
      return sendJson(res, 200, { editor_toggle: editorToggle, sources });
    }
    if (req.method === 'POST') {
      const { action } = getQuery(req);

      if (action === 'add-source') {
        const { domain: raw } = await readJsonBody(req);
        const domain = normalizeDomain(raw);
        if (!domain || !DOMAIN_RE.test(domain)) {
          return sendJson(res, 400, { error: 'enter a plain domain, like example.com' });
        }
        const source = await addAllowlistedSource(domain);
        return sendJson(res, 200, { ok: true, source });
      }

      if (action === 'remove-source') {
        const { domain } = await readJsonBody(req);
        if (!domain) return sendJson(res, 400, { error: 'domain is required' });
        await removeAllowlistedSource(domain);
        return sendJson(res, 200, { ok: true });
      }

      const { editor_toggle: value } = await readJsonBody(req);
      if (value !== 'on' && value !== 'off') {
        return sendJson(res, 400, { error: 'editor_toggle must be "on" or "off"' });
      }
      await setEditorToggle(value);
      return sendJson(res, 200, { editor_toggle: value });
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}
