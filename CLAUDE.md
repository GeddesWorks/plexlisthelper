# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See also `AGENT_PASSOFF.md` for prior-agent handoff notes (live deployment IDs, verified flows, gotchas).

## Commands

- `npm run dev` — Vite dev server
- `npm run build` — typecheck (`tsc -b`) then `vite build` into `dist/`
- `npm run build:pages` — production build packaged for GitHub Pages subpath deployment; requires `BASE_PATH` and `DEPLOY_SUBDIR` env vars (see `.github/workflows/deploy-pages.yml`: `BASE_PATH=/plexlists/`, `DEPLOY_SUBDIR=plexlists`, `APP_NAME="Plex List Picker"`)
- `npm run lint` — ESLint across the repo
- `npm run preview` — serve the built `dist/`

There is no test runner configured.

## Architecture

Two-part system: a static React SPA frontend and an Appwrite Function backend. The frontend cannot scrape `watch.plex.tv` directly from the browser (no CORS), so all list fetches go through the Appwrite function.

### Frontend (`src/`)

- `src/App.tsx` — the whole UI lives here. Manages settings, filters, sort, random-pick, saved-link history, and the cached-list/background-enrichment flow.
- `src/lib/plex.ts` — Appwrite client construction (reads `VITE_APPWRITE_ENDPOINT`/`VITE_APPWRITE_PROJECT_ID`/`VITE_APPWRITE_FUNCTION_ID` with hardcoded defaults), three execution entry points (`fetchSharedList`, `fetchSharedListFast`, `fetchTmdbEnrichment`), plus pure helpers (`filterItems`, `sortItems`, `pickRandomItem`, `isReleased`, `buildArtworkUrl`). Types `PlexWatchlistItem`, `WatchlistFilters`, `SortOption`, `TmdbMode` are defined here.
- `src/lib/storage.ts` — localStorage layer. Three keys: settings (`v2`), saved list links (`v1`, capped at `MAX_SAVED_LISTS = 24`), and cached list snapshots (`v1`, capped at `MAX_CACHED_LISTS = 8`). All readers tolerate malformed payloads by returning defaults. Bumping schema = bump the version suffix on the key.

### Loading strategy (important)

1. Frontend calls the function with `tmdbMode: "none"` for a fast initial scrape.
2. Frontend then batches `/tmdb-enrich` calls in chunks of `ENRICHMENT_BATCH_SIZE = 20`, prioritizing the first `INITIAL_PRIORITY_COUNT = 24` visible items.
3. Results are cached per URL in localStorage. Cache freshness window: `CACHE_FRESH_WINDOW_MS = 8h`. Fresh cache → skip remote. Stale cache → render cache immediately, refresh in background. Clicking "Load list" forces a remote refresh.

### Backend (`appwrite-functions/plexlists-scraper/`)

- Deployed separately to Appwrite (function ID `plexlists_scraper`, project `69876eae003275d80ff8`, endpoint `https://sfo.cloud.appwrite.io/v1`).
- `index.js` handles three routes: default (load a share URL), `/tmdb-enrich` (enrich already-loaded items), and `/watchlist` (signed-in watchlist via `discover.provider.plex.tv`). Constants worth knowing: `TMDB_MAX_LOOKUPS = 40` per enrichment call, `TMDB_LOOKUP_CONCURRENCY = 6`, scroll timeouts `BROWSER_SCRAPE_TIMEOUT_MS = 45s`.
- **Share lists are read via the Plex community GraphQL API first** (`https://community.plex.tv/api`, `customListBySlug(slug, username)`), paginated at `COMMUNITY_PAGE_SIZE = 100` with `429`/`Retry-After` backoff. The share URL `/u/<username>/lists/<slug>` supplies both arguments. Each returned node id is hydrated via `GET discover.provider.plex.tv/library/metadata/<id>` at `DISCOVER_HYDRATE_CONCURRENCY = 6`; hydration failures degrade to the fields GraphQL already returned. Auth uses the caller's Plex token when signed in, otherwise an anonymous token from `plex.tv/api/v2/users/anonymous`.
- The old HTML/Next.js-flight scraper (`v2ScrapeListWithFetch` → `parsePublicListHtml`) is now only a **fallback** used when the GraphQL path errors or returns nothing. It parses `self.__next_f` chunks for a `"list":[` marker and is inherently brittle to Plex frontend redesigns — a Plex Lists redesign is what broke it. Don't invest in it; fix the GraphQL path instead.
- `legacyHandler` and `scrapeListWithBrowser` (Playwright) are dead code — not exported, and `playwright-core` is not in the function's `package.json`.
- TMDB credentials live as Appwrite function env vars (`TMDB_API_READ_ACCESS_TOKEN` preferred, `TMDB_API_KEY` fallback). Redeploy the function after changing them.
- Modifying `index.js` does not affect the running backend until the function is redeployed to Appwrite.

### Deployment

- `.github/workflows/deploy-pages.yml` runs `npm run build:pages` on push to `main` and publishes `dist/` to GitHub Pages under `/plexlists/`.
- `scripts/prepare-pages-subdir.mjs` rewrites the build output so all assets live under `DEPLOY_SUBDIR`, and writes a landing `index.html`/`404.html` at the site root. It is a no-op unless `DEPLOY_SUBDIR` is set.
- A new frontend origin requires adding it as a Web platform in the Appwrite project, or CORS will fail.

## Conventions

- React 19 + Vite 8 + TypeScript. Functional components only; no routing library (single page).
- `main` branch is what deploys. No staging environment.
- Two ad-hoc test artifacts `.codex-appwrite-test.txt` and `.codex-appwrite-exec-test.txt` exist in repo root — not session logs, safe to ignore.
