// Category-loose image selection for blog generation.
//
// Images are linked to topics by category, not per-topic. At generation time
// we pick a random UNUSED image whose category matches the topic's category;
// if none match, we fall back to any unused image so generation never blocks
// for lack of a category match. Once the post row exists, the chosen image is
// marked used (used = true, used_in_post_id = the new post id).
//
// Both functions take a Supabase client so they can be reused by the admin
// draft endpoint and the cron paths. Callers treat image handling as
// best-effort: a missing or failed image must never block a post.

/**
 * Pick a random unused image for a topic's category, falling back to any
 * unused image. Returns { id, filename, alt_text, category } or null when no
 * unused image exists at all.
 */
export async function selectUnusedImage(supabase, category) {
  // 1. Unused images in the topic's category.
  if (category) {
    const { data, error } = await supabase
      .from('images')
      .select('id, filename, alt_text, category')
      .eq('used', false)
      .eq('category', category);
    if (error) throw new Error(`images category query failed: ${error.message}`);
    if (data.length) return data[Math.floor(Math.random() * data.length)];
  }

  // 2. Fallback: any unused image, regardless of category.
  const { data, error } = await supabase
    .from('images')
    .select('id, filename, alt_text, category')
    .eq('used', false);
  if (error) throw new Error(`images fallback query failed: ${error.message}`);
  if (!data.length) return null;
  return data[Math.floor(Math.random() * data.length)];
}

/** Look up an image's alt_text by its filename. Returns '' if not found. */
export async function getImageAltByFilename(supabase, filename) {
  if (!filename) return '';
  const { data, error } = await supabase
    .from('images')
    .select('alt_text')
    .eq('filename', filename)
    .maybeSingle();
  if (error) throw new Error(`image alt lookup failed: ${error.message}`);
  return data?.alt_text ?? '';
}

/** Mark an image used and tie it to the post that consumed it. */
export async function markImageUsed(supabase, imageId, postId) {
  const { error } = await supabase
    .from('images')
    .update({ used: true, used_in_post_id: postId })
    .eq('id', imageId);
  if (error) throw new Error(`marking image used failed: ${error.message}`);
}
