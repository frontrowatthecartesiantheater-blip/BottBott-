# Vercel Build Command Trap — Static Publish Pipelines

## The Symptom
A blog post (or any content) publishes successfully — commit goes through, individual page loads fine, `index.json`/manifest shows the entry correctly — but the *listing page* never updates. Hard refresh, incognito, even CDN cache purges don't fix it.

## Why It's Confusing
Every obvious diagnostic points the wrong way:
- The individual post page works → looks like a rendering or routing bug, not deployment
- The committed HTML on GitHub is correct → looks like a caching issue
- CDN purge doesn't fix it → looks like a deeper cache layer or domain misconfiguration
- Response headers show `age=0` (fresh from origin) but still stale content → this is the tell, but easy to misread as "purge didn't fully propagate"

## The Real Cause
Vercel's **Build & Development Settings** had a leftover/default Build Command (e.g. `npm run build:blog`) that regenerates the listing page, manifest, and sitemap **at deploy time** from a local source directory (e.g. `content/posts/*.md`).

If the publish pipeline commits fully-rendered HTML directly (via GitHub API) rather than adding a matching markdown source file, the deploy-time build script doesn't know the new post exists — and silently overwrites the correctly-committed `index.html`/`index.json`/`sitemap.xml` with a stale regeneration based on whatever local sources it *does* know about.

The individual post page survives because the build script only writes pages for sources it knows about — it never deletes files it didn't generate.

## How to Confirm
1. Check the deployment's **Build Logs** in Vercel for a line showing the build script ran and how many posts it processed (e.g. `built blog/index.json ... (1 posts)` when there should be 2+)
2. Compare that count against what's actually committed to the repo

## The Fix
Vercel → Project Settings → Build and Deployment → Framework Settings:
- Turn **off** the Build Command override (or clear it)
- Turn **off** the Output Directory override
- Save, then redeploy with **build cache disabled**

This makes the deploy a true zero-build static serve — Vercel serves exactly what's committed, nothing regenerates it.

## Prevention Checklist for New Client Builds
- [ ] If the publish pipeline commits fully-rendered static output (not source files a build step would consume), confirm **no build command is set** in Vercel dashboard settings — check this even if `vercel.json` looks clean, since dashboard-level settings aren't visible in the repo
- [ ] If a local build script exists for dev/preview purposes, make sure it's understood as **local-only tooling**, not something that should run in the deploy pipeline
- [ ] Add a consistency check to the publish flow (e.g. assert every slug in the manifest has a matching card in the rendered listing HTML) before committing, to catch mismatches at publish time rather than discovering them live
