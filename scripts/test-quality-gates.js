// Offline tests for the Oct 2026 quality work: grounding rules, the new lint
// checks, SerpApi quota handling, the sweep's retry/stamp logic, talking
// points, and the engine's grounding + revision loop. No credentials, no
// network, no database.
//
// Usage: node scripts/test-quality-gates.js

process.env.PIPELINE_MOCK = '1';

import { readFileSync } from 'node:fs';
import path from 'node:path';

const { findUngroundedSpecifics, parseGroundingResponse, groundingToLintFindings, buildSupportText } = await import('../lib/generation/grounding.js');
const { lintGenerationResult, findVerbatimReuse } = await import('../lib/generation/lint.js');
const { searchCandidates, SearchQuotaError } = await import('../lib/links/search.js');
const { injectExternalLinks } = await import('../lib/links/engine.js');
const { runLinkSweep } = await import('../lib/links/sweep.js');
const { validatePoints, extractTalkingPoints, indexTalkingPoints, retrieveTalkingPoints } = await import('../lib/talking-points.js');
const { buildLintRevisionPrompt } = await import('../lib/generation/prompts.js');
const { runGeneration } = await import('../lib/generation/engine.js');
const { createMockClient } = await import('../lib/generation/mock-client.js');
const { CLIENT } = await import('../lib/client-config.js');
// The tests set the client values they depend on, so they pass for any client build.
CLIENT.anonymizeNames = ['Acme Plumbing'];

const checks = [];
const check = (name, cond, extra = '') => { checks.push({ name, pass: Boolean(cond) }); if (!cond) console.log(`  FAIL ${name} ${extra}`); };
const hr = (t) => console.log(`\n=== ${t}`);

// ------------------------------------------------------------ grounding rules
hr('grounding rules (the Oct 15 case)');
const transcript = `The biggest misconception I hear about AI Search replacing Google is that AI Search is still based on SEO. A lot of models don't use Google for their web browsing. I recently published a post here about that. If you can be in the top two or three pages, people will stop searching after that. For business owners panicking about AI killing their SEO, they don't really have to worry about it. Maybe one thing to do is to diversify. Yeah. Yeah.`;
const support = buildSupportText({ transcript, topicTitle: 'Why AI Search Is Misleading', ragFlag: false });

const fabricated = [
  'A business owner messaged me last week, pretty worked up, asking if he should give up on his website.',
  'The same fundamentals that got a page ranked five years ago are still doing the work now.',
].join('\n\n');
const f1 = findUngroundedSpecifics(fabricated, support);
check('flags "messaged me" invented event', f1.some((f) => f.type === 'event' && f.level === 'error'));
check('flags "last week" invented time reference', f1.some((f) => f.type === 'time_reference' && /last week/.test(f.detail)));
check('flags "five years ago"', f1.some((f) => f.type === 'time_reference' && /five years ago/.test(f.detail)));

const faithful = [
  'I recently published a post about how models browse the web.',
  'If you can be in the top two or three pages, people stop searching after that.',
].join('\n\n');
const f2 = findUngroundedSpecifics(faithful, support);
check('does not flag supported "recently" / "two or three"', f2.length === 0, JSON.stringify(f2));

const withLink = findUngroundedSpecifics('See [this guide](https://example.com/2019/guide-12345) for more.', support);
check('ignores numbers inside link targets', withLink.length === 0, JSON.stringify(withLink));

// verifier response parsing
const draft = 'I think it matters.\n\nA client told me she doubled her traffic in 2021.\n\nThat is the whole point.';
const parsed = parseGroundingResponse(JSON.stringify({ ungrounded: [
  { sentence: 'A client told me she doubled her traffic in 2021.', type: 'event', severity: 'high', why: 'no such client in the source' },
  { sentence: 'This sentence is not in the draft at all.', type: 'figure', severity: 'high', why: 'x' },
  { sentence: 'I think it matters.', type: 'embellishment', severity: 'low', why: 'mild' },
] }), draft);
check('parse keeps real sentences, drops invented quotes', parsed.findings.length === 2 && parsed.dropped === 1);
const asLint = groundingToLintFindings({ findings: parsed.findings });
check('high severity becomes an error-level "ungrounded" finding', asLint.some((f) => f.level === 'error' && f.check === 'ungrounded'));
check('low severity becomes a warning', asLint.some((f) => f.level === 'warn' && f.check === 'ungrounded-detail'));
check('lint detail has no em dash', !asLint.some((f) => f.detail.includes('—')));

