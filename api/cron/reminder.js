// Daily reminder cron. Vercel sends Authorization: Bearer <CRON_SECRET>.
// Returns 200 with a JSON summary even on partial failure, so problems are
// visible in the Vercel logs/response rather than crashing silently.

import { sendJson } from '../../lib/http.js';
import { runReminderJob, authorizeCron } from '../../lib/cron.js';

export default async function handler(req, res) {
  if (!authorizeCron(req)) return sendJson(res, 401, { error: 'unauthorized' });
  try {
    const summary = await runReminderJob();
    return sendJson(res, 200, summary);
  } catch (err) {
    // Last-resort catch; per-topic errors are already inside the summary.
    return sendJson(res, 200, { job: 'reminder', ok: false, fatal: err.message });
  }
}
