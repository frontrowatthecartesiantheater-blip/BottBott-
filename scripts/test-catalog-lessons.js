// Offline tests for the link catalog, the recording check, and edit lessons,
// plus the prompt and engine wiring that uses them. No credentials, no network.
//
// Usage: node scripts/test-catalog-lessons.js

process.env.PIPELINE_MOCK = '1';

import { readFileSync } from 'node:fs';
import path from 'node:path';

const { parseRss, parseSitemapPostUrls, parseOgMeta, syncCatalog, retrieveCatalog, resolveLinkRequests, _seedMockCatalog } = await import('../lib/catalog.js');
const { analyzeTranscript, describeWarnings } = await import('../lib/transcript-check.js');
const { editSimilarity, validateLessons, backfillLessons } = await import('../lib/edit-lessons.js');
const { buildCall1Prompt, buildCall2Prompt, buildCall3Prompt, buildPrePassPrompt } = await import('../lib/generation/prompts.js');
const { runGeneration } = await import('../lib/generation/engine.js');
const { createMockClient } = await import('../lib/generation/mock-client.js');
const { embedOne } = await import('../lib/embeddings.js');
const { SITE_ORIGIN, CLIENT } = await import('../lib/client-config.js');
// The tests set the client values they depend on, so they pass for any client build.
CLIENT.anonymizeNames = ['Acme Plumbing'];
CLIENT.substackDomain = 'example.substack.com';

const checks = [];
const check = (name, cond, extra = '') => { checks.push({ name, pass: Boolean(cond) }); if (!cond) console.log(`  FAIL ${name} ${extra}`); };
const hr = (t) => console.log(`\n=== ${t}`);

// In-memory stand-in for the slice of supabase-js these modules use.
function fakeSupabase(state) {
  const make = (table) => {
    const rows = state[table] ?? (state[table] = []);
    const q = { filters: [], op: 'select', patch: null, single: false, conflict: 'key' };
    const b = {
      select() { return b; },
      eq(k, v) { q.filters.push([k, v]); return b; },
      in() { return b; }, is() { return b; }, not() { return b; }, or() { return b; },
      order() { return b; }, limit() { return b; },
      maybeSingle() { q.single = true; return b; },
      update(patch) { q.op = 'update'; q.patch = patch; return b; },
      insert(r) { q.op = 'insert'; q.patch = r; return b; },
      upsert(r, opts) { q.op = 'upsert'; q.patch = r; q.conflict = opts?.onConflict ?? 'key'; return b; },
      then(resolve) {
        const match = (r) => q.filters.every(([k, v]) => r[k] === v);
        if (q.op === 'update') { rows.filter(match).forEach((r) => Object.assign(r, q.patch)); return resolve({ data: null, error: null }); }
        if (q.op === 'insert') { (Array.isArray(q.patch) ? q.patch : [q.patch]).forEach((r) => rows.push({ ...r })); return resolve({ data: null, error: null }); }
        if (q.op === 'upsert') {
          for (const row of Array.isArray(q.patch) ? q.patch : [q.patch]) {
            const ex = rows.find((r) => r[q.conflict] === row[q.conflict]);
            if (ex) Object.assign(ex, row); else rows.push({ ...row });
          }
          return resolve({ data: null, error: null });
        }
        const out = rows.filter(match).map((r) => ({ ...r }));
        return resolve({ data: q.single ? (out[0] ?? null) : out, error: null });
      },
    };
    return b;
  };
  return { from: make };
}

