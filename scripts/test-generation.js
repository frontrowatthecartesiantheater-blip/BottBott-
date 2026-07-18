// M3 test harness: run the full generation pipeline against a transcript
// and topic, writing every prompt, response, and parsed output to a run
// directory for review.
//
// Usage:
//   node scripts/test-generation.js --topic content/test-fixtures/topic-website.json \
//     --transcript content/test-fixtures/transcript-2026-06-11.txt \
//     [--mock content/test-fixtures/mock-website-run] [--out content/test-runs/NAME]
//
// Without --mock, requires ANTHROPIC_API_KEY (live run against claude-sonnet-4-6).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runGeneration } from '../lib/generation/engine.js';

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

const topicFile = argValue('--topic');
const transcriptFile = argValue('--transcript');
const mockDir = argValue('--mock');
if (!topicFile || !transcriptFile) {
  console.error('usage: node scripts/test-generation.js --topic <file> --transcript <file> [--mock <dir>] [--out <dir>]');
  process.exit(1);
}

const topic = JSON.parse(readFileSync(topicFile, 'utf8').replace(/^﻿/, ''));
const transcript = readFileSync(transcriptFile, 'utf8').trim();
const priorPosts = JSON.parse(readFileSync('blog/index.json', 'utf8')).posts
  .slice(0, 5)
  .map((p) => ({ title: p.title, slug: p.slug }));

const inputs = {
  topicTitle: topic.title,
  topicDescription: topic.description,
  primaryKeyword: topic.primary_keyword,
  guidingQuestions: topic.guiding_questions,
  transcript,
  priorPosts,
  ragFlag: false,
  ragChunks: null,
};

let client;
if (mockDir) {
  const { createMockClient } = await import('../lib/generation/mock-client.js');
  client = createMockClient({ fixtureDir: mockDir, primaryKeyword: topic.primary_keyword });
  console.log(`MOCK RUN: responses served from ${mockDir} (no API calls)`);
} else {
  try { process.loadEnvFile(); } catch { /* rely on environment */ }
  const { createAnthropicClient } = await import('../lib/generation/anthropic.js');
  client = createAnthropicClient();
  console.log('LIVE RUN against the Anthropic API');
}

const outDir = argValue('--out')
  || path.join('content', 'test-runs', `${new Date().toISOString().slice(0, 10)}-${topic.primary_keyword.replace(/\s+/g, '-').toLowerCase()}`);
mkdirSync(outDir, { recursive: true });

const result = await runGeneration(inputs, client);

writeFileSync(path.join(outDir, '00-inputs.json'), JSON.stringify({ topic, mock: Boolean(mockDir) }, null, 2));
for (const [i, artifact] of result.artifacts.entries()) {
  const n = String(i + 1).padStart(2, '0');
  writeFileSync(path.join(outDir, `${n}-${artifact.label}-prompt.txt`), artifact.prompt);
  writeFileSync(path.join(outDir, `${n}-${artifact.label}-response.txt`), artifact.response);
}
writeFileSync(path.join(outDir, '90-post.md'), result.package.post.body_md);
writeFileSync(path.join(outDir, '91-linkedin.txt'), result.package.social.linkedin);
writeFileSync(path.join(outDir, '92-facebook.txt'), result.package.social.facebook);
writeFileSync(path.join(outDir, '93-craft-audit.txt'), result.craftAudit ?? '(none)');
writeFileSync(path.join(outDir, '94-package.json'), JSON.stringify(result.package, null, 2));
writeFileSync(path.join(outDir, '95-lint-report.json'), JSON.stringify(result.lint, null, 2));

console.log(`\nrun artifacts written to ${outDir}`);
console.log(`post: "${result.package.post.title}" (${result.lint.wordCount} words, keyword x${result.lint.keywordCount})`);
console.log(`lint: ${result.lint.ok ? 'PASS' : 'FAIL'}`);
for (const f of result.lint.findings) {
  console.log(`  [${f.level}] ${f.check}: ${f.detail}`);
}
if (result.lint.findings.length === 0) console.log('  no findings');
