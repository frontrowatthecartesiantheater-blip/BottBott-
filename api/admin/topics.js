// Topics collection endpoint for the admin panel.
//   GET  /api/admin/topics?status=upcoming  → topics with that status,
//        ordered by scheduled_date ascending (read-only queue view).
//   POST /api/admin/topics                  → insert a single topic. status
//        defaults to 'upcoming'; order_index is auto-assigned as max + 1.
//   POST /api/admin/topics?action=generate     → AI-generate 5 topic ideas.
//   POST /api/admin/topics?action=bulk-upload  → extract topics from a .md/.pdf
//        and insert them directly into Supabase (returns a saved count).
//
// The two ?action= branches were folded in from the former
// api/admin/topics/generate.js and api/admin/topics/bulk-upload.js to stay
// within the Vercel Hobby 12-function limit. Auth-gated like the rest of
// /api/admin/* — any authenticated admin session.

import { requireRole } from '../../lib/admin-auth.js';
import { sendJson, readJsonBody, getQuery } from '../../lib/http.js';
import { createTopic, getTopicsByStatus, getAllTopicTitles } from '../../lib/admin-data.js';
import { getSupabaseClient } from '../../lib/supabase.js';
import { isMock } from '../../lib/mock.js';
import { createAnthropicClient } from '../../lib/generation/anthropic.js';
import {
  buildGeneratePrompt,
  buildExtractPrompt,
  parseTopicsJson,
  backfillGuidingQuestions,
  TOPIC_CATEGORIES,
} from '../../lib/admin-topics-ai.js';

const CATEGORIES = TOPIC_CATEGORIES;

const MAX_FILE_BYTES = 8 * 1024 * 1024;

// Neutral mock fixtures for ?action=generate in mock mode.
const GENERATE_MOCK_TOPICS = [
  {
    title: 'Example Generated Topic One',
    description: 'A mock topic idea standing in for AI-generated output.',
    category: 'example-category-a',
    main_keyword: 'example generated keyword one',
    guiding_questions: [
      'What goes wrong most often here?',
      'How do you keep the process from stalling?',
      'What do you tell people who can’t agree?',
    ],
  },
  {
    title: 'Example Generated Topic Two',
    description: 'A second mock topic idea for the generate flow.',
    category: 'example-category-b',
    main_keyword: 'example generated keyword two',
    guiding_questions: [
      'How do you stay neutral when clients want opposite things?',
      'What’s the biggest mistake people make on price?',
      'When is it better to act sooner rather than later?',
    ],
  },
  {
    title: 'Example Generated Topic Three',
    description: 'A third mock topic idea for the generate flow.',
    category: 'example-category-a',
    main_keyword: 'example generated keyword three',
    guiding_questions: [
      'Who is this really right for?',
      'Where are you seeing the better value this year?',
      'What surprises newcomers most?',
    ],
  },
  {
    title: 'Example Generated Topic Four',
    description: 'A fourth mock topic idea for the generate flow.',
    category: 'example-category-b',
    main_keyword: 'example generated keyword four',
    guiding_questions: [
      'What’s the first thing to do, and what can wait?',
      'Where do timelines usually slip?',
      'How early should they call a professional?',
    ],
  },
  {
    title: 'Example Generated Topic Five',
    description: 'A fifth mock topic idea for the generate flow.',
    category: 'example-category-a',
    main_keyword: 'example generated keyword five',
    guiding_questions: [
      'What does the old-school approach get you that new methods don’t?',
      'How has the field changed over the years?',
      'What keeps you doing it?',
    ],
  },
];