// ---------------------------------------------------------------- catalog
hr('catalog: parsing');
const rss = `<?xml version="1.0"?><rss><channel><title>Example Blog</title>
<item><title><![CDATA[Building the Nuance Layer]]></title><link>https://example.substack.com/p/building-the-nuance-layer</link>
<description><![CDATA[How to make a system think like a person &amp; handle nuance]]></description><pubDate>Fri, 02 Oct 2026 12:00:00 GMT</pubDate></item>
<item><title>Not a post</title><link>https://example.substack.com/about</link></item>
</channel></rss>`;
const items = parseRss(rss);
check('rss: items parsed with CDATA and entities decoded', items.length === 2 && items[0].title === 'Building the Nuance Layer' && items[0].summary.includes('& handle nuance'));
check('rss: pubDate becomes ISO', items[0].published_at === '2026-10-02T12:00:00.000Z');
const sitemap = '<urlset><url><loc>https://example.substack.com/p/older-post</loc></url><url><loc>https://example.substack.com/about</loc></url></urlset>';
check('sitemap: only /p/ post URLs', JSON.stringify(parseSitemapPostUrls(sitemap)) === JSON.stringify(['https://example.substack.com/p/older-post']));
const og = parseOgMeta('<meta property="og:title" content="An Older Post"><meta content="Its &quot;subtitle&quot;" property="og:description">');
check('og meta: title and description (either attribute order)', og.title === 'An Older Post' && og.summary === 'Its "subtitle"');

hr('catalog: sync and retrieval');
const state = {
  posts: [{ status: 'published', slug: 'blogging-in-the-age-of-ai', title: 'Why Blogging in the Age of AI Matters More Than Ever', meta_description: 'EEAT and AI content.', published_at: '2026-09-03T12:00:00Z' }],
  content_catalog: [], system_config: [],
};
const fakeFetch = async (url) => {
  const u = String(url);
  const body = u.endsWith('/feed') ? rss : u.endsWith('/sitemap.xml') ? sitemap : u.includes('/p/older-post') ? '<meta property="og:title" content="An Older Post"><meta property="og:description" content="From before the feed window.">' : '';
  return { ok: true, status: 200, text: async () => body };
};
let sync = await syncCatalog({ supabase: fakeSupabase(state), fetchFn: fakeFetch });
check('sync: blog + substack entries found', sync.blog === 1 && sync.substack === 2, JSON.stringify(sync));
check('sync: sitemap-only post picked up via its page', state.content_catalog.some((r) => r.title === 'An Older Post' && r.source === 'substack'));
check('sync: blog URL is the real /blog/ URL', state.content_catalog.some((r) => r.url === `${SITE_ORIGIN}/blog/blogging-in-the-age-of-ai`));
check('sync: embeddings stored', sync.embedded === 3 && state.content_catalog.every((r) => Array.isArray(r.embedding)));
sync = await syncCatalog({ supabase: fakeSupabase(state), fetchFn: fakeFetch });
check('sync: a second run within 12h is skipped', Boolean(sync.skipped));
sync = await syncCatalog({ supabase: fakeSupabase(state), fetchFn: fakeFetch, force: true });
check('sync: forced re-run embeds nothing unchanged', sync.embedded === 0, JSON.stringify(sync));

const failingSubstack = async () => { throw new Error('substack down'); };
const state2 = { posts: state.posts, content_catalog: [], system_config: [] };
sync = await syncCatalog({ supabase: fakeSupabase(state2), fetchFn: failingSubstack, force: true });
check('sync: a Substack outage still syncs the blog and reports the error', sync.blog === 1 && sync.errors.some((e) => e.source === 'substack'));
check('sync: an outage does not stamp the sync time', !state2.system_config.some((r) => r.key === 'catalog_synced_at'));

// mock retrieval: seed with embeddings of "title. summary" so an identical query matches exactly
const seed = async (source, url, title, summary) => ({ source, url, title, summary, embedding: await embedOne(`${title}. ${summary}`) });
_seedMockCatalog([
  await seed('blog', `${SITE_ORIGIN}/blog/blogging-in-the-age-of-ai`, 'Why Blogging in the Age of AI Matters More Than Ever', 'EEAT and AI content.'),
  await seed('substack', 'https://example.substack.com/p/building-the-nuance-layer', 'Building the Nuance Layer', 'How to make a system think like a person.'),
]);
const hit = await retrieveCatalog('Building the Nuance Layer. How to make a system think like a person.', { topN: 1 });
check('retrieve: closest entry first', hit[0]?.url === 'https://example.substack.com/p/building-the-nuance-layer');
const onlyBlog = await retrieveCatalog('Building the Nuance Layer. How to make a system think like a person.', { topN: 5, source: 'blog' });
check('retrieve: can be limited to one source', onlyBlog.length === 1 && onlyBlog[0].source === 'blog');
check('retrieve: empty text returns nothing', (await retrieveCatalog('   ')).length === 0);
const resolved = await resolveLinkRequests([{ mention: 'system link to that post', describes: 'Building the Nuance Layer. How to make a system think like a person.' }, { mention: '', describes: '' }]);
check('link requests: resolved to a real catalog URL, blanks skipped', resolved.length === 1 && resolved[0].match.url.endsWith('building-the-nuance-layer'));