// ---------------------------------------------------------------- lint checks
hr('lint: client names, known facts, verbatim reuse');
const basePkg = (body) => ({
  post: { title: 'T', slug: 'a-slug', meta_title: 'Meta', meta_description: 'Desc', primary_keyword: 'kw', body_md: body, internal_links: [] },
  social: { linkedin: 'Short post. Full post linked in comments', facebook: 'Short. Link in comments' },
});
const body = (extra) => `Opening thesis.\n\n# T\n\n## One Section\n\n${extra}\n\n## Two\n\nMore.\n\n## Three\n\nEnd.`;

let r = lintGenerationResult(basePkg(body('I built it for Acme Plumbing last year.')), 'kw', { anonymizeNames: ['Acme Plumbing'] });
check('client name is an error', r.findings.some((f) => f.check === 'client-name' && f.level === 'error'));
r = lintGenerationResult(basePkg(body('I built it for a plumbing company owner.')), 'kw', { anonymizeNames: ['Acme Plumbing'] });
check('anonymized description passes', !r.findings.some((f) => f.check === 'client-name'));

r = lintGenerationResult(basePkg(body('Right after ChatGPT launched in late 2023, everything flooded.')), 'kw');
check('ChatGPT-launched-in-2023 is an error', r.findings.some((f) => f.check === 'known-fact'));
r = lintGenerationResult(basePkg(body('Right after ChatGPT launched in late 2022, everything flooded.')), 'kw');
check('late 2022 passes', !r.findings.some((f) => f.check === 'known-fact'));
r = lintGenerationResult(basePkg(body('In the first couple of years after ChatGPT came out in late 2023 the internet flooded.')), 'kw');
check('"came out in late 2023" is caught too', r.findings.some((f) => f.check === 'known-fact'));

const priorSentence = 'The skill that used to require a dedicated person sitting at a desk doing research all day is work a well-built automation can absorb completely.';
const prior = [{ slug: 'earlier-post', body_md: `Intro here.\n\n${priorSentence}\n\nOutro.` }];
check('copied 12+ word run is found', findVerbatimReuse(`New thing. ${priorSentence}`, prior).length === 1);
check('a paraphrase is not', findVerbatimReuse('Research and drafting used to need a person at a desk; a good automation now handles them end to end.', prior).length === 0);
r = lintGenerationResult(basePkg(body(priorSentence)), 'kw', { priorBodies: prior });
check('verbatim reuse is an error-level lint finding', r.findings.some((f) => f.check === 'verbatim-reuse' && f.level === 'error'));

// ------------------------------------------------------------ SerpApi + engine
hr('SerpApi quota handling');
process.env.SERPAPI_API_KEY = 'test-key';
const realFetch = globalThis.fetch;
const respond = (status, body) => async () => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });

globalThis.fetch = respond(429, { error: 'Your account has run out of searches.' });
let err = null;
try { await searchCandidates('q'); } catch (e) { err = e; }
check('HTTP 429 out-of-searches -> SearchQuotaError', err instanceof SearchQuotaError);
globalThis.fetch = respond(200, { error: 'Your account has run out of searches.' });
err = null;
try { await searchCandidates('q'); } catch (e) { err = e; }
check('200 with error field -> SearchQuotaError', err instanceof SearchQuotaError);
globalThis.fetch = respond(500, 'upstream exploded');
err = null;
try { await searchCandidates('q'); } catch (e) { err = e; }
check('500 is a plain error, not a quota error', err && !(err instanceof SearchQuotaError));