// Neutral mock fixtures for ?action=bulk-upload in mock mode.
const BULK_MOCK_TOPICS = [
  {
    title: 'Example Bulk Topic One',
    description: 'A mock topic standing in for one extracted from an uploaded document.',
    category: 'example-category-a',
    main_keyword: 'example bulk keyword one',
    guiding_questions: [
      'When is this step required and when is it not?',
      'How much time does it add?',
      'What can derail it at the last minute?',
    ],
  },
  {
    title: 'Example Bulk Topic Two',
    description: 'A second mock topic for the bulk-upload flow.',
    category: 'example-category-b',
    main_keyword: 'example bulk keyword two',
    guiding_questions: [
      'How do you anchor the conversation to the facts?',
      'What do you do when the two parties disagree?',
      'When should they bring in a neutral third party?',
    ],
  },
];

// Preserved from the former api/admin/topics/bulk-upload.js.
async function extractText({ filename, mime, buffer }) {
  const name = (filename || '').toLowerCase();
  const isPdf = name.endsWith('.pdf') || mime === 'application/pdf';
  const isMd = name.endsWith('.md') || name.endsWith('.markdown') || mime === 'text/markdown';

  if (isMd) return buffer.toString('utf8');
  if (isPdf) {
    // pdf-parse is CommonJS; import the inner module directly to avoid its
    // index.js debug-mode file read when there is no module.parent.
    const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
    const data = await pdfParse(buffer);
    return data.text || '';
  }
  throw new Error('only .md and .pdf files are accepted');
}

// Fix 3: generated topics save with no date. Schedule them on the next
// Wednesday (the publish day) that is at least 7 days after the latest
// scheduled topic: take MAX(scheduled_date) + 7 days, then advance to the next
// Wednesday if that day is not already a Wednesday. UTC throughout so the
// YYYY-MM-DD boundary never drifts by timezone.
function nextPublishWednesday(maxDateStr) {
  const base = maxDateStr ? new Date(`${maxDateStr}T00:00:00Z`) : new Date();
  base.setUTCDate(base.getUTCDate() + 7);
  const delta = (3 - base.getUTCDay() + 7) % 7; // 0 when already Wednesday
  base.setUTCDate(base.getUTCDate() + delta);
  return base.toISOString().slice(0, 10);
}

// MAX(scheduled_date) across all existing topics, or null when none have one.
async function latestScheduledDate() {
  if (isMock()) {
    const existing = await getTopicsByStatus('upcoming');
    const dates = existing.map((t) => t.scheduled_date).filter(Boolean).sort();
    return dates.length ? dates[dates.length - 1] : null;
  }
  const { data, error } = await getSupabaseClient()
    .from('topics')
    .select('scheduled_date')
    .not('scheduled_date', 'is', null)
    .order('scheduled_date', { ascending: false })
    .limit(1);
  if (error) throw new Error(`topics scheduled_date read failed: ${error.message}`);
  return data.length ? data[0].scheduled_date : null;
}

