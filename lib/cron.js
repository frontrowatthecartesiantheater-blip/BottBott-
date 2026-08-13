// Cron job core logic, separated from the HTTP handlers so it can be run
// directly by the test harness. Every per-topic step is wrapped so one
// failure (missing credential, API error) is recorded in the summary
// rather than crashing the whole job — satisfies "graceful, not silent".

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isMock } from './mock.js';
import { CLIENT, SITE_ORIGIN } from './client-config.js';
import { runGeneration } from './generation/engine.js';
import { sendEmail, reminderEmail, reviewEmail, failureEmail } from './notify.js';
import { retrieveChunks, formatChunksForPrompt } from './rag.js';
import {
  getTopicsScheduledFor, getReminderTopicsFor, getLatestVoiceMemo,
  setTopicStatus, saveDraftPost, addDays, mockToday,
  selectImageForTopic, markImageUsed, getStuckGeneratingTopics,
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
    // url, not slug: handing the model a bare slug alongside a Pool A of
    // root-level URLs invites it to build <origin>/<slug>, a 404 (July 2026
    // incident on the Gregg build). Give it the /blog/ URL, nothing to assemble.
    return manifest.posts.slice(0, 5).map((p) => ({
      title: p.title,
      url: `${SITE_ORIGIN}/blog/${p.slug}`,
    }));
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

// Guarded failure alert to the editor: must never throw — an alert cannot be
// allowed to worsen the failure it reports. sendEmail is non-throwing by
// contract, but that contract is one refactor away from breaking, so the
// whole build-and-send is wrapped. Send result (or the alert's own failure)
// is recorded in the summary either way.
async function alertEditor(summary, subject, lines) {
  try {
    const result = await sendEmail(failureEmail(subject, lines));
    (summary.alerts ??= []).push({ subject, result });
  } catch (err) {
    summary.errors.push({ step: 'alert_email', subject, error: err.message });
  }
}

// At most one generation per run: keeps runtime and Anthropic spend at the
// known-good single-topic profile (a second generation in the same
// invocation risks the function timeout, stranding it mid-run). With
// overdue topics sorted first, a backlog drains oldest-first at one per
// daily run; deferred topics are recorded in the summary.
const MAX_TOPICS_PER_RUN = 1;

export async function runPublishJob({ today = todayInClientTz(), maxTopics = MAX_TOPICS_PER_RUN } = {}) {
  const summary = { job: 'publish', today, processed: [], errors: [], alerts: [] };

  // A topic stuck at 'generating' from a previous day with no draft to show
  // for it means a hard kill (timeout/crash) mid-generation — no catch block
  // ever saw it, so no alert fired at the time. Detect it here. A
  // 'generating' topic WITH a posts row is not stuck: that is a draft
  // awaiting editor review, possibly for days when the toggle is on.
  try {
    const stuck = await getStuckGeneratingTopics(today);
    for (const topic of stuck) {
      summary.errors.push({ topicId: topic.id, step: 'stuck_generating', error: `stuck at 'generating' since ${topic.scheduled_date} with no draft` });
      await alertEditor(summary, `Autoblog: topic stuck mid-generation — ${topic.title}`, [
        `A topic is stuck at 'generating' from a previous day and has no draft row.`,
        `This usually means the generation function was killed mid-run (timeout/crash).`,
        '',
        `topic id:       ${topic.id}`,
        `title:          ${topic.title}`,
        `scheduled_date: ${topic.scheduled_date}`,
        `job "today":    ${today}`,
        '',
        `It will not retry on its own ('generating' is excluded from the overdue`,
        `window). Reset its status or reschedule it in the admin panel.`,
      ]);
    }
  } catch (err) {
    summary.errors.push({ step: 'stuck_check', error: err.message });
  }

  let topics;
  try {
    topics = await getTopicsScheduledFor(today);
  } catch (err) {
    summary.errors.push({ step: 'load', error: err.message });
    await alertEditor(summary, 'Autoblog: publish job could not load topics', [
      `The publish cron failed before processing any topic (today=${today}).`,
      `Nothing was generated; today's topic (if any) was not touched and stays`,
      `eligible for the next run.`,
      '',
      `error: ${err.message}`,
      '',
      err.stack || '(no stack)',
    ]);
    return summary;
  }

  if (topics.length > maxTopics) {
    summary.deferred = topics.slice(maxTopics).map((t) => (
      { topicId: t.id, title: t.title, scheduledDate: t.scheduled_date }
    ));
    topics = topics.slice(0, maxTopics);
  }

  for (const topic of topics) {
    const entry = { topicId: topic.id, title: topic.title };
    try {
      await setTopicStatus(topic.id, 'generating');
      const { result, mode, voiceMemoId } = await generateForTopic(topic);
      entry.mode = mode;
      entry.slug = result.package.post.slug;
      entry.lintOk = result.lint.ok;
      if (result.revision) entry.revision = result.revision;

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
      let statusResetOk = true;
      try {
        await setTopicStatus(topic.id, 'reminder_sent');
      } catch (resetErr) {
        statusResetOk = false;
        summary.errors.push({ topicId: topic.id, step: 'reset_status', error: resetErr.message });
      }
      summary.errors.push({ topicId: topic.id, step: entry.mode || 'generate', error: err.message });
      await alertEditor(summary, `Autoblog: generation failed — ${topic.title}`, [
        `Today's post did not generate.`,
        '',
        `topic id:       ${topic.id}`,
        `title:          ${topic.title}`,
        `scheduled_date: ${topic.scheduled_date}`,
        `job "today":    ${today}`,
        `mode:           ${entry.mode || '(failed before the voice-memo lookup decided a mode)'}`,
        `status reset:   ${statusResetOk ? "ok — back to 'reminder_sent', retries on the next daily run" : 'FAILED — topic may be stuck at generating; check the topic row'}`,
        '',
        `error: ${err.message}`,
        '',
        err.stack || '(no stack)',
      ]);
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
