// Seed Supabase topics from a JSON file with auto-scheduling. Validates
// input before touching the database; --dry-run validates and prints
// without connecting.
//
// Usage:
//   node scripts/seed.js topics content/seed/topics.json --start-date 2026-07-02 [--dry-run]
//
// Topic scheduling: topic with order_index 1 publishes on --start-date,
// each subsequent topic 6 days after the previous (start + (order_index - 1) * 6).
//
// For seeding topics WITH literal dates plus the keywords / topic_keywords
// tables (the reworked keyword design), use scripts/seed-topics-keywords.js
// instead — keywords are no longer seeded through this script.

import { readFileSync, existsSync } from 'node:fs';
import { CLIENT } from '../lib/client-config.js';

// Valid topic categories come from client-config.js (must match the CHECK
// constraint in supabase/schema.sql).
const CATEGORIES = CLIENT.topicCategories;
const PUBLISH_INTERVAL_DAYS = 6;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const positional = args.filter((a) => !a.startsWith('--'));
const [table, inputFile] = positional;
const startDateArg = args.includes('--start-date') ? args[args.indexOf('--start-date') + 1] : null;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

if (table !== 'topics') {
  fail('first argument must be "topics" (keywords are seeded by scripts/seed-topics-keywords.js)');
}
if (!inputFile || !existsSync(inputFile)) {
  fail(`input file not found: ${inputFile}`);
}

// Strip a UTF-8 BOM if present; Windows editors and PowerShell add one.
const rows = JSON.parse(readFileSync(inputFile, 'utf8').replace(/^﻿/, ''));
if (!Array.isArray(rows) || rows.length === 0) {
  fail('input file must be a non-empty JSON array');
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function validateTopics() {
  if (!startDateArg) fail('topics seeding requires --start-date YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateArg)) fail('--start-date must be YYYY-MM-DD');

  const seenIndexes = new Set();
  return rows.map((row, i) => {
    const where = `topics[${i}] (${row.title || 'untitled'})`;
    if (!Number.isInteger(row.order_index) || row.order_index < 1) {
      fail(`${where}: order_index must be a positive integer`);
    }
    if (seenIndexes.has(row.order_index)) fail(`${where}: duplicate order_index ${row.order_index}`);
    seenIndexes.add(row.order_index);
    if (!row.title) fail(`${where}: title is required`);
    if (!row.description) fail(`${where}: description is required`);
    if (!row.primary_keyword) fail(`${where}: primary_keyword is required`);
    if (!Array.isArray(row.guiding_questions) || row.guiding_questions.length < 3 || row.guiding_questions.length > 4) {
      fail(`${where}: guiding_questions must be an array of 3-4 strings`);
    }
    if (!CATEGORIES.includes(row.category)) {
      fail(`${where}: category must be one of ${CATEGORIES.join(', ')}`);
    }
    return {
      order_index: row.order_index,
      title: row.title,
      description: row.description,
      primary_keyword: row.primary_keyword,
      guiding_questions: row.guiding_questions,
      category: row.category,
      scheduled_date: addDays(startDateArg, (row.order_index - 1) * PUBLISH_INTERVAL_DAYS),
      status: 'upcoming',
    };
  });
}

const validated = validateTopics();
console.log(`validated ${validated.length} ${table} rows from ${inputFile}`);

if (dryRun) {
  for (const row of validated) {
    console.log(`  #${String(row.order_index).padStart(3, ' ')} ${row.scheduled_date} [${row.category}] ${row.title}`);
  }
  console.log('dry run: no database writes');
  process.exit(0);
}

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on the environment
}

const { getSupabaseClient } = await import('../lib/supabase.js');
const supabase = getSupabaseClient();
const { error } = await supabase.from('topics').upsert(validated, { onConflict: 'order_index' });
if (error) fail(`supabase upsert failed: ${error.message}`);
console.log(`upserted ${validated.length} rows into topics (conflict key: order_index)`);
