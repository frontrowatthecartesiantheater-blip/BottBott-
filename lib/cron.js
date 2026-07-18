// Cron job core logic, separated from the HTTP handlers so it can be run
// directly by the test harness. Every per-topic step is wrapped so one
// failure (missing credential, API error) is recorded in the summary
// rather than crashing the whole job — satisfies "graceful, not silent".

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isMock } from './mock.js';
import { CLIENT } from './client-config.js';
import { runGeneration } from './generation/engine.js';
import { sendEmail, reminderEmail, reviewEmail } from './notify.js';
import { retrieveChunks, formatChunksForPrompt } from './rag.js';
import {
  getTopicsScheduledFor, getReminderTopicsFor, getLatestVoiceMemo,
  setTopicStatus, saveDraftPost, addDays, mockToday,
  selectImageForTopic, markImageUsed,
} from './cron-data.js';

const MOCK_FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..',
  'content', 'test-fixtures', 'mock-example-run',
);

// "Today" in the client's timezone (client-config.js), so the date matches
// the client's local day regardless of the server's UTC clock. MOCK_TODAY
// overrides for tests.
export function todayInClientTz() {
  if (isMock()) return mockToday();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CLIENT.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return parts; // en-CA gives YYYY-MM-DD
}

function readPriorPosts() {
  try {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'blog', 'index.json'), 'utf8'));
    return manifest.posts.slice(0, 5).map((p) => ({ title: p.title, slug: p.slug }));
  } catch {
    return [];
  }
}

async function getGenerationClient(primaryKeyword, ragFlag) {
  if (isMock()) {
    const { createMockClient } = await import('./generation/mock-client.js');
    return createMockClient({ fixtureDir: MOCK_FIXTURE_DIR, primaryKeyword, ragFlag });
  }
  const { createAnthropicClient } = await import('./generation/anthropic.js');
  return createAnthropicClient();
}

// Generate a post for a topic. Path A = voice memo (transcript); Path B =
// RAG fallback (no memo). Returns { result, mode, voiceMemoId }.
async function generateForTopic(topic) {
  const memo = await getLatestVoiceMemo(topic.id);
  const priorPosts = readPriorPosts();

  const baseInputs = {
    topicTitle: topic.title,
    topicDescription: topic.description,
    primaryKeyword: topic.primary_keyword,
    guidingQuestions: topic.guiding_questions || [],
    priorPosts,
  };

  let inputs, mode, voiceMemoId = null;
  if (memo) {
    inputs = { ...baseInputs, transcript: memo.transcript, ragFlag: false, ragChunks: null };
    mode = 'voice_memo';
    voiceMemoId = memo.id;
  } else {
    const chunks = await retrieveChunks(topic);
    inputs = {
      ...baseInputs,
      transcript: null,
      ragFlag: true,
      ragChunks: chunks.length ? formatChunksForPrompt(chunks) : '(no related content found in the database)',
    };
    mode = 'rag_fallback';
  }

  const client = await getGenerationClient(topic.primary_keyword, inputs.ragFlag);
  const result = await runGeneration(inputs, client);
  return { result, mode, voiceMemoId };
}

async function saveAsPendingReview(topic, result, voiceMemoId) {
  const { post, social } = result.package;
  const craftAudit = [result.craftAudit ?? '(none)', '', 'LINT:', JSON.stringify(result.lint, null, 2)].join('\n');

  // Loosely link an image by category (best-effort; never blocks the draft).
  let image = null;
  try {
    image = await selectImageForTopic(topic.category);
  } catch (err) {
    console.error(`image selection failed for topic ${topic.id}: ${err.message}`);
  }

  const saved = await saveDraftPost({
    topic_id: topic.id,
    voice_memo_id: voiceMemoId,
    slug: post.slug,
    title: post.title,
    body_md: post.body_md,
    meta_title: post.meta_title,
    meta_description: post.meta_description,
    primary_keyword: post.primary_keyword,
    keywords_used: [post.primary_keyword],
    internal_link_a: post.internal_link_a,
    internal_link_b: post.internal_link_b,
    rag_fallback: Boolean(post.rag_fallback),
    social_linkedin: social.linkedin,
    social_facebook: social.facebook,
    image_used: image?.filename ?? null,
    craft_audit: craftAudit,
    status: 'pending_review',
  });

  if (image) {
    try {
      await markImageUsed(image.id, saved.id);
    } catch (err) {
      console.error(`marking image used failed for post ${saved.id}: ${err.message}`);
    }
  }
  return saved.id;
}

