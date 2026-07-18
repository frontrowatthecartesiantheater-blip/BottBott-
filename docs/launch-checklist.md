# Launch Checklist

The runbook for taking the autoblog pipeline live for a client. Work top to
bottom. `npm run preflight` machine-checks every gate it can; this document
covers those plus the live-credential and DNS steps it cannot.

**Completion bar:** a real post has gone through the full pipeline end to end —
recorded or RAG-generated, **editor toggle ON**, approved in `/admin`,
committed, and confirmed live at its URL.

---

## A. Configure (`npm run preflight` to verify)

Run `npm run preflight`; it must exit 0 before cutover.

- [ ] **Fill `lib/client-config.js`.** Replace every `{{PLACEHOLDER}}`. This is
  the single source of client-specific values; the HTML templates and prompts
  read from it. Preflight hard-fails while any `{{...}}` remains.
- [ ] **Write the voice profile.** Fill `docs/tov-profile-template.md` per its
  instructions (record 4–5 client calls, extract the patterns).
- [ ] **Topic categories** match across four places: `CLIENT.topicCategories`
  in client-config, the two `category` CHECK constraints in
  `supabase/schema.sql` (topics + images), and the category `<option>`s in
  `admin/index.html` (the seed scripts and admin APIs read from client-config).
- [ ] **`.env` gitignored** (already true in the template).
- [ ] **Cron offset** in `vercel.json` matches the client's timezone and
  intended publish time; re-check at each DST transition.
- [ ] **`robots.txt`** sitemap line points at the client domain.
- [ ] **Notification recipients** (creator + editor accounts) are live, monitored.
- [ ] **Editor toggle** seeds ON in `schema.sql`; confirm the live value is ON.

---

## B. Provision services and environment

Set every variable from `.env.example` in Vercel (and locally in `.env` for the
dry run). Sources:

- [ ] **Supabase:** create the project; run `supabase/schema.sql`. Confirm
  `pgvector` is enabled if using RAG, and `match_content_chunks` exists. Set
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- [ ] **Anthropic:** `ANTHROPIC_API_KEY` (generation).
- [ ] **OpenAI:** `OPENAI_API_KEY` (Whisper transcription + RAG embeddings).
- [ ] **GitHub:** `GITHUB_TOKEN` (contents read/write on the client's site repo),
  `GITHUB_REPO` (`owner/name`), `GITHUB_BRANCH`. The repo must have a remote and
  an initial push first.
- [ ] **Google OAuth:** `GOOGLE_CLIENT_ID/SECRET`; authorized redirect URI
  `<origin>/api/auth/google`. `SESSION_SECRET` = long random string.
- [ ] **Resend:** `RESEND_API_KEY`; verify the sender domain.
- [ ] **Twilio:** `TWILIO_ACCOUNT_SID/AUTH_TOKEN/WHATSAPP_FROM` and
  `CLIENT_WHATSAPP_NUMBER` (the creator's number).
- [ ] **Google Sheets API (social log):** create a GCP service account, generate
  a JSON key, and enable the Sheets API on that project. Share the client's
  social-log spreadsheet with the service account's email as **Editor**. Put
  the spreadsheet ID in `GOOGLE_SHEETS_SPREADSHEET_ID` and the base64-encoded
  JSON key in `GOOGLE_SERVICE_ACCOUNT_KEY`. Set up a "Social Posts" tab with a
  header row and F/G checkbox columns (posted-to-LinkedIn / posted-to-Facebook).
- [ ] **SerpApi:** `SERPAPI_API_KEY` (link-injection candidate sourcing) — a
  NEW key scoped to this client, never reused from another project.
- [ ] **GitHub Actions secrets (link sweep):** add every secret listed in
  `.github/workflows/link-sweep.yml` to the repo's Actions secrets
  (`SERPAPI_API_KEY`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `GITHUB_REPO`, `GITHUB_BRANCH`,
  `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_KEY`,
  `VERIFY_BASE_URL`). Confirm the scheduled workflow runs green.
- [ ] **Link-client onboarding:** with the site reachable, run
  `npm run links:onboard` once and confirm `link_client_business_type` /
  `link_client_market` landed in `system_config`.
- [ ] **Cron:** `CRON_SECRET` (Vercel sends it as a Bearer token to the cron
  endpoints).
- [ ] **Verification:** leave `VERIFY_BASE_URL` empty until DNS cutover, then set
  it to the client's `https://` origin.

---

## C. Live pipeline dry run (the real test)

Against production services with **editor toggle ON**, before DNS cutover.

- [ ] **Live generation.** Seed a test topic, run
  `node scripts/test-generation.js --topic <file> --transcript <file>` (no
  `--mock`). Read the output against the voice profile; iterate the prompts in
  `lib/generation/` if the model drifts. This is an iteration loop.
- [ ] **Live Whisper.** Open `/admin` as the creator, record a memo, submit;
  confirm the transcript saved and the topic flipped to `recorded`.
- [ ] **RAG path (if used).** Run `node scripts/index-embeddings.js`; trigger a
  cron publish for a topic with no memo and confirm relevant chunks are
  retrieved (mock embeddings are not semantic — only the live run proves this).
- [ ] **Link sweep.** Trigger the link-sweep workflow manually
  (workflow_dispatch) against a pending_review draft; confirm links appear in
  the admin Review panel and the Publish button unlocks
  (`posts.links_checked_at` stamped).
- [ ] **Commit + verification.** With toggle ON, approve the draft → Publish.
  Confirm a single GitHub commit, one Vercel deploy, the Sheet row, and
  `VERIFY_BASE_URL` polling reporting the post live.

---

## D. Pre-cutover

- [ ] Editor toggle ON in live `system_config`.
- [ ] Client sign-off on the site.
- [ ] Internal link pools in `client-config.js` point only at pages that exist.

---

## E. DNS cutover

- [ ] Add the client domain (and `www`) in the Vercel project.
- [ ] Point the DNS records at Vercel's targets. If fronted by a proxy/CDN
  (e.g. Cloudflare), set SSL mode to Full and disable proxying on these records
  during cutover to avoid double-TLS issues.
- [ ] Confirm HTTPS resolves to the Vercel deployment.
- [ ] Set `VERIFY_BASE_URL` to the live origin and re-run a publish verification.

---

## F. Post-launch

- [ ] Submit `sitemap.xml` in Google Search Console.
- [ ] Confirm both Vercel cron jobs are registered and fire (check logs after the
  first scheduled run).
- [ ] **DST:** at each daylight-saving transition, shift the `vercel.json` cron
  hours by one so publishing stays at the intended local time.
