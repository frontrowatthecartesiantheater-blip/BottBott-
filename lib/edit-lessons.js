// Learning from the editor's edits.
//
// The admin Save/Publish flow overwrites posts.body_md with the editor's
// version, so the system never saw what it got wrong. posts.body_md_generated
// now keeps the model's draft. Once a post is published this module compares
// that draft with the published text and asks one model call what the edits
// teach: "replaced an invented opener with his own view", "added a source link
// for each named platform", "corrected a spoken figure". Those come back as
// rules the drafting prompts can follow.
//
// Nothing reaches the prompts automatically: lessons land as 'pending' and the
// editor approves or rejects each one in the admin Settings tab. Only approved
// lessons are injected (getApprovedLessons), so the system learns what the
// editor agrees it should learn, and a bad inference can be rejected.
//
//   editSimilarity()     how much of the draft survived (1.0 = published untouched)
//   extractLessons()     draft vs published -> validated lesson list (one model call)
//   backfillLessons()    published posts with a saved draft that have not been compared
//   getApprovedLessons() the lessons the prompts see
//   listLessons() / setLessonStatus()   for the admin panel

import { isMock } from './mock.js';
import { CLIENT } from './client-config.js';
import { parseJsonResponse } from './links/models.js';

export const LESSON_CATEGORIES = ['opener', 'invention', 'facts', 'links', 'style', 'structure', 'other'];
const MAX_LESSONS = 8;
const MAX_TEXT_CHARS = 14000;
const UNCHANGED_THRESHOLD = 0.985;   // at or above this, the post was published as generated
const MAX_APPROVED_IN_PROMPT = 12;

// ----------------------------------------------------------------- similarity

function wordList(text) {
  return String(text)
    .toLowerCase()
    .replace(/\]\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function shingles(words, n = 3) {
  const out = new Set();
  for (let i = 0; i + n <= words.length; i += 1) out.add(words.slice(i, i + n).join(' '));
  return out;
}

/** Jaccard overlap of word trigrams: 1.0 identical, near 0 unrelated. */
export function editSimilarity(generated, final) {
  const a = shingles(wordList(generated));
  const b = shingles(wordList(final));
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter += 1;
  return Number((inter / (a.size + b.size - inter)).toFixed(4));
}

// ----------------------------------------------------------------- extraction

export function buildLessonsPrompt({ title, generated, final }) {
  const names = (CLIENT.anonymizeNames ?? []).join(', ') || '(none listed)';
  return `You are studying how ${CLIENT.fullName} edits AI-drafted blog posts, so the drafting system can stop repeating the same mistakes.

You are given the DRAFT the system produced and the FINAL post ${CLIENT.firstName} published after editing it.

Return ONLY a JSON array (no preamble, no code fence) of 0 to ${MAX_LESSONS} objects:

[
  {
    "category": "opener | invention | facts | links | style | structure | other",
    "lesson": "an instruction the drafting system can follow, one or two sentences, phrased as a rule",
    "before": "a short quote of what the draft had (under 200 characters)",
    "after": "a short quote of what he changed it to (under 200 characters), or an empty string if he deleted it"
  }
]

Categories:
- opener: how the post opens
- invention: he removed or replaced something the system made up (an anecdote, a figure, a time reference, a stance)
- facts: he corrected a figure, name, date, or claim
- links: he added, swapped, or removed links, or changed an anchor
- style: sentence-level wording (parallel contrasts, filler, tone, punctuation)
- structure: headings, section order, length, what was cut or expanded
- other

Rules:
- Only lessons that GENERALIZE to future posts on any topic. Skip one-off content: topic-specific wording, a link that only suits this post, or new material that came from his own knowledge.
- Where he made the same kind of change several times, give ONE lesson, not several.
- Phrase each lesson as a rule ("Never open with ...", "When the transcript names a platform, ...").
- Do not propose a lesson that contradicts his voice. His honest conditionals ("I think", "maybe", "I'm pretty sure") and short fragments are part of how he writes and must stay; a hedge or fragment the draft ADDED that he never said is the problem, not hedging or fragments themselves. Em dashes are banned in his posts, so never propose allowing them.
- Never include a person's or company's name for a client. Names to scrub entirely: ${names}.
- If he changed very little, return an empty array.

POST TITLE: ${title}

DRAFT (what the system produced):
${generated.slice(0, MAX_TEXT_CHARS)}

FINAL (what he published):
${final.slice(0, MAX_TEXT_CHARS)}`;
}

export function validateLessons(raw) {
  if (!Array.isArray(raw)) throw new Error('lesson extraction did not return an array');
  const names = (CLIENT.anonymizeNames ?? []).map((n) => n.toLowerCase());
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item.lesson !== 'string') continue;
    const lesson = item.lesson.trim().replace(/\s+/g, ' ');
    if (lesson.length < 15 || lesson.length > 420) continue;
    const before = String(item.before ?? '').trim().slice(0, 240);
    const after = String(item.after ?? '').trim().slice(0, 240);
    const haystack = `${lesson} ${before} ${after}`.toLowerCase();
    if (names.some((n) => haystack.includes(n))) continue;
    const key = lesson.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      category: LESSON_CATEGORIES.includes(item.category) ? item.category : 'other',
      lesson,
      before_text: before || null,
      after_text: after || null,
    });
    if (out.length >= MAX_LESSONS) break;
  }
  return out;
}

