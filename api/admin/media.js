// Media endpoint for the admin panel, dispatched by ?action=.
//   POST /api/admin/media?action=image-upload — add an image to the library.
//
// Folded out of the former api/admin/images/upload.js into a single ?action=
// dispatched endpoint to stay within the Vercel Hobby 12-function limit.
//
// The image arrives as base64 JSON ({ filename, mime, data_base64, category }),
// matching api/admin/record.js so body handling is identical across Vercel and
// the dev server with no multipart dependency. The binary is committed into the
// repo at assets/images/blog/<category>/<file> (the site-root-relative path
// convention images.filename uses), then a row is inserted into the images
// table (source 'owned', used false). Alt text is generated automatically from
// the image via Claude vision and written back to the row. Auth-gated.

import { requireRole } from '../../lib/admin-auth.js';
import { sendJson, readJsonBody, getQuery } from '../../lib/http.js';
import { isMock } from '../../lib/mock.js';
import { insertImage, updateImageAltText } from '../../lib/admin-data.js';
import { createSingleCommit } from '../../lib/github.js';
import { CLIENT } from '../../lib/client-config.js';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_DIR_BASE = 'assets/images/blog';
const CATEGORIES = CLIENT.topicCategories;
const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MEDIA_TYPE_BY_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'webp'];

// Claude vision model + prompt for auto-generating SEO alt text on upload.
// Location and keywords come from client-config.
const ALT_TEXT_MODEL = 'claude-sonnet-4-6';
const ALT_TEXT_PROMPT = `You are writing SEO alt text for a blog serving ${CLIENT.primaryCity} and nearby areas.
Describe this image in one concise sentence (12 words max) as if it were taken in or near
${CLIENT.primaryCity} — use specific local place references where the image plausibly fits.
Do not mention the image being stock or generic.
Primary keywords to weave in naturally where relevant:
${CLIENT.altTextKeywords}.
Only use a keyword if it fits naturally — do not force it.
Return only the alt text string, nothing else.`;

/** Slugify the base name and keep a safe extension; prefix a timestamp to avoid collisions. */
function safeFilename(rawName, mime) {
  const dot = rawName.lastIndexOf('.');
  const base = (dot > 0 ? rawName.slice(0, dot) : rawName) || 'image';
  let ext = (dot > 0 ? rawName.slice(dot + 1) : '').toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) ext = EXT_BY_MIME[mime] || '';
  if (ext === 'jpeg') ext = 'jpg';
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
  return { ext, name: `${Date.now()}-${slug}.${ext}` };
}

/** Generate SEO alt text for an image via Claude vision. Returns '' if none. */
async function generateAltText(base64, ext) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const mediaType = MEDIA_TYPE_BY_EXT[ext] || 'image/png';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ALT_TEXT_MODEL,
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: ALT_TEXT_PROMPT },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic alt-text error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.content.map((b) => b.text ?? '').join('').trim();
}

export default async function handler(req, res) {
  const session = requireRole(req, res, ['creator', 'editor']);
  if (!session) return;
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

  const { action } = getQuery(req);
  if (action !== 'image-upload') {
    return sendJson(res, 400, { error: 'action is required' });
  }

  try {
    const { filename, mime, data_base64: dataBase64, category } = await readJsonBody(req);
    if (!dataBase64) return sendJson(res, 400, { error: 'data_base64 is required' });
    if (!category || !CATEGORIES.includes(category)) {
      return sendJson(res, 400, { error: `category must be one of: ${CATEGORIES.join(', ')}` });
    }

    const { ext, name } = safeFilename(filename || '', mime);
    if (!ALLOWED_EXT.includes(ext)) {
      return sendJson(res, 400, { error: 'only jpg, png and webp images are accepted' });
    }

    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length === 0) return sendJson(res, 400, { error: 'image is empty' });
    if (buffer.length > MAX_IMAGE_BYTES) return sendJson(res, 413, { error: 'image too large (max 8MB)' });

    // Category drives the subfolder, matching the existing blog image layout.
    const repoPath = `${IMAGE_DIR_BASE}/${category}/${name}`;

    if (!isMock()) {
      await createSingleCommit(`Add library image: ${name}`, [
        { path: repoPath, contentBase64: buffer.toString('base64') },
      ]);
    }

    const image = await insertImage({ filename: repoPath, category });

    // Generate alt text from the image and write it back. Best-effort: a failure
    // here must not lose an already-saved upload. Skipped in mock mode.
    if (!isMock()) {
      try {
        const altText = await generateAltText(buffer.toString('base64'), ext);
        if (altText) {
          await updateImageAltText(image.id, altText);
          image.alt_text = altText;
        }
      } catch (altErr) {
        console.error(`alt text generation failed for ${repoPath}: ${altErr.message}`);
      }
    }

    return sendJson(res, 200, { ok: true, image });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}
