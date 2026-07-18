// Daily publish cron, runs at 6:02 AM PT (see vercel.json for the UTC
// schedule and the DST note). For each topic scheduled today: generate
// (voice-memo path if a memo exists, RAG fallback otherwise), then branch
// on the editor toggle — auto-publish when OFF, save to pending_review and
// ping the editor when ON. Returns a JSON summary; never crashes silently.

import { sendJson } from '../../lib/http.js';
import { runPublishJob, authorizeCron } from '../../lib/cron.js';

export default async function handler(req, res) {
  if (!authorizeCron(req)) return sendJson(res, 401, { error: 'unauthorized' });
  try {
    const summary = await runPublishJob();
    return sendJson(res, 200, summary);
  } catch (err) {
    return sendJson(res, 200, { job: 'publish', ok: false, fatal: err.message });
  }
}
