// Daily publish cron, runs at 6:02 AM PT (see vercel.json for the UTC
// schedule and the DST note). For each topic scheduled today: generate
// (voice-memo path if a memo exists, RAG fallback otherwise), then branch
// on the editor toggle — auto-publish when OFF, save to pending_review and
// ping the editor when ON. Returns a JSON summary; never crashes silently.

import { sendJson } from '../../lib/http.js';
import { runPublishJob, authorizeCron } from '../../lib/cron.js';
import { sendEmail, failureEmail } from '../../lib/notify.js';

export default async function handler(req, res) {
  if (!authorizeCron(req)) return sendJson(res, 401, { error: 'unauthorized' });
  try {
    const summary = await runPublishJob();
    return sendJson(res, 200, summary);
  } catch (err) {
    // Fatal = thrown outside the per-topic loop, so no summary exists and
    // runPublishJob's own alerts never fired. Best-effort alert: the 200
    // response below must still go out even if Resend is down.
    let alert;
    try {
      alert = await sendEmail(failureEmail('Autoblog: publish cron crashed', [
        'runPublishJob threw outside the per-topic loop; no summary exists.',
        'Check the topic for today in the admin panel — it may be untouched',
        "or stuck at 'generating'.",
        '',
        `error: ${err.message}`,
        '',
        err.stack || '(no stack)',
      ]));
    } catch (alertErr) {
      alert = { ok: false, error: alertErr.message };
    }
    return sendJson(res, 200, { job: 'publish', ok: false, fatal: err.message, alert });
  }
}
