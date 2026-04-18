# Agent Passoff (Codex -> Claude)

This file is the project handoff/init context for any new coding agent.

## 1) Project Summary

- Project: `plexlisthelper` (React + Vite SPA).
- Primary goal: Load a **public Plex share list** (`watch.plex.tv/u/.../lists/...`), browse/filter items, and pick random titles.
- Hosting target: `https://apps.geddesworks.com/plexlists/` (GitHub Pages subpath).
- Backend dependency: Appwrite Function `plexlists_scraper` (required for Plex scraping + optional TMDB enrichment).

## 2) Current Live Architecture

- Frontend:
  - React 19 SPA in `src/`
  - Deployed by GitHub Actions workflow `.github/workflows/deploy-pages.yml`
  - Build uses `BASE_PATH=/plexlists/` via `npm run build:pages`
- Backend:
  - Appwrite function source at `appwrite-functions/plexlists-scraper/index.js`
  - Function ID: `plexlists_scraper`
  - Appwrite project: `69876eae003275d80ff8`
  - Endpoint default in frontend: `https://sfo.cloud.appwrite.io/v1`

## 3) Important Functional Behavior (As Of Passoff)

### 3.1 Initial list loading strategy

- Frontend calls Appwrite with `tmdbMode: "none"` for fast initial load.
- Function scrapes public Plex share page + attempts server-side pagination via Plex luma endpoints.
- Frontend then calls function `path=/tmdb-enrich` in batches for background TMDB enrichment.

### 3.2 TMDB enrichment

- Function supports TMDB enrichment with:
  - `TMDB_API_READ_ACCESS_TOKEN` (preferred)
  - `TMDB_API_KEY` (fallback)
- TMDB lookup cap currently: `40` per enrichment request.
- Frontend batches TMDB enrichment in chunks of `20`, prioritizing currently visible items first.

### 3.3 Local persistence (Phase 2 start)

- Stored in browser localStorage via `src/lib/storage.ts`:
  - Saved links list (recent share URLs + derived names)
  - Cached list snapshots (items + warnings + timestamp) keyed by URL
- Cache policy in frontend (`src/App.tsx`):
  - If cache is fresh (8h window), it uses cache and skips remote refresh.
  - If cache is stale, it renders cache immediately and refreshes in background.
  - Clicking **Load list** forces refresh (bypasses cache freshness short-circuit).

## 4) Current Key Files

- Frontend app: `src/App.tsx`
- Frontend styles: `src/App.css`
- Appwrite client + data requests: `src/lib/plex.ts`
- Local storage (settings, saved links, cache): `src/lib/storage.ts`
- Scraper/enrichment function: `appwrite-functions/plexlists-scraper/index.js`
- Docs: `README.md`

## 5) Known IDs / Deployment State

- Latest pushed commits on `main` at handoff time:
  - `a38c71e` - Add cached list snapshots to avoid repeated scrapes
  - `0973049` - Add lazy TMDB enrichment and saved share-link history
- Recent Appwrite function deployment used for these features:
  - Deployment ID: `69ddb342177ba2ceafbb`
  - Status was `ready` when tested.

## 6) Verified Flows

- Build/lint pass locally:
  - `npm run build`
  - `npm run lint`
- Appwrite function execution checks were successful for:
  - `/` with `tmdbMode: "none"`
  - `/tmdb-enrich` batch endpoint

## 7) Operational Notes / Gotchas

- GitHub Pages serves only static frontend; Appwrite is still required for data.
- If frontend origin/domain changes, add it as a Web platform in Appwrite to avoid CORS issues.
- Do **not** store secrets in repo. Keep TMDB/Appwrite secrets in Appwrite vars or local env only.
- There are two small Codex test files in repo root:
  - `.codex-appwrite-test.txt`
  - `.codex-appwrite-exec-test.txt`
  They are not durable memory/session logs, just ad-hoc test artifacts.

## 8) Suggested Next Steps

- Add UI controls for cache management (clear cache, per-list refresh timestamps).
- Persist enrichment deltas more aggressively during background TMDB batches (optional quality improvement).
- Add lightweight telemetry/debug info in UI for cache hit/miss and refresh path.
- Add regression tests around storage migration/parsing (invalid localStorage payloads).

