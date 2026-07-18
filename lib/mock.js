// Shared mock switch for the pipeline (notifications, embeddings, RAG,
// cron). Mirrors the ADMIN_MOCK pattern from M5 so the same flag style
// works everywhere.
//
//   PIPELINE_MOCK=1   — env var (set by test harnesses / dev server)
//   --mock            — CLI flag (cross-platform on Windows)
//   ADMIN_MOCK=1      — honored too, so one flag drives the whole stack
//
// Read it as a function (not a cached const) because scripts set the env
// var at runtime before importing downstream modules.

export function isMock() {
  return (
    process.env.PIPELINE_MOCK === '1' ||
    process.env.ADMIN_MOCK === '1' ||
    process.argv.includes('--mock')
  );
}