// ------------------------------------------------------- recording check
hr('recording check');
const seg = (start, end, text, extra = {}) => ({ start, end, text, avg_logprob: -0.3, compression_ratio: 1.4, no_speech_prob: 0.02, ...extra });
const corrupted = analyzeTranscript({
  text: 'The biggest misconception I hear is that AI search replaces Google. '.repeat(26) + 'Maybe one thing to do is to diversify. Yeah. Yeah. Yeah. Yeah.',
  duration: 310,
  segments: [
    seg(0, 55, 'The biggest misconception I hear'), seg(55, 62, 'is that AI search replaces Google.'),
    seg(160, 230, 'So what it really comes down to is SEO.'), seg(230, 288, 'Maybe one thing to do is to diversify.'),
    seg(288, 291, 'Yeah.'), seg(291, 294, 'Yeah.'), seg(294, 297, 'Yeah.'), seg(297, 300, 'Yeah.'),
  ],
});
check('flags the ~98 second gap with timestamps', corrupted.warnings.some((w) => w.type === 'gap' && /1:02 to 2:40/.test(w.detail)));
check('flags the looping "Yeah." tail', corrupted.warnings.some((w) => w.type === 'loop' && /Yeah\./.test(w.detail)));
check('flags too few words for the audio length', corrupted.warnings.some((w) => w.type === 'thin'));
check('not ok, and every warning reads as a sentence', !corrupted.ok && describeWarnings(corrupted).every((s) => s.length > 20));

const clean = analyzeTranscript({
  text: Array.from({ length: 140 }, (_, i) => `word${i}`).join(' ') + '.', duration: 60,
  segments: [seg(0, 20, 'a b c d e f g h.'), seg(21, 40, 'i j k l.'), seg(42, 58, 'm n o p.')],
});
check('a clean, continuous recording passes', clean.ok && clean.warnings.length === 0, JSON.stringify(clean.warnings));
check('a short memo is not judged on pace', analyzeTranscript({ text: 'Quick note about the topic and nothing else.', duration: 30, segments: [seg(0, 29, 'Quick note about the topic and nothing else.')] }).ok);
const hallucinated = analyzeTranscript({ text: 'ok then. '.repeat(30), duration: 100, segments: [seg(0, 10, 'ok then', { compression_ratio: 3.1 }), seg(10, 50, 'ok then ok then ok then.', { no_speech_prob: 0.9, avg_logprob: -1.4 })] });
check('flags segments the transcriber distrusts', hallucinated.warnings.some((w) => w.type === 'unreliable'));
const lone = analyzeTranscript({ text: 'You', duration: 30, segments: [{ id: 0, start: 0, end: 2, text: ' You', avg_logprob: -0.93, compression_ratio: 0.27, no_speech_prob: 0.50 }] });
check('a lone hallucinated word over a dead stretch is flagged (real Whisper values)', lone.warnings.some((w) => w.type === 'unreliable'));
const speech = analyzeTranscript({ text: 'Normal confident speech here.', duration: 30, segments: [seg(0, 29, 'Normal confident speech here.', { avg_logprob: -0.25, no_speech_prob: 0.03 })] });
check('confident speech is not flagged', speech.ok);
const noSegments = analyzeTranscript({ text: 'A document pasted in as the transcript.', duration: null, segments: [] });
check('no timing data: no false alarms', noSegments.ok);

