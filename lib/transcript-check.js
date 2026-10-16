// Recording sanity check on Whisper's verbose output.
//
// Why: a corrupted recording (Oct 2026: about 90 seconds missing from the first
// five minutes) produced a short transcript that ended in "Yeah. Yeah. Yeah.
// Yeah." and nothing warned anyone. The draft then completed the speaker's cut
// off thought for him. Whisper's verbose_json gives per-segment timestamps and
// confidence, which is enough to spot the usual signs:
//
//   gap          a stretch with no speech at all (audio dropped out)
//   loop         the same filler repeated (Whisper hallucinating over a dead stretch)
//   unreliable   segments Whisper itself marks as likely noise or hallucination
//   thin         far fewer words than the audio length should produce
//   ends_mid     the transcript stops mid-sentence
//
// Findings are advisory: they are shown to the person who just recorded, stored
// on the memo, and passed to the drafting prompts so a missing stretch is
// treated as unknown rather than filled in.

const GAP_SECONDS = 20;        // silence this long inside a memo is almost never intentional
const MIN_WPM = 85;            // normal speech is roughly 120-160 wpm; this allows slow and pause-heavy
const MIN_SECONDS_FOR_PACE = 90;
const LOOP_RUN = 3;            // this many identical short segments in a row
const FILLER = /^(yeah|yes|okay|ok|right|so|um|uh|mm|mhm|hmm|you know|thank you|thanks)$/;

const normalize = (t) => String(t ?? '').toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();

export function formatTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * @param {{ text: string, duration?: number|null, segments?: Array<{start:number,end:number,text:string,
 *   avg_logprob?:number, compression_ratio?:number, no_speech_prob?:number}> }} verbose
 * @returns {{ ok: boolean, warnings: Array<{type: string, at: number|null, detail: string}>,
 *   stats: {duration: number|null, words: number, wpm: number|null}, checkedAt: string }}
 */
export function analyzeTranscript({ text, duration = null, segments = [] }) {
  const warnings = [];
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
  const segs = [...segments].filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end)).sort((a, b) => a.start - b.start);
  const total = Number.isFinite(duration) ? duration : (segs.length ? segs[segs.length - 1].end : null);

  // Gaps: leading, between segments.
  if (segs.length) {
    if (segs[0].start >= GAP_SECONDS) {
      warnings.push({ type: 'gap', at: 0, detail: `no speech for the first ${Math.round(segs[0].start)} seconds` });
    }
    for (let i = 1; i < segs.length; i += 1) {
      const gap = segs[i].start - segs[i - 1].end;
      if (gap >= GAP_SECONDS) {
        warnings.push({
          type: 'gap', at: segs[i - 1].end,
          detail: `no speech from ${formatTime(segs[i - 1].end)} to ${formatTime(segs[i].start)} (${Math.round(gap)} seconds); the audio may have dropped out`,
        });
      }
    }

    // Loops: the same short filler segment repeated.
    let run = 1;
    for (let i = 1; i <= segs.length; i += 1) {
      const same = i < segs.length && normalize(segs[i].text) === normalize(segs[i - 1].text);
      if (same) { run += 1; continue; }
      const sample = normalize(segs[i - 1].text);
      const short = sample.split(' ').filter(Boolean).length <= 4;
      if (run >= LOOP_RUN && short && (FILLER.test(sample) || run >= 4)) {
        const first = segs[i - run];
        warnings.push({
          type: 'loop', at: first.start,
          detail: `"${segs[i - 1].text.trim()}" repeated ${run} times starting at ${formatTime(first.start)}; the recording may have cut out there`,
        });
      }
      run = 1;
    }

    // Segments Whisper itself distrusts. Thresholds calibrated against real
    // output: ordinary speech has no_speech_prob under 0.1 and avg_logprob above
    // -0.6, while a lone hallucinated word over a dead stretch came back at
    // 0.50 / -0.93.
    const unreliable = segs.filter((s) => s.compression_ratio > 2.4 || (s.no_speech_prob > 0.45 && s.avg_logprob < -0.8));
    if (unreliable.length) {
      warnings.push({
        type: 'unreliable', at: unreliable[0].start,
        detail: `${unreliable.length} stretch${unreliable.length === 1 ? '' : 'es'} the transcriber marked as likely noise or guesswork (first at ${formatTime(unreliable[0].start)})`,
      });
    }
  }

  // Pace: too few words for the audio length.
  let wpm = null;
  if (total && total > 0) {
    wpm = Math.round(words / (total / 60));
    if (total >= MIN_SECONDS_FOR_PACE && wpm < MIN_WPM) {
      warnings.push({
        type: 'thin', at: null,
        detail: `only ${words} words for ${formatTime(total)} of audio (${wpm} words a minute; normal speech is 120-160). Parts of the recording may be missing`,
      });
    }
  }

  // Cut off mid-sentence.
  const tail = String(text ?? '').trim();
  if (tail.length >= 200 && !/[.!?"')\]]$/.test(tail)) {
    warnings.push({ type: 'ends_mid', at: null, detail: 'the transcript stops mid-sentence' });
  }

  return {
    ok: warnings.length === 0,
    warnings,
    stats: { duration: total, words, wpm },
    checkedAt: new Date().toISOString(),
  };
}

/** One plain sentence per warning, for the admin message. */
export function describeWarnings(check) {
  return (check?.warnings ?? []).map((w) => w.detail);
}