// ---- reminder job -----------------------------------------------------

// Three-step reminder ladder, email only (WhatsApp is shelved). A topic
// normally walks upcoming -> reminder_sent_3d -> _2d -> _1d, one email per
// day. Each stage accepts every earlier-stage status, so a topic scheduled
// under 3 days out (or one whose earlier send failed) still gets the
// reminders remaining for its window; a topic that gets recorded (status
// 'recorded') no longer matches any stage and drops out of the ladder.
const REMINDER_STAGES = [
  { daysOut: 3, fromStatuses: ['upcoming'], toStatus: 'reminder_sent_3d' },
  { daysOut: 2, fromStatuses: ['upcoming', 'reminder_sent_3d'], toStatus: 'reminder_sent_2d' },
  { daysOut: 1, fromStatuses: ['upcoming', 'reminder_sent_3d', 'reminder_sent_2d'], toStatus: 'reminder_sent_1d' },
];

export async function runReminderJob({ today = todayInClientTz() } = {}) {
  const summary = { job: 'reminder', today, processed: [], errors: [] };

  for (const stage of REMINDER_STAGES) {
    const target = addDays(today, stage.daysOut);
    let topics;
    try {
      topics = await getReminderTopicsFor(target, stage.fromStatuses);
    } catch (err) {
      summary.errors.push({ step: 'load_topics', stage: `${stage.daysOut}d`, error: err.message });
      continue;
    }

    for (const topic of topics) {
      const entry = { topicId: topic.id, title: topic.title, stage: `${stage.daysOut}d`, email: null };
      entry.email = await sendEmail(reminderEmail(topic, stage.daysOut));
      // Only advance status if the email actually went out; a failed send
      // leaves the topic eligible for the next stage's window.
      if (entry.email.ok) {
        try { await setTopicStatus(topic.id, stage.toStatus); entry.statusUpdated = true; }
        catch (err) { entry.statusUpdated = false; summary.errors.push({ topicId: topic.id, step: 'set_reminder_status', error: err.message }); }
      }
      summary.processed.push(entry);
    }
  }
  return summary;
}

// ---- publish job ------------------------------------------------------

export async function runPublishJob({ today = todayInClientTz() } = {}) {
  const summary = { job: 'publish', today, processed: [], errors: [] };

  let topics;
  try {
    topics = await getTopicsScheduledFor(today);
  } catch (err) {
    summary.errors.push({ step: 'load', error: err.message });
    return summary;
  }

  for (const topic of topics) {
    const entry = { topicId: topic.id, title: topic.title };
    try {
      await setTopicStatus(topic.id, 'generating');
      const { result, mode, voiceMemoId } = await generateForTopic(topic);
      entry.mode = mode;
      entry.slug = result.package.post.slug;
      entry.lintOk = result.lint.ok;

      // Generation only, always: the link sweep and auto-publish now run
      // out-of-band via GitHub Actions (scripts/sweep-and-publish.js), so
      // every topic lands in pending_review regardless of editor toggle.
      const postId = await saveAsPendingReview(topic, result, voiceMemoId);
      entry.action = 'pending_review';
      entry.postId = postId;
      entry.reviewPing = await sendEmail(reviewEmail(topic));
      await setTopicStatus(topic.id, 'generating'); // stays in generating until approved
    } catch (err) {
      entry.action = 'failed';
      entry.error = err.message;
      try {
        await setTopicStatus(topic.id, 'reminder_sent');
      } catch (resetErr) {
        summary.errors.push({ topicId: topic.id, step: 'reset_status', error: resetErr.message });
      }
      summary.errors.push({ topicId: topic.id, step: entry.mode || 'generate', error: err.message });
    }
    summary.processed.push(entry);
  }
  return summary;
}

// Shared cron-secret guard for the HTTP handlers.
export function authorizeCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // not configured (local/preview); allow
  const header = req.headers.authorization || '';
  return header === `Bearer ${secret}`;
}
