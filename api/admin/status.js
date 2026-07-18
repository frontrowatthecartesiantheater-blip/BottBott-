// Dashboard data for both tabs. The creator role gets only what its view
// needs; the editor gets everything.

import { requireRole } from '../../lib/admin-auth.js';
import { sendJson } from '../../lib/http.js';
import { CLIENT } from '../../lib/client-config.js';
import {
  getEditorToggle,
  getUpcomingTopic,
  getTopicsQueue,
  getPendingPosts,
  getPublishedPosts,
} from '../../lib/admin-data.js';

export default async function handler(req, res) {
  const session = requireRole(req, res, ['creator', 'editor']);
  if (!session) return;

  try {
    const upcomingTopic = await getUpcomingTopic();
    const brandName = CLIENT.adminBrandName;
    if (session.role === 'creator') {
      return sendJson(res, 200, { role: 'creator', email: session.email, brandName, upcomingTopic });
    }
    const [editorToggle, topicsQueue, pendingPosts, publishedPosts] = await Promise.all([
      getEditorToggle(),
      getTopicsQueue(),
      getPendingPosts(),
      getPublishedPosts(),
    ]);
    return sendJson(res, 200, {
      role: 'editor',
      email: session.email,
      brandName,
      upcomingTopic,
      editorToggle,
      topicsQueue,
      pendingPosts,
      publishedPosts,
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}
