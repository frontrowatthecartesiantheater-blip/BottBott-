// Data access for the cron jobs. Mock-aware like lib/admin-data.js.
// The mock fixtures are arranged to exercise every cron branch:
//   - topic scheduled TODAY with a voice memo  -> publish path A (transcript)
//   - topic scheduled TODAY with no voice memo -> publish path B (RAG fallback)
//   - topics at today+3 (upcoming), today+2 (reminder_sent_3d) and
//     today+1 (reminder_sent_2d) -> one per reminder-ladder stage
// MOCK_TODAY drives "today" so the harness controls which branch fires.

import { isMock } from './mock.js';

function getSupabase() {
  // Imported lazily so mock runs never require Supabase credentials.
  return import('./supabase.js').then((m) => m.getSupabaseClient());
}

// ---- mock fixtures ----------------------------------------------------

export function mockToday() {
  return process.env.MOCK_TODAY || '2026-06-19';
}

function mockTopics() {
  const today = mockToday();
  return [
    {
      id: 'cron-topic-a', order_index: 1,
      title: 'Example Topic A',
      description: 'An example topic that has a recorded voice memo.',
      primary_keyword: 'example keyword a',
      guiding_questions: ['What is the first thing to know about this topic?'],
      category: 'example-category-a', scheduled_date: today, status: 'recorded',
    },
    {
      id: 'cron-topic-b', order_index: 2,
      title: 'Example Topic B',
      description: 'An example topic with no memo, so it uses the RAG fallback.',
      primary_keyword: 'example keyword b',
      guiding_questions: ['What do people usually get wrong here?'],
      category: 'example-category-b', scheduled_date: today, status: 'reminder_sent_1d',
    },
    {
      id: 'cron-topic-c', order_index: 3,
      title: 'Example Topic C',
      description: 'An example topic three days out, for the first reminder stage.',
      primary_keyword: 'example keyword c',
      guiding_questions: ['What surprises people most about this?'],
      category: 'example-category-a', scheduled_date: addDays(today, 3), status: 'upcoming',
    },
    {
      id: 'cron-topic-d', order_index: 4,
      title: 'Example Topic D',
      description: 'An example topic two days out, for the second reminder stage.',
      primary_keyword: 'example keyword d',
      guiding_questions: ['What is the first decision people face here?'],
      category: 'example-category-b', scheduled_date: addDays(today, 2), status: 'reminder_sent_3d',
    },
    {
      id: 'cron-topic-e', order_index: 5,
      title: 'Example Topic E',
      description: 'An example topic one day out, for the last reminder stage.',
      primary_keyword: 'example keyword e',
      guiding_questions: ['Which details pay off the most?'],
      category: 'example-category-a', scheduled_date: addDays(today, 1), status: 'reminder_sent_2d',
    },
  ];
}

const mockMemos = {
  'cron-topic-a': {
    id: 'cron-memo-a', topic_id: 'cron-topic-a',
    transcript: "This is an example transcript standing in for a real voice memo. I have been doing this work for years, and here is a specific thing I have learned from experience.",
    tov_signals: null,
  },
};

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---- queries ----------------------------------------------------------

export async function getTopicsScheduledFor(date) {
  if (isMock()) return mockTopics().filter((t) => t.scheduled_date === date && t.status !== 'published' && t.status !== 'auto_generated');
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('topics').select('*')
    .eq('scheduled_date', date).not('status', 'in', '(published,auto_generated)');
  if (error) throw new Error(`topics read failed: ${error.message}`);
  return data;
}

// Topics due `date` still sitting at one of `statuses` — each reminder-ladder
// stage passes its pre-stage statuses, so recorded topics never match.
export async function getReminderTopicsFor(date, statuses) {
  if (isMock()) return mockTopics().filter((t) => t.scheduled_date === date && statuses.includes(t.status));
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('topics').select('*')
    .eq('scheduled_date', date).in('status', statuses);
  if (error) throw new Error(`topics read failed: ${error.message}`);
  return data;
}

export async function getLatestVoiceMemo(topicId) {
  if (isMock()) return mockMemos[topicId] || null;
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('voice_memos').select('*')
    .eq('topic_id', topicId).order('recorded_at', { ascending: false }).limit(1);
  if (error) throw new Error(`voice_memos read failed: ${error.message}`);
  return data[0] || null;
}

export async function setTopicStatus(topicId, status) {
  if (isMock()) return;
  const supabase = await getSupabase();
  const { error } = await supabase.from('topics').update({ status }).eq('id', topicId);
  if (error) throw new Error(`topic status update failed: ${error.message}`);
}

export async function saveDraftPost(record) {
  if (isMock()) return { id: `mock-draft-${record.slug}` };
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('posts').insert(record).select('id').single();
  if (error) throw new Error(`draft save failed: ${error.message}`);
  return data;
}

// ---- images (mock-aware wrappers around lib/images.js) ----------------
// The images table is not populated in mock runs, so both return null/no-op.

export async function selectImageForTopic(category) {
  if (isMock()) return null;
  const supabase = await getSupabase();
  const { selectUnusedImage } = await import('./images.js');
  return selectUnusedImage(supabase, category);
}

export async function markImageUsed(imageId, postId) {
  if (isMock() || !imageId) return;
  const supabase = await getSupabase();
  const { markImageUsed: mark } = await import('./images.js');
  return mark(supabase, imageId, postId);
}
