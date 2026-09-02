// Receive the creator's voice memo — recorded in the browser or uploaded as a
// file — transcribe with Whisper, save to Supabase.
//
// Payload: JSON { topic_id, audio_base64, mime, filename } — base64 keeps body
// handling identical across Vercel and the dev server. `filename` is optional
// and only decides the extension Whisper is shown.

import { requireRole } from '../../lib/admin-auth.js';
import { sendJson, readJsonBody } from '../../lib/http.js';
import { saveVoiceMemo } from '../../lib/admin-data.js';

// Vercel's edge answers a request body over 4.5 MB (decimal) with
// FUNCTION_PAYLOAD_TOO_LARGE before this function is invoked, so the cap here
// has to sit below that once base64's 4/3 inflation and the JSON wrapper are
// accounted for. A 4MB cap was unreachable: the edge always rejected first, and
// the caller saw a bare 413 instead of the message below. Keep this in step
// with MAX_AUDIO_BYTES in admin/admin.js.
const MAX_AUDIO_BYTES = Math.floor((4500000 - 2048) * 3 / 4);

// Containers Whisper accepts. The upload path can hand us whatever a phone
// recorded, and a filename Whisper does not recognise fails the whole request,
// so prefer the real extension and fall back to the MIME type.
const AUDIO_EXTS = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm'];
const MIME_EXT = {
  'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/ogg': 'ogg', 'audio/oga': 'oga',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
  'audio/webm': 'webm',
};

function audioExt(filename, mime) {
  const fromName = String(filename || '').split('.').pop().toLowerCase();
  if (AUDIO_EXTS.includes(fromName)) return fromName;
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  return MIME_EXT[base] || 'webm';
}

async function transcribe(audioBuffer, mime, filename) {
  if (process.env.ADMIN_MOCK === '1') {
    return '(mock transcript) I have been doing this for almost 40 years. This topic matters because people check you out online before they ever call you.';
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const form = new FormData();
  const ext = audioExt(filename, mime);
  form.append('file', new Blob([audioBuffer], { type: mime || 'audio/webm' }), `memo.${ext}`);
  form.append('model', 'whisper-1');
  form.append('language', 'en');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.text;
}

export default async function handler(req, res) {
  const session = requireRole(req, res, ['creator', 'editor']);
  if (!session) return;
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

  try {
    const { topic_id: topicId, audio_base64: audioBase64, mime, filename } = await readJsonBody(req);
    if (!topicId || !audioBase64) {
      return sendJson(res, 400, { error: 'topic_id and audio_base64 are required' });
    }
    const audio = Buffer.from(audioBase64, 'base64');
    if (audio.length === 0) return sendJson(res, 400, { error: 'audio is empty' });
    if (audio.length > MAX_AUDIO_BYTES) {
      return sendJson(res, 413, {
        error: `audio is ${(audio.length / 1000000).toFixed(2)} MB; the limit is `
          + `${(MAX_AUDIO_BYTES / 1000000).toFixed(2)} MB, about 14 minutes at the recorder's 32 kbps`,
      });
    }

    const transcript = await transcribe(audio, mime, filename);
    if (!transcript || transcript.trim().length < 20) {
      return sendJson(res, 422, { error: 'transcription came back empty; try recording again' });
    }

    const memo = await saveVoiceMemo({ topicId, transcript });
    return sendJson(res, 200, {
      ok: true,
      voice_memo_id: memo.id,
      transcript_preview: transcript.slice(0, 200),
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}
