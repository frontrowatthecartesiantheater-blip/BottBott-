// Receive the creator's voice memo, transcribe with Whisper, save to Supabase.
//
// Payload: JSON { topic_id, audio_base64, mime } — base64 keeps body
// handling identical across Vercel and the dev server, and a 2-3 minute
// opus memo is well under 1MB encoded. Hard cap at 4MB to stay inside
// Vercel's request limit (roughly a 10+ minute recording).

import { requireRole } from '../../lib/admin-auth.js';
import { sendJson, readJsonBody } from '../../lib/http.js';
import { saveVoiceMemo } from '../../lib/admin-data.js';

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

async function transcribe(audioBuffer, mime) {
  if (process.env.ADMIN_MOCK === '1') {
    return '(mock transcript) I have been doing this for almost 40 years. This topic matters because people check you out online before they ever call you.';
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const form = new FormData();
  const ext = (mime || 'audio/webm').split('/')[1].split(';')[0];
  form.append('file', new Blob([audioBuffer], { type: mime }), `memo.${ext}`);
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
    const { topic_id: topicId, audio_base64: audioBase64, mime } = await readJsonBody(req);
    if (!topicId || !audioBase64) {
      return sendJson(res, 400, { error: 'topic_id and audio_base64 are required' });
    }
    const audio = Buffer.from(audioBase64, 'base64');
    if (audio.length === 0) return sendJson(res, 400, { error: 'audio is empty' });
    if (audio.length > MAX_AUDIO_BYTES) {
      return sendJson(res, 413, { error: 'recording too large; keep it under about 8 minutes' });
    }

    const transcript = await transcribe(audio, mime);
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