// --------------------------------------------------------- edit lessons
hr('edit lessons');
const gen = 'A business owner messaged me last week asking about SEO. The bar isn\'t higher because AI raised it. The bar is higher because the noise got loud.';
check('similarity: identical text is 1', editSimilarity(gen, gen) === 1);
check('similarity: a rewrite is well below 1', editSimilarity(gen, 'Marketers claim SEO is dead and replaced by AEO. The bar is now higher because the noise got loud enough.') < 0.5);
const lessons = validateLessons([
  { category: 'opener', lesson: 'Never open with an anecdote the recording does not contain; open with his stated position.', before: 'A business owner messaged me last week', after: 'A lot of "expert" marketers are claiming SEO is dead.' },
  { category: 'style', lesson: 'Do not write paired contrasts such as "The bar isn\'t X because A. The bar is Y because B."', before: 'x', after: 'y' },
  { category: 'nonsense', lesson: 'Always link the first mention of a named platform to its own documentation.' },
  { category: 'facts', lesson: 'Acme Plumbing prefers pitches under 200 words.', before: '', after: '' },
  { category: 'opener', lesson: 'Never open with an anecdote the recording does not contain; open with his stated position.' },
  { category: 'style', lesson: 'short' },
]);
check('lessons: valid ones kept, client-name / short / duplicate dropped', lessons.length === 3, `got ${lessons.length}`);
check('lessons: unknown category falls back to other', lessons.find((l) => l.lesson.startsWith('Always link')).category === 'other');

const lessonState = {
  posts: [
    { id: 'p-same', slug: 'same', title: 'Same', status: 'published', body_md: 'Exactly what the model wrote, nothing changed at all in here.', body_md_generated: 'Exactly what the model wrote, nothing changed at all in here.', lessons_extracted_at: null },
    { id: 'p-edit', slug: 'edited', title: 'Edited', status: 'published', body_md: 'Marketers claim SEO is dead and replaced by AEO. The bar is now higher because the noise got loud enough.', body_md_generated: gen, lessons_extracted_at: null },
  ],
  edit_lessons: [],
};
let modelCalls = 0;
const lessonClient = async () => { modelCalls += 1; return JSON.stringify([{ category: 'opener', lesson: 'Never open with an anecdote the recording does not contain; open with his stated position.', before: 'A business owner messaged me', after: 'Marketers claim SEO is dead' }]); };
const lr = await backfillLessons({ supabase: fakeSupabase(lessonState), client: lessonClient, limit: 5 });
check('backfill: an untouched post costs no model call', modelCalls === 1);
check('backfill: both posts stamped with their similarity', lessonState.posts.every((p) => p.lessons_extracted_at) && lessonState.posts[0].edit_similarity === 1 && lessonState.posts[1].edit_similarity < 0.5);
check('backfill: new lessons arrive pending, linked to the post', lessonState.edit_lessons.length === 1 && lessonState.edit_lessons[0].status === undefined && lessonState.edit_lessons[0].source_post_id === 'p-edit');
check('backfill: no errors', lr.errors.length === 0, JSON.stringify(lr.errors));

