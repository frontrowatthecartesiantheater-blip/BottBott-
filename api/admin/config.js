// Editor toggle. GET returns it; POST {editor_toggle: "on"|"off"} sets it.
// Editor role only. When OFF, the publish cron auto-publishes without
// review; the admin UI is not involved at all on that path.

import { requireRole } from '../../lib/admin-auth.js';
import { sendJson, readJsonBody } from '../../lib/http.js';
import { getEditorToggle, setEditorToggle } from '../../lib/admin-data.js';

export default async function handler(req, res) {
  const session = requireRole(req, res, ['editor']);
  if (!session) return;

  try {
    if (req.method === 'GET') {
      return sendJson(res, 200, { editor_toggle: await getEditorToggle() });
    }
    if (req.method === 'POST') {
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
