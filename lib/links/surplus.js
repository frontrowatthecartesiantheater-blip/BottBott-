// Surplus pool: candidates that passed every gate on a prior run but were
// cut by the per-post link cap. They're vetted work — offered to future
// posts in the same topic category before those posts pay for a fresh web
// search. Single-use: consumed_at is stamped on reuse (or when found dead),
// and consumed rows are never offered again. A row that merely fails the
// fresh relevancy check for one claim stays unconsumed.

/**
 * Unconsumed surplus rows for a topic category (one of CLIENT.topicCategories).
 * Two-step (topic ids for the category, then rows) rather than an embedded
 * join — category topic lists are small.
 */
export async function findSurplusCandidates(supabase, category) {
  const { data: topicRows, error: topicError } = await supabase
    .from('topics')
    .select('id')
    .eq('category', category);
  if (topicError) throw new Error(`surplus topic lookup failed for "${category}": ${topicError.message}`);
  const topicIds = (topicRows ?? []).map((r) => r.id);
  if (topicIds.length === 0) return [];

  const { data, error } = await supabase
    .from('injected_links')
    .select('*')
    .eq('status', 'surplus')
    .is('consumed_at', null)
    .in('topic_id', topicIds);
  if (error) throw new Error(`surplus lookup failed for "${category}": ${error.message}`);
  return data ?? [];
}

export async function markSurplusConsumed(supabase, id, { consumedByPostId = null, reason = null } = {}) {
  const { error } = await supabase
    .from('injected_links')
    .update({
      consumed_at: new Date().toISOString(),
      consumed_by_post_id: consumedByPostId,
      consumed_reason: reason,
    })
    .eq('id', id);
  if (error) throw new Error(`surplus consume failed for row ${id}: ${error.message}`);
}
