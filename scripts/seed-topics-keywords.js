// One-time seed for the keyword-tracking rework (migration 0002).
//
// Inserts, in FK-safe order:
//   1. topics            (content/seed/topics.json, literal scheduled_date)
//   2. keywords          (content/seed/keywords.json, term + tier)
//   3. topic_keywords    (resolved from each topic's supporting_keywords terms)
//
// Safe to re-run: checks for existing rows before inserting (topics by
// order_index, keywords by term, join rows by the composite key) so a partial
// run can be resumed without creating duplicates. Existing topics are never
// overwritten — if a topic order_index already exists it is left untouched and
// counted as skipped.
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env (never hardcoded).
//
// Usage:
//   node scripts/seed-topics-keywords.js [--dry-run]
//
// --dry-run validates the seed files and resolves the topic->keyword mapping
// without connecting to Supabase or writing anything.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const seedDir = join(here, '..', 'content', 'seed');
const dryRun = process.argv.includes('--dry-run');

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// Strip a UTF-8 BOM if present; Windows editors and PowerShell add one.
function readJson(name) {
  const path = join(seedDir, name);
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    fail(`could not read ${name}: ${err.message}`);
  }
}

const topics = readJson('topics.json');
const keywords = readJson('keywords.json');

if (!Array.isArray(topics) || topics.length === 0) fail('topics.json must be a non-empty array');
if (!Array.isArray(keywords) || keywords.length === 0) fail('keywords.json must be a non-empty array');

// --- validate the keyword set and resolve the mapping up front -------------

const keywordTerms = new Set(keywords.map((k) => k.term));
if (keywordTerms.size !== keywords.length) fail('duplicate term in keywords.json');

for (const t of topics) {
  if (!Array.isArray(t.supporting_keywords) || t.supporting_keywords.length !== 2) {
    fail(`topic #${t.order_index} must list exactly 2 supporting_keywords`);
  }
  for (const term of t.supporting_keywords) {
    if (!keywordTerms.has(term)) {
      fail(`topic #${t.order_index} references unknown keyword term "${term}"`);
    }
  }
}

const expectedJoinRows = topics.reduce((n, t) => n + t.supporting_keywords.length, 0);
console.log(
  `validated ${topics.length} topics, ${keywords.length} keywords, ` +
    `${expectedJoinRows} topic_keywords pairs from ${seedDir}`,
);

if (dryRun) {
  for (const t of topics) {
    console.log(`  #${String(t.order_index).padStart(2, ' ')} ${t.scheduled_date} [${t.category}] ${t.title}`);
    console.log(`        primary: ${t.primary_keyword}`);
    console.log(`        support: ${t.supporting_keywords.join(' | ')}`);
  }
  console.log('dry run: no database writes');
  process.exit(0);
}

// --- connect and seed ------------------------------------------------------

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on the environment
}

const { getSupabaseClient } = await import('../lib/supabase.js');
const supabase = getSupabaseClient();

// 1. topics ------------------------------------------------------------------
const { data: existingTopics, error: topicReadErr } = await supabase
  .from('topics')
  .select('id, order_index');
if (topicReadErr) fail(`topics read failed: ${topicReadErr.message}`);

const existingTopicIndexes = new Set(existingTopics.map((t) => t.order_index));
const topicsToInsert = topics
  .filter((t) => !existingTopicIndexes.has(t.order_index))
  .map((t) => ({
    order_index: t.order_index,
    title: t.title,
    primary_keyword: t.primary_keyword,
    scheduled_date: t.scheduled_date,
    category: t.category,
    status: t.status ?? 'upcoming',
  }));

let topicsInserted = 0;
if (topicsToInsert.length > 0) {
  const { error } = await supabase.from('topics').insert(topicsToInsert);
  if (error) fail(`topics insert failed: ${error.message}`);
  topicsInserted = topicsToInsert.length;
}
const topicsSkipped = topics.length - topicsInserted;
console.log(
  `topics: inserted ${topicsInserted}, skipped ${topicsSkipped} ` +
    `(${existingTopics.length} already existed before this run)`,
);

// 2. keywords ----------------------------------------------------------------
const { data: existingKeywords, error: kwReadErr } = await supabase
  .from('keywords')
  .select('id, term');
if (kwReadErr) fail(`keywords read failed: ${kwReadErr.message}`);

const existingTerms = new Set(existingKeywords.map((k) => k.term));
const keywordsToInsert = keywords.filter((k) => !existingTerms.has(k.term));

let keywordsInserted = 0;
if (keywordsToInsert.length > 0) {
  const { error } = await supabase.from('keywords').insert(keywordsToInsert);
  if (error) fail(`keywords insert failed: ${error.message}`);
  keywordsInserted = keywordsToInsert.length;
}
console.log(`keywords: inserted ${keywordsInserted}, skipped ${keywords.length - keywordsInserted}`);

// 3. topic_keywords ----------------------------------------------------------
// Re-read both tables so newly inserted rows are resolvable by their ids.
const { data: topicRows, error: tErr } = await supabase.from('topics').select('id, order_index');
if (tErr) fail(`topics re-read failed: ${tErr.message}`);
const { data: keywordRows, error: kErr } = await supabase.from('keywords').select('id, term');
if (kErr) fail(`keywords re-read failed: ${kErr.message}`);

const topicIdByIndex = new Map(topicRows.map((t) => [t.order_index, t.id]));
const keywordIdByTerm = new Map(keywordRows.map((k) => [k.term, k.id]));

const desiredJoins = [];
for (const t of topics) {
  const topicId = topicIdByIndex.get(t.order_index);
  if (!topicId) fail(`could not resolve topic id for order_index ${t.order_index}`);
  for (const term of t.supporting_keywords) {
    const keywordId = keywordIdByTerm.get(term);
    if (!keywordId) fail(`could not resolve keyword id for term "${term}"`);
    desiredJoins.push({ topic_id: topicId, keyword_id: keywordId });
  }
}

const { data: existingJoins, error: jReadErr } = await supabase
  .from('topic_keywords')
  .select('topic_id, keyword_id');
if (jReadErr) fail(`topic_keywords read failed: ${jReadErr.message}`);

const existingJoinKeys = new Set(existingJoins.map((j) => `${j.topic_id}:${j.keyword_id}`));
const joinsToInsert = desiredJoins.filter((j) => !existingJoinKeys.has(`${j.topic_id}:${j.keyword_id}`));

let joinsInserted = 0;
if (joinsToInsert.length > 0) {
  const { error } = await supabase.from('topic_keywords').insert(joinsToInsert);
  if (error) fail(`topic_keywords insert failed: ${error.message}`);
  joinsInserted = joinsToInsert.length;
}
console.log(`topic_keywords: inserted ${joinsInserted}, skipped ${desiredJoins.length - joinsInserted}`);

console.log('seed complete.');