// fake supabase: enough surface for the sweep and the engine's profile read
function fakeSupabase(state) {
  const make = (table) => {
    let rows = state[table] ?? (state[table] = []);
    const q = { filters: [], op: 'select', patch: null, single: false };
    const b = {
      select() { return b; },
      eq(k, v) { q.filters.push([k, v]); return b; },
      in() { return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { q.single = true; return b; },
      update(patch) { q.op = 'update'; q.patch = patch; return b; },
      upsert(row) { q.op = 'upsert'; q.patch = row; return b; },
      then(resolve) {
        const match = (r) => q.filters.every(([k, v]) => r[k] === v);
        if (q.op === 'update') { rows.filter(match).forEach((r) => Object.assign(r, q.patch)); return resolve({ data: null, error: null }); }
        if (q.op === 'upsert') {
          const arr = Array.isArray(q.patch) ? q.patch : [q.patch];
          for (const row of arr) { const ex = rows.find((r) => r.key === row.key); if (ex) Object.assign(ex, row); else rows.push({ ...row }); }
          return resolve({ data: null, error: null });
        }
        // copies, like a real database: callers must not see later in-place mutations
        const out = rows.filter(match).map((r) => ({ ...r }));
        return resolve({ data: q.single ? (out[0] ?? null) : out, error: null });
      },
    };
    return b;
  };
  return { from: make };
}

const claimsStub = JSON.stringify([
  { claim: 'c1', sentence: 'Models do not read LLMS.txt.', search_query: 'llms txt' },
  { claim: 'c2', sentence: 'ChatGPT uses Bing.', search_query: 'chatgpt bing' },
]);
const clientsStub = { sonnet: async () => claimsStub, haiku: async () => '{}' };
const profileRows = [
  { key: 'link_client_business_type', value: 'consultant' },
  { key: 'link_client_market', value: 'global' },
];
const bodyMd = 'Models do not read LLMS.txt. ChatGPT uses Bing. Some more filler text to pad the word count here.';

globalThis.fetch = respond(429, { error: 'Your account has run out of searches.' });
let res = await injectExternalLinks({ bodyMd, supabase: fakeSupabase({ system_config: profileRows.map((x) => ({ ...x })) }), clients: clientsStub, log: false });
check('engine: quota error -> outcome quota_exhausted', res.outcome === 'quota_exhausted');
check('engine: stops after the first failed search (no more burn)', res.searchesAttempted === 1, `attempted ${res.searchesAttempted}`);

globalThis.fetch = respond(500, 'boom');
res = await injectExternalLinks({ bodyMd, supabase: fakeSupabase({ system_config: profileRows.map((x) => ({ ...x })) }), clients: clientsStub, log: false });
check('engine: every search errored -> outcome search_failed', res.outcome === 'search_failed');
check('engine: both claims were attempted', res.searchesAttempted === 2 && res.searchFailures === 2);

const emptyClients = { sonnet: async () => '[]', haiku: async () => '{}' };
res = await injectExternalLinks({ bodyMd, supabase: fakeSupabase({ system_config: profileRows.map((x) => ({ ...x })) }), clients: emptyClients, log: false });
check('engine: nothing to cite -> outcome no_claims', res.outcome === 'no_claims');
globalThis.fetch = realFetch;

// --------------------------------------------------------------------- sweep
hr('sweep: stamping, retry, quota');
const post = (over = {}) => ({
  id: 'p1', slug: 's1', body_md: 'Original body.', topic_id: null, status: 'pending_review',
  links_checked_at: null, links_status: null, links_attempts: 0, generated_at: new Date().toISOString(), ...over,
});
const neverCalled = async () => { throw new Error('inject must not be called'); };

let state = { posts: [post()], system_config: [], topics: [] };
let summary = await runLinkSweep({ supabase: fakeSupabase(state), clients: {}, quotaFn: async () => ({ left: 0, limit: 250, renewal: '2026-10-23', plan: 'Free Plan' }), injectFn: neverCalled });
check('quota out: no inject/model/search calls', summary.errors.length === 0);
check('quota out: post stamped so Publish stays enabled', state.posts[0].links_checked_at && state.posts[0].links_status === 'quota_exhausted');
check('quota out: editor alerted once', summary.alerts.length === 1);
summary = await runLinkSweep({ supabase: fakeSupabase(state), clients: {}, quotaFn: async () => ({ left: 0 }), injectFn: neverCalled });
check('quota out: already-stamped retryable post is left alone', summary.processed.length === 0);

state = { posts: [post()], system_config: [{ key: 'link_quota_alert_date', value: new Date().toISOString().slice(0, 10) }], topics: [] };
summary = await runLinkSweep({ supabase: fakeSupabase(state), clients: {}, quotaFn: async () => ({ left: 0 }), injectFn: neverCalled });
check('quota alert is deduped to once per day', summary.alerts.length === 0);

const okResult = (over = {}) => ({
  outcome: 'ok', bodyMd: 'Original body with [a link](https://example.com).', cap: 3, wordCount: 100, claimCount: 2,
  claimsDroppedVerbatim: 0, injected: [{ url: 'https://example.com' }], flagged: [], surplus: [], skipped: [],
  searchesAttempted: 2, searchFailures: 0, ...over,
});
state = { posts: [post()], system_config: [], topics: [] };
summary = await runLinkSweep({ supabase: fakeSupabase(state), clients: {}, quotaFn: async () => ({ left: 100 }), injectFn: async () => okResult() });
check('ok: links written into the body and stamped ok', state.posts[0].body_md.includes('[a link]') && state.posts[0].links_status === 'ok' && state.posts[0].links_checked_at);
check('ok: report stored', state.posts[0].links_report?.injected === 1);

state = { posts: [post()], system_config: [], topics: [] };
summary = await runLinkSweep({ supabase: fakeSupabase(state), clients: {}, quotaFn: async () => ({ left: 100 }), injectFn: async () => okResult({ outcome: 'search_failed', injected: [], searchFailures: 2 }) });
check('search_failed: stamped but marked retryable, attempt counted', state.posts[0].links_status === 'search_failed' && state.posts[0].links_attempts === 1 && state.posts[0].links_checked_at);

state = { posts: [post({ links_status: 'search_failed', links_attempts: 3, links_checked_at: new Date().toISOString() })], system_config: [], topics: [] };
summary = await runLinkSweep({ supabase: fakeSupabase(state), clients: {}, quotaFn: async () => ({ left: 100 }), injectFn: neverCalled });
check('search_failed after max attempts is not retried again', summary.processed.length === 0);

state = { posts: [post()], system_config: [], topics: [] };
summary = await runLinkSweep({
  supabase: fakeSupabase(state), clients: {}, quotaFn: async () => ({ left: 100 }),
  injectFn: async () => { state.posts[0].body_md = 'Editor changed this while the sweep ran.'; return okResult(); },
});
check("editor's concurrent edit is not overwritten", state.posts[0].body_md === 'Editor changed this while the sweep ran.' && state.posts[0].links_report.bodyChangedDuringSweep === true);

// quota monitoring: recorded every run, even with nothing to sweep
state = { posts: [], system_config: [], topics: [] };
summary = await runLinkSweep({ supabase: fakeSupabase(state), clients: {}, quotaFn: async () => ({ left: 247, limit: 250, renewal: '2026-11-16', plan: 'Free Plan' }), injectFn: neverCalled });
const qStatus = JSON.parse(state.system_config.find((r) => r.key === 'link_quota_status').value);
check('quota: latest reading recorded even when there is nothing to sweep', qStatus.left === 247 && qStatus.renewal === '2026-11-16' && qStatus.checkedAt);
let qHistory = JSON.parse(state.system_config.find((r) => r.key === 'link_quota_history').value);
check('quota: one history entry for today', qHistory.length === 1 && qHistory[0].left === 247);
await runLinkSweep({ supabase: fakeSupabase(state), clients: {}, quotaFn: async () => ({ left: 240, limit: 250 }), injectFn: neverCalled });
qHistory = JSON.parse(state.system_config.find((r) => r.key === 'link_quota_history').value);
check('quota: a second run the same day updates the entry instead of adding one', qHistory.length === 1 && qHistory[0].left === 240);
state.system_config.find((r) => r.key === 'link_quota_history').value = JSON.stringify([{ d: '2000-01-01', left: 3 }]);
await runLinkSweep({ supabase: fakeSupabase(state), clients: {}, quotaFn: async () => ({ left: 250, limit: 250 }), injectFn: neverCalled });
qHistory = JSON.parse(state.system_config.find((r) => r.key === 'link_quota_history').value);
check('quota: a new day appends, so a monthly reset shows up as a jump', qHistory.length === 2 && qHistory[0].left === 3 && qHistory[1].left === 250);
await runLinkSweep({ supabase: fakeSupabase(state), clients: {}, quotaFn: async () => { throw new Error('SerpApi account check failed: 401'); }, injectFn: neverCalled });
const qFail = JSON.parse(state.system_config.find((r) => r.key === 'link_quota_status').value);
check('quota: a failed check is recorded so a bad key is visible', /401/.test(qFail.error));
check('quota: a failed check does not erase the history', JSON.parse(state.system_config.find((r) => r.key === 'link_quota_history').value).length === 2);

// ------------------------------------------------------------ talking points
hr('talking points');
const tpBody = 'I think SaaS pricing that does not roll over credits is disingenuous. [OpenAI says](https://openai.com/x) its crawler is separate. For a plumbing company owner I built a pitch system.';
const validated = validatePoints([
  { kind: 'stance', point: 'Credits that expire each month make a usage-based product feel like a subscription trap.', topics: ['saas', 'pricing'], client_ref: null, evidence_url: null },
  { kind: 'claim', point: 'OpenAI documents a crawler that is separate from its training scraper.', topics: ['ai search'], client_ref: null, evidence_url: 'https://openai.com/x' },
  { kind: 'claim', point: 'A made-up claim with an evidence link that is not in the post at all.', topics: [], client_ref: null, evidence_url: 'https://invented.example/y' },
  { kind: 'client_fact', point: 'Acme Plumbing saved hours every week on its pitch drafting.', topics: [], client_ref: null, evidence_url: null },
  { kind: 'client_fact', point: 'A pitch drafting system cut hours of weekly manual work for an agency.', topics: ['automation'], client_ref: 'a plumbing company owner founder', evidence_url: null },
  { kind: 'opinion', point: 'This kind is not allowed so it is dropped from the list.', topics: [], client_ref: null, evidence_url: null },
  { kind: 'stance', point: 'Credits that expire each month make a usage-based product feel like a subscription trap.', topics: [], client_ref: null, evidence_url: null },
  { kind: 'stance', point: 'short', topics: [], client_ref: null, evidence_url: null },
], tpBody);
check('keeps valid points', validated.length === 4, `got ${validated.length}`);
check('drops a point naming a client', !validated.some((p) => /acme plumbing/i.test(p.point)));
check('hallucinated evidence URL is nulled, real one kept',
  validated.find((p) => p.point.startsWith('A made-up')).evidence_url === null && validated.find((p) => p.point.startsWith('OpenAI')).evidence_url === 'https://openai.com/x');
const own = validatePoints([{ kind: 'how_to', point: 'Build a pitch system on top of the autoblog page.', topics: [], client_ref: null, evidence_url: `https://${CLIENT.siteDomain}/autoblog/` }], `See [the autoblog](https://${CLIENT.siteDomain}/autoblog/).`);
check('own-site URLs are not kept as evidence', own[0].evidence_url === null);
check('drops duplicates, bad kinds, too-short points', validated.filter((p) => p.point.startsWith('Credits')).length === 1);

const extractionClient = async () => JSON.stringify([
  { kind: 'stance', point: 'Credits that expire each month make a usage-based product feel like a subscription trap.', topics: ['saas'], client_ref: null, evidence_url: null },
  { kind: 'how_to', point: 'Review robots.txt so search and retrieval bots can reach your key pages.', topics: ['seo', 'robots'], client_ref: null, evidence_url: null },
]);
const extracted = await extractTalkingPoints({ title: 'T', body_md: tpBody }, extractionClient);
check('extract: model output validated', extracted.length === 2);
await indexTalkingPoints({ supabase: null, post: { id: 'post-a', slug: 'saas-post', title: 'The SaaS Post' }, points: extracted });
const got = await retrieveTalkingPoints({ title: 'robots.txt and AI crawlers', description: 'which bots to allow', primary_keyword: 'robots.txt' }, { topN: 5 });
check('retrieve: returns indexed points with a source URL', got.length === 2 && got[0].source_url.endsWith('/blog/saas-post'));
check('retrieve: can exclude the post being regenerated', (await retrieveTalkingPoints({ title: 'x' }, { excludePostId: 'post-a' })).length === 0);

// --------------------------------------------------------- revision prompt
hr('revision prompt');
const rp = buildLintRevisionPrompt({
  call3Response: 'PREVIOUS', sourceMaterial: 'THE TRANSCRIPT TEXT',
  findings: [{ check: 'ungrounded', detail: '[event] "a client messaged me": invented' }, { check: 'client-name', detail: 'client name "X" appears 1x' }],
});
check('grounding findings pull the source material into the revision prompt', rp.includes('THE TRANSCRIPT TEXT') && rp.includes('Never invent a replacement'));
check('revision prompt covers client names and verbatim reuse', rp.includes('role and industry') && rp.includes('verbatim-reuse'));
check('no source material when there is no grounding finding',
  !buildLintRevisionPrompt({ call3Response: 'P', sourceMaterial: 'SECRET', findings: [{ check: 'em-dash', detail: 'x' }] }).includes('SECRET'));

// ---------------------------------------------- engine: grounding + revision
hr('engine: grounding -> revision -> adopted');
const fixtureDir = path.join('content', 'test-fixtures', 'mock-example-run');
const fixturePost = readFileSync(path.join(fixtureDir, 'call3', 'polished-post.md'), 'utf8').replace(/\r\n/g, '\n');
const target = fixturePost.split('\n\n').map((p) => p.trim()).find((p) => p.length > 60 && !p.startsWith('#'));
const baseClient = createMockClient({ fixtureDir, primaryKeyword: 'example keyword' });
const labels = [];
const flaggingClient = async (req) => {
  labels.push(req.label);
  if (req.label === 'grounding') {
    return JSON.stringify({ ungrounded: [{ sentence: target.slice(0, 120), type: 'event', severity: 'high', why: 'not in the recording' }] });
  }
  if (req.label === 'lint-revision') return baseClient({ label: 'call3' });
  return baseClient(req);
};
const engineInputs = {
  topicTitle: 'Example', topicDescription: 'd', primaryKeyword: 'example keyword', guidingQuestions: [], transcript: 'A short transcript.',
  priorPosts: [], ragFlag: false, ragChunks: null, talkingPoints: [], priorBodies: [],
};
const gen = await runGeneration(engineInputs, flaggingClient);
check('engine: grounding finding triggers a revision pass', gen.revision?.attempted === true, JSON.stringify(gen.revision));
check('engine: re-check runs after the revision', labels.includes('grounding-recheck'));
check('engine: revision adopted and cleared', gen.revision?.adopted === true && gen.revision?.cleared === true);
check('engine: nothing left blocking after the fix', gen.grounding.blocking === false);

const stubbornClient = async (req) => {
  if (req.label === 'grounding' || req.label === 'grounding-recheck') {
    return JSON.stringify({ ungrounded: [{ sentence: target.slice(0, 120), type: 'event', severity: 'high', why: 'not in the recording' }] });
  }
  if (req.label === 'lint-revision') return baseClient({ label: 'call3' });
  return baseClient(req);
};
const gen2 = await runGeneration(engineInputs, stubbornClient);
check('engine: revision that does not reduce errors is not adopted', gen2.revision?.adopted === false);
check('engine: unresolved grounding error blocks auto-publish', gen2.grounding.blocking === true && gen2.grounding.findings.length >= 1);

const brokenVerifier = async (req) => {
  if (req.label === 'grounding' || req.label === 'grounding-recheck') throw new Error('verifier API down');
  return baseClient(req);
};
const gen3 = await runGeneration(engineInputs, brokenVerifier);
check('engine: verifier outage does not kill the post', Boolean(gen3.package?.post?.body_md) && gen3.grounding.checked === false && gen3.grounding.blocking === false);

// ------------------------------------------------------------------- summary
const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) { console.log('FAILED:\n' + failed.map((c) => `  - ${c.name}`).join('\n')); process.exit(1); }
