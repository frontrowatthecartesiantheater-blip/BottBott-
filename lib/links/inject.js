// Step 8: injection. Deterministic string splice — the model never rewrites
// the draft. Finds the claim sentence in the markdown and wraps the chosen
// anchor phrase in a link, skipping anything already inside a link or a
// heading.

/**
 * @param {string} bodyMd
 * @param {{sentence: string, anchorText: string, url: string}} link
 * @returns {{ bodyMd: string, ok: boolean, reason: string|null }}
 */
export function injectLink(bodyMd, { sentence, anchorText, url }) {
  const fail = (reason) => ({ bodyMd, ok: false, reason });

  const sentenceStart = bodyMd.indexOf(sentence);
  if (sentenceStart === -1) return fail('sentence not found in draft');

  // Don't inject into headings.
  const lineStart = bodyMd.lastIndexOf('\n', sentenceStart) + 1;
  if (bodyMd.slice(lineStart, lineStart + 6).trimStart().startsWith('#')) {
    return fail('sentence is a heading');
  }

  const anchorInSentence = sentence.indexOf(anchorText);
  if (anchorInSentence === -1) return fail('anchor text not in sentence');

  // Don't double-link: reject if the anchor already sits inside [..](..) or
  // the sentence already carries a markdown link.
  if (/\[[^\]]*\]\([^)]*\)/.test(sentence)) return fail('sentence already contains a link');

  const absolute = sentenceStart + anchorInSentence;
  const updated =
    bodyMd.slice(0, absolute) +
    `[${anchorText}](${url})` +
    bodyMd.slice(absolute + anchorText.length);

  return { bodyMd: updated, ok: true, reason: null };
}
