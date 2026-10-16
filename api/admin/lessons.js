// Lessons the system proposes from the editor's own edits (lib/edit-lessons.js).
// Editor role only.
//
// GET                      -> { pending: [...], approved: [...] }
// POST ?action=approve {id} -> the lesson is injected into future drafting prompts
// POST ?action=reject  {id} -> never shown again; an approved lesson can be
//                              retired the same way
//
// Nothing here reaches the prompts until it is approved.

import { requireRole } from '../../lib/admin-auth.js';
import { sendJson, readJsonBody, getQuery } from '../../lib/http.js';
import { listLessons, setLessonStatus } from '../../lib/edit-lessons.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  const session = requireRole(req, res, ['editor']);
  if (!session) return;

  try {
    if (req.method === 'GET') return sendJson(res, 200, await listLessons());

    if (req.method === 'POST') {
      const { action } = getQuery(req);
      const { id } = await readJsonBody(req);
      if (!id || !UUID_RE.test(String(id))) return sendJson(res, 400, { error: 'a valid lesson id is required' });
      if (action === 'approve') await setLessonStatus(id, 'approved');
      else if (action === 'reject') await setLessonStatus(id, 'rejected');
      else return sendJson(res, 400, { error: 'action must be approve or reject' });
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}
