// Media endpoint for the admin panel, dispatched by ?action=.
//   POST /api/admin/media?action=image-upload — add one or more images to
//   the library, all under one category.
//
// Folded out of the former api/admin/images/upload.js into a single ?action=
// dispatched endpoint to stay within the Vercel Hobby 12-function limit.
//
// Payload: JSON { images: [{ filename, mime, data_base64 }, ...], category }
// — base64 keeps body handling identical across Vercel and the dev server
// with no multipart dependency, matching api/admin/record.js. Every image in
// the batch lands in ONE GitHub commit: lib/github.js documents a real Vercel
// race when separate commits land in quick succession (the next build cancels
// the previous one mid-flight, which can freeze the live site at an
// intermediate state), and a naive per-image commit loop would hit that
// directly. All images are validated up front — extension, per-image size,
// and combined batch size — before anything is committed or written, so a bad
// file in the batch fails the whole request instead of leaving a partial
// upload. Once committed, one `images` row is inserted per image (source
// 'owned', used false) and alt text is generated per image via Claude vision,
// best-effort — a failed alt-text call never loses an already-saved image.
// Auth-gated.

import { requireRole } from '../../lib/admin-auth.js';
import { sendJson, readJsonBody, getQuery } from '../../lib/http.js';
import { isMock } from '../../lib/mock.js';
import { insertImage, updateImageAltText } from '../../lib/admin-data.js';
import { createSingleCommit } from '../../lib/github.js';
import { CLIENT } from '../../lib/client-config.js';

// Vercel's edge answers a request body over 4.5 MB (decimal) with
// FUNCTION_PAYLOAD_TOO_LARGE before this function is invoked. The images
// travel as base64 inside one JSON array, which inflates each by 4/3, so the
// per-image and combined-batch ceilings both have to sit below that — the
// same physics as MAX_UPLOAD_BYTES in admin/admin.js's audio/document
// uploads. The old single-image limit here (8 MB) was never actually
// reachable: an 8 MB image alone would have been ~10.7 MB of base64 body,
// rejected at the edge with a bare 413 long before this file's own check ran.
// One ceiling, used both per-image and as the combined-batch cap: with a
// single image in the batch these are the same check anyway.
const MAX_UPLOAD_BYTES = Math.floor((4500000 - 4096) * 3 / 4);
const IMAGE_DIR_BASE = 'assets/images/blog';
const CATEGORIES = CLIENT.topicCategories;
const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MEDIA_TYPE_BY_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'webp'];

// Claude vision model + prompt for auto-generating SEO alt text on upload.
// Location and keywords come from client-config.
const ALT_TEXT_MODEL = 'claude-sonnet-5';
const ALT_TEXT_PROMPT = `You are writing SEO alt text for the blog of ${CLIENT.businessName}.
Describe this image in one concise sentence (12 words max), focused on what
the image shows and the business concept it illustrates. No location references.
Do not mention the image being stock or generic.
Primary keywords to weave in naturally where relevant:
${CLIENT.altTextKeywords}.
Only use a keyword if it fits naturally — do not force it.
Return only the alt text string, nothing else.`;

// Slugify the base name and keep a safe extension; prefix a timestamp to
// avoid collisions. `offset` (an image's index within a batch) keeps two
// images processed in the same synchronous loop from landing on the same
// millisecond and colliding — a real risk, not a theoretical one: an earlier
// single-image batch upload produced two filenames 18ms apart.
function safeFilename(rawName, mime, offset = 0) {
  const dot = rawName.lastIndexOf('.');
  const base = (dot > 0 ? rawName.slice(0, dot) : rawName) || 'image';
  let ext = (dot > 0 ? rawName.slice(dot + 1) : '').toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) ext = EXT_BY_MIME[mime] || '';
  if (ext === 'jpeg') ext = 'jpg';
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
  return { ext, name: `${Date.now() + offset}-${slug}.${ext}` };
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
      max_tokens: 200,
      // Sonnet 5 runs adaptive thinking by default and thinking shares
      // max_tokens; for a 12-word alt text that would eat the whole budget
      // and silently return empty text, so disable it here.
      thinking: { type: 'disabled' },
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
  // Strip surrounding quote marks — the model sometimes returns the alt text
  // as a quoted string, which would otherwise be stored verbatim.
  return data.content.map((b) => b.text ?? '').join('').trim().replace(/^["'“]+|["'”]+$/g, '');
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
    const { images, category } = await readJsonBody(req);
    if (!category || !CATEGORIES.includes(category)) {
      return sendJson(res, 400, { error: `category must be one of: ${CATEGORIES.join(', ')}` });
    }
    if (!Array.isArray(images) || images.length === 0) {
      return sendJson(res, 400, { error: 'images must be a non-empty array' });
    }

    // Validate every image up front — nothing is committed or written until
    // the whole batch checks out, so one bad file fails the request instead
    // of leaving a partial upload behind.
    const prepared = [];
    let totalBytes = 0;
    for (let i = 0; i < images.length; i += 1) {
      const { filename, mime, data_base64: dataBase64 } = images[i] ?? {};
      const label = filename || `image ${i + 1}`;
      if (!dataBase64) return sendJson(res, 400, { error: `${label}: data_base64 is required` });

      const { ext, name } = safeFilename(filename || '', mime, i);
      if (!ALLOWED_EXT.includes(ext)) {
        return sendJson(res, 400, { error: `${label}: only jpg, png and webp images are accepted` });
      }

      const buffer = Buffer.from(dataBase64, 'base64');
      if (buffer.length === 0) return sendJson(res, 400, { error: `${label}: image is empty` });
      if (buffer.length > MAX_UPLOAD_BYTES) {
        return sendJson(res, 413, {
          error: `${label} is ${(buffer.length / 1000000).toFixed(2)} MB; the limit is `
            + `${(MAX_UPLOAD_BYTES / 1000000).toFixed(2)} MB per image`,
        });
      }
      totalBytes += buffer.length;

      // Category drives the subfolder, matching the existing blog image layout.
      const repoPath = `${IMAGE_DIR_BASE}/${category}/${name}`;
      prepared.push({ repoPath, name, ext, buffer });
    }
    if (totalBytes > MAX_UPLOAD_BYTES) {
      return sendJson(res, 413, {
        error: `${images.length} images together are ${(totalBytes / 1000000).toFixed(2)} MB; `
          + `the limit per upload is ${(MAX_UPLOAD_BYTES / 1000000).toFixed(2)} MB combined`,
      });
    }

    if (!isMock()) {
      const message = prepared.length === 1
        ? `Add library image: ${prepared[0].name}`
        : `Add ${prepared.length} library images`;
      await createSingleCommit(message, prepared.map((p) => (
        { path: p.repoPath, contentBase64: p.buffer.toString('base64') }
      )));
    }

    const results = [];
    for (const p of prepared) {
      const image = await insertImage({ filename: p.repoPath, category });

      // Generate alt text from the image and write it back. Best-effort: a
      // failure here must not lose an already-saved upload, and one image's
      // failure must not stop the rest of the batch. Skipped in mock mode.
      if (!isMock()) {
        try {
          const altText = await generateAltText(p.buffer.toString('base64'), p.ext);
          if (altText) {
            await updateImageAltText(image.id, altText);
            image.alt_text = altText;
          }
        } catch (altErr) {
          console.error(`alt text generation failed for ${p.repoPath}: ${altErr.message}`);
        }
      }
      results.push(image);
    }

    return sendJson(res, 200, { ok: true, images: results });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}