// ------------------------------------------------------------ prompt wiring
hr('prompts');
const base = {
  topicTitle: 'T', topicDescription: 'd', primaryKeyword: 'kw', guidingQuestions: [], transcript: 'A short transcript.',
  priorPosts: [], ragFlag: false, ragChunks: null, talkingPoints: [], dynamicTov: {},
};
const rich = {
  ...base,
  editorLessons: ['Never open with an anecdote the recording does not contain.'],
  catalog: [{ source: 'substack', title: 'Building the Nuance Layer', url: 'https://example.substack.com/p/building-the-nuance-layer', summary: 'How to make a system think like a person.' }],
  requestedLinks: [{ mention: 'system link to that post', describes: 'how models browse the web', match: { title: 'Why Blogging in the Age of AI', url: `${SITE_ORIGIN}/blog/blogging-in-the-age-of-ai`, similarity: 0.52 } }, { mention: 'link my other piece', describes: 'something unmatched', match: null }],
  transcriptCheck: { warnings: [{ type: 'gap', detail: 'no speech from 1:02 to 2:40 (98 seconds)' }] },
};
const c1 = buildCall1Prompt(rich);
check('call 1: catalog URLs offered as link targets', c1.includes('LINK CATALOG') && c1.includes('p/building-the-nuance-layer'));
check('call 1: a matched spoken request is handed over with its URL', c1.includes('LINKS REQUESTED IN THE RECORDING') && c1.includes('blog/blogging-in-the-age-of-ai'));
check('call 1: an unmatched request says not to guess', c1.includes('Do not guess a URL'));
check('call 1: prefers a specific post to a home page', c1.includes("Prefer a specific post here over a site's home page"));
check('call 1: approved lessons and recording problems included', c1.includes('LESSONS FROM') && c1.includes('RECORDING PROBLEMS') && c1.includes('1:02 to 2:40'));
check('call 1: spoken instructions are marked as not content', c1.includes('instructions, not content'));
const c1plain = buildCall1Prompt(base);
check('call 1: no empty sections when there is nothing to add', !c1plain.includes('## LINK CATALOG') && !c1plain.includes('## LINKS REQUESTED IN THE RECORDING') && !c1plain.includes('## RECORDING PROBLEMS') && !c1plain.includes('## LESSONS FROM'));
const c2 = buildCall2Prompt({ ...rich, call1Output: 'PLAN' });
check('call 2: lessons, recording problems, and the spoken-instruction rule', c2.includes('LESSONS FROM') && c2.includes('RECORDING PROBLEMS') && c2.includes('SPOKEN INSTRUCTIONS ARE NOT CONTENT'));
check('call 3: lessons included', buildCall3Prompt({ ...rich, call2Output: 'DRAFT' }).includes('LESSONS FROM'));
check('pre-pass: asks for link requests', buildPrePassPrompt({ transcript: 'x' }).includes('link_requests'));

// ---------------------------------------------- engine: link requests flow
hr('engine: spoken link request -> catalog -> plan');
const fixtureDir = path.join('content', 'test-fixtures', 'mock-example-run');
const baseClient = createMockClient({ fixtureDir, primaryKeyword: 'example keyword' });
const prepass = JSON.parse(readFileSync(path.join(fixtureDir, 'prepass.json'), 'utf8'));
const lrClient = async (req) => {
  if (req.label === 'prepass') {
    return JSON.stringify({ ...prepass, link_requests: [{ mention: 'system link to that post, please', describes: 'Building the Nuance Layer. How to make a system think like a person.' }] });
  }
  return baseClient(req);
};
const result = await runGeneration({
  topicTitle: 'Example', topicDescription: 'd', primaryKeyword: 'example keyword', guidingQuestions: [], transcript: 'I wrote a post about that, system link to that post, please.',
  priorPosts: [], ragFlag: false, ragChunks: null, talkingPoints: [], priorBodies: [],
}, lrClient);
const call1Prompt = result.artifacts.find((a) => a.label === 'call1').prompt;
check('engine: the request resolves to the real post and reaches the structure pass', result.requestedLinks[0]?.match?.url?.endsWith('building-the-nuance-layer') && call1Prompt.includes('building-the-nuance-layer'));
check('engine: link requests are kept out of the tone-of-voice signals', !('link_requests' in result.dynamicTov) && !call1Prompt.includes('link_requests'));
const legacy = await runGeneration({
  topicTitle: 'Example', topicDescription: 'd', primaryKeyword: 'example keyword', guidingQuestions: [], transcript: 't',
  priorPosts: [], ragFlag: false, ragChunks: null, talkingPoints: [], priorBodies: [],
}, baseClient);
check('engine: an older pre-pass without link_requests still works', Array.isArray(legacy.requestedLinks) && legacy.requestedLinks.length === 0);

// ------------------------------------------------------------------- summary
const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) { console.log('FAILED:\n' + failed.map((c) => `  - ${c.name}`).join('\n')); process.exit(1); }