export async function extractLessons({ title, generated, final }, client) {
  const response = await client({
    label: 'edit-lessons',
    prompt: buildLessonsPrompt({ title, generated, final }),
    maxTokens: 4096,
  });
  return validateLessons(parseJsonResponse(response, 'lesson extraction'));
}

/**
 * Compare each published post's saved draft with what was published; store the
 * similarity and any new lessons (as 'pending'). Safe to run every sweep tick:
 * a post is stamped only after a successful comparison, so a failure retries,
 * and a post published untouched is stamped without a model call.
 */
export async function backfillLessons({ supabase = null, client = null, limit = 3, dryRun = false, slugs = null } = {}) {
  const result = { processed: [], errors: [] };
  if (!supabase) {
    const { getSupabaseClient } = await import('./supabase.js');
    supabase = getSupabaseClient();
  }

  let query = supabase.from('posts').select('id, slug, title, body_md, body_md_generated')
    .eq('status', 'published')
    .not('body_md_generated', 'is', null)
    .order('published_at', { ascending: true });
  query = slugs ? query.in('slug', slugs) : query.is('lessons_extracted_at', null);
  const { data: posts, error } = await query.limit(limit);
  if (error) throw new Error(`posts read failed: ${error.message}`);
  if ((posts ?? []).length === 0) return result;

  if (!client) {
    const { createAnthropicClient } = await import('./generation/anthropic.js');
    client = createAnthropicClient();
  }

  for (const post of posts) {
    try {
      const similarity = editSimilarity(post.body_md_generated, post.body_md);
      let lessons = [];
      if (similarity < UNCHANGED_THRESHOLD) {
        lessons = await extractLessons({ title: post.title, generated: post.body_md_generated, final: post.body_md }, client);
        // Do not re-propose a lesson that already exists in any status.
        const { data: existing } = await supabase.from('edit_lessons').select('lesson');
        const have = new Set((existing ?? []).map((r) => r.lesson.toLowerCase()));
        lessons = lessons.filter((l) => !have.has(l.lesson.toLowerCase()));
      }
      if (dryRun) {
        result.processed.push({ slug: post.slug, similarity, lessons });
        continue;
      }
      if (lessons.length) {
        const { error: insertError } = await supabase.from('edit_lessons')
          .insert(lessons.map((l) => ({ ...l, source_post_id: post.id })));
        if (insertError) throw new Error(`edit_lessons insert failed: ${insertError.message}`);
      }
      const { error: stampError } = await supabase.from('posts')
        .update({ lessons_extracted_at: new Date().toISOString(), edit_similarity: similarity }).eq('id', post.id);
      if (stampError) throw new Error(`stamp failed: ${stampError.message}`);
      result.processed.push({ slug: post.slug, similarity, lessons: lessons.length });
    } catch (err) {
      result.errors.push({ slug: post.slug, error: err.message });
    }
  }
  return result;
}

// -------------------------------------------------------------- read / decide

/** Approved lessons as plain strings for the prompts. Never throws. */
export async function getApprovedLessons({ supabase = null, limit = MAX_APPROVED_IN_PROMPT } = {}) {
  if (isMock()) return [];
  try {
    if (!supabase) {
      const { getSupabaseClient } = await import('./supabase.js');
      supabase = getSupabaseClient();
    }
    const { data, error } = await supabase.from('edit_lessons').select('lesson')
      .eq('status', 'approved').order('decided_at', { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => r.lesson);
  } catch (err) {
    console.warn(`edit lessons unavailable, continuing without them: ${err.message}`);
    return [];
  }
}

export async function listLessons({ supabase = null } = {}) {
  if (isMock()) return { pending: [], approved: [] };
  if (!supabase) {
    const { getSupabaseClient } = await import('./supabase.js');
    supabase = getSupabaseClient();
  }
  const { data, error } = await supabase.from('edit_lessons')
    .select('id, category, lesson, before_text, after_text, status, created_at, posts:source_post_id(slug, title)')
    .in('status', ['pending', 'approved'])
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(`edit_lessons read failed: ${error.message}`);
  return {
    pending: data.filter((l) => l.status === 'pending'),
    approved: data.filter((l) => l.status === 'approved'),
  };
}

export async function setLessonStatus(id, status, { supabase = null } = {}) {
  if (!['approved', 'rejected'].includes(status)) throw new Error('status must be approved or rejected');
  if (isMock()) return;
  if (!supabase) {
    const { getSupabaseClient } = await import('./supabase.js');
    supabase = getSupabaseClient();
  }
  const { error } = await supabase.from('edit_lessons')
    .update({ status, decided_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(`edit_lessons update failed: ${error.message}`);
}
