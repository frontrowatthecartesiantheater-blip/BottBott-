# Autoblog Pipeline — System Architecture

A reusable, voice-memo-driven blog content pipeline for any content-focused
client. The client records a short voice note on a scheduled topic; the system
transcribes it, generates a blog post plus social drafts in the client's voice,
publishes the post as static HTML, and logs the social drafts to a sheet. If no
memo is recorded by publish time, a RAG fallback generates from prior content.
An editor-review toggle gates publishing until you trust it to run autonomously.

## Stack

| Component | Tool |
|-----------|------|
| Hosting + deploy | Vercel |
| Repo | GitHub (post files committed via the Git Data API) |
| Database | Supabase (Postgres; pgvector for the optional RAG fallback) |
| Auth | Google OAuth 2.0, two-account whitelist (creator + editor) |
| Transcription | OpenAI Whisper |
| Generation | Claude (Sonnet) |
| Email | Resend |
| WhatsApp | Twilio |
| Social log | Google Sheet via Apps Script webhook |
| Scheduling | Vercel Cron |

## Data model

See `supabase/schema.sql`. Core tables: `topics` (the scheduled queue, with
description / primary keyword / guiding questions / category), `voice_memos`
(transcripts + extracted TOV signals), `posts` (drafts and published records,
including held social drafts and the craft audit), `keywords`, `images`
(reserved, unused in v1), `system_config` (the editor toggle and timing), and
`content_chunks` (optional RAG embeddings store).

## Flow

1. **Reminder cron** (daily): finds topics scheduled for tomorrow, emails +
   WhatsApps the creator, marks them `reminder_sent`.
2. **Record:** the creator opens `/admin`, records a memo; Whisper transcribes
   it; the transcript is saved and the topic flips to `recorded`.
3. **Publish cron** (daily at the client's publish time): for each topic due
   today, generates from the memo (or RAG fallback if none), then branches on
   the editor toggle —
   - **OFF:** auto-publish (single GitHub commit) and mark the topic published.
   - **ON:** save the draft to `pending_review` and email the editor.
4. **Review (toggle ON):** the editor edits and approves in `/admin`; publish
   runs the same commit flow.
5. **Publish flow:** renders the post page + blog index + manifest + sitemap and
   commits all of them in ONE atomic commit (see the README note on why), logs
   the social drafts to the sheet, and polls the live URL to confirm.

## What this system does NOT do

- Post to social platforms directly (the creator pastes from the sheet).
- Edit or delete already-published posts (manual git change if needed).
- Handle comments, engagement, or analytics.
- Manage images in v1 (the `images` table is reserved for later).
