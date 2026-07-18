// M6 mock test harness. Runs the reminder and publish cron jobs in mock
// mode against the cron-data fixtures, exercising every branch:
//   - reminder job: one topic per ladder stage (3d / 2d / 1d), email only
//   - publish job, toggle OFF and ON: both save pending_review + ping the
//     editor (the cron never publishes inline anymore — the link sweep /
//     auto-publish runs out-of-band via scripts/sweep-and-publish.js)
//
// No credentials needed. Usage: node scripts/test-cron.js
//
// Note: in mock mode the generation client serves the M3 fixture post for
// every topic, so this verifies the cron PLUMBING and branching, not the
// writing (that is M3's job). RAG retrieval runs for real over an in-memory
// seeded store.

process.env.PIPELINE_MOCK = '1';
process.env.MOCK_TODAY = '2026-06-19';

const { runReminderJob, runPublishJob } = await import('../lib/cron.js');
const { setEditorToggle } = await import('../lib/admin-data.js');
const { _seedMockStore } = await import('../lib/rag.js');
const { embed } = await import('../lib/embeddings.js');

function hr(title) { console.log(`\n${'='.repeat(60)}\n${title}\n${'='.repeat(60)}`); }

// Seed the RAG store so the no-memo topic (cron-topic-b) has something to
// retrieve.
const exampleChunks = [
  'An example chunk of prior content that the RAG fallback can draw on.',
  'A second example chunk, standing in for an indexed transcript or post.',
];
const embeddings = await embed(exampleChunks);
_seedMockStore(exampleChunks.map((content, i) => ({
  source_type: 'voice_memo', source_id: 'seed-example', chunk_index: i, content, embedding: embeddings[i],
})));

hr('REMINDER JOB (today=2026-06-19, ladder targets 06-22/3d, 06-21/2d, 06-20/1d)');
const remSummary = await runReminderJob();
console.log(JSON.stringify(remSummary, null, 2));

hr('PUBLISH JOB — editor toggle OFF (still pending_review; sweep publishes later)');
await setEditorToggle('off');
const offSummary = await runPublishJob();
console.log(JSON.stringify(offSummary, null, 2));

hr('PUBLISH JOB — editor toggle ON (pending_review + editor ping)');
await setEditorToggle('on');
const onSummary = await runPublishJob();
console.log(JSON.stringify(onSummary, null, 2));

// ---- assertions -------------------------------------------------------
hr('ASSERTIONS');
const checks = [];
const assert = (name, cond) => { checks.push({ name, pass: Boolean(cond) }); };

const remByTopic = Object.fromEntries(remSummary.processed.map((p) => [p.topicId, p]));
assert('REMINDER: exactly three reminders sent', remSummary.processed.length === 3);
assert('REMINDER: topic-c got the 3-day email', remByTopic['cron-topic-c']?.stage === '3d' && remByTopic['cron-topic-c']?.email?.ok);
assert('REMINDER: topic-d got the 2-day email', remByTopic['cron-topic-d']?.stage === '2d' && remByTopic['cron-topic-d']?.email?.ok);
assert('REMINDER: topic-e got the 1-day email', remByTopic['cron-topic-e']?.stage === '1d' && remByTopic['cron-topic-e']?.email?.ok);
assert('REMINDER: recorded topic-a untouched', !remByTopic['cron-topic-a']);

const offByTopic = Object.fromEntries(offSummary.processed.map((p) => [p.topicId, p]));
assert('OFF: topic-a used voice_memo path', offByTopic['cron-topic-a']?.mode === 'voice_memo');
assert('OFF: topic-b used rag_fallback path', offByTopic['cron-topic-b']?.mode === 'rag_fallback');
// The cron never publishes inline (regardless of toggle); auto-publish moved
// to scripts/sweep-and-publish.js after the link sweep.
assert('OFF: topic-a saved to pending_review', offByTopic['cron-topic-a']?.action === 'pending_review');
assert('OFF: topic-b saved to pending_review', offByTopic['cron-topic-b']?.action === 'pending_review');
assert('OFF: nothing was published inline', offSummary.processed.every((p) => p.action !== 'published'));

const onByTopic = Object.fromEntries(onSummary.processed.map((p) => [p.topicId, p]));
assert('ON: topic-a saved to pending_review', onByTopic['cron-topic-a']?.action === 'pending_review');
assert('ON: topic-a editor ping sent', onByTopic['cron-topic-a']?.reviewPing?.ok === true);
assert('ON: nothing was published', onSummary.processed.every((p) => p.action === 'pending_review'));

let failed = 0;
for (const c of checks) { console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`); if (!c.pass) failed++; }
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
