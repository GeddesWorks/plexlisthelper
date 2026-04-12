# Plex List Picker

A React SPA for browsing a public Plex shared list, filtering it, and picking a random item from the current filtered pool.

## What it does

- Loads a public Plex list from a `watch.plex.tv` share link
- Filters by search text, media type, release state, genre, and minimum critic rating
- Supports shared-list-friendly sort orders
- Lets you make a manual active pick or reroll a random choice from the filtered results
- Enriches shared-list entries with Plex metadata so genres, ratings, and summaries work

## Local development

```bash
npm install
export PLEX_TOKEN=your-token
npm run dev
```

The dev server exposes a local proxy endpoint at `/api/plex-proxy` so the app can fetch Plex pages and APIs without browser CORS failures. Set `PLEX_TOKEN` in the server environment before starting Vite so paginated shared lists and metadata enrichment can succeed.

## Production build

```bash
npm run build
```

The production files are written to `dist/`.

For shared Plex lists from `watch.plex.tv`, a same-origin proxy is still required in production because Plex does not allow the browser to fetch those pages cross-origin from an arbitrary static host, and Plex’s paginated fragment API requires a valid token.

If you are deploying under a subpath such as `/plexlists/`, build with:

```bash
BASE_PATH=/plexlists/ npm run build
```

## Required setup

You will need:

- A public Plex list share link
- A server-side `PLEX_TOKEN` available to the proxy

The browser never asks for or stores the token. If you deploy this somewhere other than the built-in Vite dev or preview server, expose an equivalent same-origin `/api/plex-proxy` endpoint and inject the token there.

## GitHub Pages

A GitHub Actions workflow is included to publish the static frontend to GitHub Pages with `BASE_PATH=/plexlists/`.

That workflow also packages the built files into `/plexlists/` inside the final Pages artifact so a custom domain can serve this repo from `https://apps.geddesworks.com/plexlists/` instead of from the domain root.

The app still needs a same-origin `/api/plex-proxy` endpoint with `PLEX_TOKEN` configured, so GitHub Pages by itself is not enough for the full Plex integration.

If you want `apps.geddesworks.com/...` to host multiple apps from separate repos, do not point that custom domain directly at each individual tool repo. GitHub Pages can only publish one site per domain root. The workable shapes are:

- one shared "apps" site repo that owns `apps.geddesworks.com` and contains each tool at a subdirectory such as `/plexlists/`
- Cloudflare or another reverse proxy in front of multiple per-repo deployments

If you want to serve this specific app from `apps.geddesworks.com/plexlists/`, the likely shape is:

- GitHub Pages serves the static frontend at `/plexlists/`
- Cloudflare handles `apps.geddesworks.com`
- A Cloudflare Worker or other same-origin backend handles `/api/plex-proxy`

Without that proxy, the deployed page will load but Plex requests will fail.