export default async function handler(req, res) {
  const session = requireRole(req, res, ['creator', 'editor']);
  if (!session) return;

  try {
    if (req.method === 'GET') {
      const { status = 'upcoming' } = getQuery(req);
      const topics = await getTopicsByStatus(status);
      return sendJson(res, 200, { topics });
    }

    if (req.method === 'POST') {
      const { action } = getQuery(req);

      // ?action=generate — AI-generate 5 fresh topic ideas (was topics/generate.js).
      if (action === 'generate') {
        if (isMock()) return sendJson(res, 200, { topics: GENERATE_MOCK_TOPICS });

        const existingTitles = await getAllTopicTitles();
        const client = createAnthropicClient();
        const text = await client({
          label: 'topic generation',
          prompt: buildGeneratePrompt(existingTitles),
          maxTokens: 2048,
        });
        const topics = parseTopicsJson(text)
          .filter((t) => t.title && TOPIC_CATEGORIES.includes(t.category))
          .slice(0, 5);

        if (!topics.length) return sendJson(res, 502, { error: 'topic generation returned no usable topics' });
        return sendJson(res, 200, { topics });
      }

      // ?action=bulk-upload — extract topics from an uploaded file and insert
      // them straight into Supabase (no client-side review). Returns a count.
      if (action === 'bulk-upload') {
        if (isMock()) {
          for (const t of BULK_MOCK_TOPICS) {
            await createTopic({
              title: t.title,
              description: t.description,
              category: t.category || null,
              primary_keyword: t.main_keyword,
              guiding_questions: t.guiding_questions,
              scheduled_date: t.scheduled_date ?? null,
            });
          }
          return sendJson(res, 200, { ok: true, count: BULK_MOCK_TOPICS.length });
        }

        const { filename, mime, data_base64: dataBase64 } = await readJsonBody(req);
        if (!dataBase64) return sendJson(res, 400, { error: 'data_base64 is required' });

        const buffer = Buffer.from(dataBase64, 'base64');
        if (buffer.length === 0) return sendJson(res, 400, { error: 'file is empty' });
        if (buffer.length > MAX_FILE_BYTES) return sendJson(res, 413, { error: 'file too large (max 8MB)' });

        const text = await extractText({ filename, mime, buffer });
        if (!text || text.trim().length < 20) {
          return sendJson(res, 422, { error: 'could not read enough text from the file' });
        }

        const client = createAnthropicClient();
        const raw = await client({
          label: 'bulk topic extraction',
          prompt: buildExtractPrompt(text.slice(0, 40000)),
          maxTokens: 4096,
        });
        let topics = parseTopicsJson(raw).filter((t) => t.title);
        topics = await backfillGuidingQuestions(topics, client);
        topics = topics.filter((t) => TOPIC_CATEGORIES.includes(t.category) || !t.category);

        if (!topics.length) return sendJson(res, 502, { error: 'no topics could be extracted from the file' });

        // Fix 2: read each topic's "- **Scheduled:** YYYY-MM-DD" field from the
        // source text in document order and apply it to the extracted topics by
        // position (the .md uses one Scheduled field per topic block, in order).
        const scheduledDates = [...text.matchAll(/\*\*Scheduled:\*\*\s*(\d{4}-\d{2}-\d{2})/g)]
          .map((m) => m[1]);

        // Fix 1: insert every extracted topic directly; no review cards.
        let count = 0;
        for (let i = 0; i < topics.length; i += 1) {
          const t = topics[i];
          await createTopic({
            title: t.title,
            description: t.description,
            category: t.category || null,
            primary_keyword: t.main_keyword,
            guiding_questions: t.guiding_questions,
            scheduled_date: scheduledDates[i] || null,
          });
          count += 1;
        }

        return sendJson(res, 200, { ok: true, count });
      }

      // No action — existing single-topic insert (unchanged).
      const body = await readJsonBody(req);
      const title = (body.title || '').trim();
      const description = (body.description || '').trim();
      const category = (body.category || '').trim();
      const primaryKeyword = (body.main_keyword ?? body.primary_keyword ?? '').trim();

      // guiding_questions may arrive as an array or a newline-delimited string.
      let guidingQuestions = body.guiding_questions ?? [];
      if (typeof guidingQuestions === 'string') {
        guidingQuestions = guidingQuestions.split('\n').map((q) => q.trim()).filter(Boolean);
      }
      guidingQuestions = (guidingQuestions || []).map((q) => String(q).trim()).filter(Boolean);

      if (!title || !description || !primaryKeyword || !guidingQuestions.length) {
        return sendJson(res, 400, {
          error: 'title, description, main_keyword and guiding_questions are required',
        });
      }
      if (category && !CATEGORIES.includes(category)) {
        return sendJson(res, 400, { error: `category must be one of: ${CATEGORIES.join(', ')}` });
      }

      // Every topic (generated or manual) is auto-scheduled on the next publish
      // Wednesday, at least 7 days after the latest scheduled topic.
      const finalScheduledDate = nextPublishWednesday(await latestScheduledDate());

      const topic = await createTopic({
        title,
        description,
        category: category || null,
        primary_keyword: primaryKeyword,
        guiding_questions: guidingQuestions,
        scheduled_date: finalScheduledDate,
      });
      return sendJson(res, 200, { ok: true, topic });
    }

    return sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}
