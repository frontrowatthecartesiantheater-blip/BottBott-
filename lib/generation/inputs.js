// Generation inputs for a topic, shared by the cron (lib/cron.js) and the
// manual draft endpoint (api/admin/draft.js) so both feed the pipeline the same
// way. Before this, the two had drifted: the endpoint still passed prior posts
// as bare slugs (the July 2026 incident the cron path had already fixed), and
// neither knew about talking points or the verbatim-reuse check.
//
// Path A = voice memo (transcript); Path B = RAG fallback (no memo).

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SITE_ORIGIN } from '../client-config.js';
import { getPublishedBodies } from '../cron-data.js';
import { retrieveChunks, formatChunksForPrompt } from '../rag.js';
import { retrieveTalkingPoints } from '../talking-points.js';
import { retrieveCatalog } from '../catalog.js';
import { getApprovedLessons } from '../edit-lessons.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readPriorPosts() {
  try {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'blog', 'index.json'), 'utf8'));
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

/**
 * @param {{ topic: object, memo: object|null }} args  memo null => RAG fallback
 * @returns {Promise<{ inputs: object, mode: 'voice_memo'|'rag_fallback', voiceMemoId: string|null }>}
 */
export async function buildGenerationInputs({ topic, memo }) {
  const baseInputs = {
    topicTitle: topic.title,
    topicDescription: topic.description,
    primaryKeyword: topic.primary_keyword,
    guidingQuestions: topic.guiding_questions || [],
    priorPosts: readPriorPosts(),
    // Best-effort extras: generation must never fail because the memory or the
    // reuse check is unavailable.
    talkingPoints: await retrieveTalkingPoints(topic),
    // The author's own published posts (blog + optional second site) related to the topic,
    // as real link targets.
    catalog: await retrieveCatalog([topic.title, topic.description, topic.primary_keyword].filter(Boolean).join('. '), { topN: 6, minSimilarity: 0.3 }),
    // Lessons the editor approved from earlier edits.
    editorLessons: await getApprovedLessons(),
    // Recording problems found when the memo was transcribed, if any.
    transcriptCheck: memo?.transcript_check ?? null,
    priorBodies: await getPublishedBodies().catch((err) => {
      console.warn(`published bodies unavailable, skipping verbatim-reuse check: ${err.message}`);
      return [];
    }),
  };

  if (memo) {
    return {
      inputs: { ...baseInputs, transcript: memo.transcript, ragFlag: false, ragChunks: null },
      mode: 'voice_memo',
      voiceMemoId: memo.id,
    };
  }
  const chunks = await retrieveChunks(topic);
  return {
    inputs: {
      ...baseInputs,
      transcript: null,
      ragFlag: true,
      ragChunks: chunks.length ? formatChunksForPrompt(chunks) : '(no related content found in the database)',
    },
    mode: 'rag_fallback',
    voiceMemoId: null,
  };
}
