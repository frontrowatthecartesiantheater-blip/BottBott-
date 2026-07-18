// Notifications: email via Resend, WhatsApp via Twilio.
//
// Both transports are mock-aware (isMock() logs instead of sending) and
// degrade gracefully when credentials are absent: rather than throwing an
// unhandled error, send* returns { ok:false, skipped:true, reason } so the
// cron can record it in its summary and move on. Genuine API failures
// (bad request, network) return { ok: false, error } — also non-throwing.

import { isMock } from './mock.js';
import { CLIENT, ADMIN_URL, FROM_EMAIL } from './client-config.js';

// --- transports --------------------------------------------------------

export async function sendEmail({ to, subject, text }) {
  if (isMock()) {
    console.log(`[mock email] to=${to} subject="${subject}"`);
    return { ok: true, mock: true };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, skipped: true, reason: 'RESEND_API_KEY not set' };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, text }),
    });
    if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true, id: (await res.json()).id };
  } catch (err) {
    return { ok: false, error: `Resend request failed: ${err.message}` };
  }
}

export async function sendWhatsApp({ to, body }) {
  if (isMock()) {
    console.log(`[mock whatsapp] to=${to} body="${body.slice(0, 60)}..."`);
    return { ok: true, mock: true };
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM; // e.g. "whatsapp:+14155238886"
  if (!sid || !token || !from) {
    return { ok: false, skipped: true, reason: 'Twilio credentials (SID/TOKEN/FROM) not all set' };
  }
  if (!to) return { ok: false, skipped: true, reason: 'CLIENT_WHATSAPP_NUMBER not set' };

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: from, To: `whatsapp:${to.replace(/^whatsapp:/, '')}`, Body: body }),
    });
    if (!res.ok) return { ok: false, error: `Twilio ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true, sid: (await res.json()).sid };
  } catch (err) {
    return { ok: false, error: `Twilio request failed: ${err.message}` };
  }
}

// --- message copy --------------------------------------------------------
// Edit the wording to suit the client's voice; the structure is what the
// cron relies on. These read live from CLIENT (no build-time tokens).

const CREATOR_EMAIL = CLIENT.creatorGoogleAccount;
const EDITOR_EMAIL = CLIENT.editorGoogleAccount;

// Three-step reminder ladder: 3 days out (first ask), 2 days out (nudge),
// 1 day out (last call). daysOut picks the variant.
const REMINDER_VARIANTS = {
  3: (topic) => ({
    subject: `Next blog post — ${topic.title} — 3 days out`,
    lines: [
      `Hey ${CLIENT.firstName},`,
      '',
      `Heads up — your next blog post goes out in 3 days: ${topic.title}`,
      '',
      'A 2-3 min voice note whenever you get a chance this week is all it takes — whatever comes to mind.',
      '',
      `Record here: ${ADMIN_URL}`,
      '',
      'Talk soon,',
      CLIENT.editorName,
    ],
  }),
  2: (topic) => ({
    subject: `Still need your voice note — ${topic.title}`,
    lines: [
      `Hey ${CLIENT.firstName},`,
      '',
      `Haven't seen this one recorded yet — 2 days left: ${topic.title}`,
      '',
      'Still just a quick 2-3 minute voice note, whenever suits.',
      '',
      `Record here: ${ADMIN_URL}`,
      '',
      'Talk soon,',
      CLIENT.editorName,
    ],
  }),
  1: (topic) => ({
    subject: `Last call — ${topic.title} goes out tomorrow`,
    lines: [
      `Hey ${CLIENT.firstName},`,
      '',
      `${topic.title} publishes tomorrow. If I don't hear from you today, the post publishes from the fallback content — still happy to have it either way.`,
      '',
      `Record here: ${ADMIN_URL}`,
      '',
      'Talk soon,',
      CLIENT.editorName,
    ],
  }),
};

export function reminderEmail(topic, daysOut) {
  const variant = REMINDER_VARIANTS[daysOut];
  if (!variant) throw new Error(`no reminder email variant for daysOut=${daysOut}`);
  const { subject, lines } = variant(topic);
  return { to: CREATOR_EMAIL, subject, text: lines.join('\n') };
}

// WhatsApp reminders are shelved (see twilio-whatsapp-shelved) — the cron no
// longer calls this, but the transport and copy stay for if/when it returns.
export function reminderWhatsApp(topic, recipientNumber) {
  return {
    to: recipientNumber,
    body: `Hey ${CLIENT.firstName} — blog post goes out tomorrow. Topic: ${topic.title}. Takes 2 mins: ${ADMIN_URL}`,
  };
}

// Sent to the editor when a draft lands in pending_review (toggle ON).
export function reviewEmail(topic) {
  return {
    to: EDITOR_EMAIL,
    subject: `Post ready for review — ${topic.title}`,
    text: [
      'Draft is ready. Review and publish here:',
      '',
      ADMIN_URL,
      '',
      'It will not go live until you approve it (editor review is ON).',
    ].join('\n'),
  };
}

export { CREATOR_EMAIL, EDITOR_EMAIL };
