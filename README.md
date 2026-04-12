# Plex List Picker

A React SPA for browsing a public Plex shared list, filtering it, and picking a random item from the current filtered pool.

## What it does

- Loads a public Plex list from a `watch.plex.tv` share link
- Filters by search text, media type, release state, genre, and minimum critic rating
- Supports shared-list-friendly sort orders
- Lets you make a manual active pick or reroll a random choice from the filtered results
- Calls an Appwrite Function to scrape the public share page and enrich what metadata it can

## Local development

```bash
npm install
npm run dev
```

The app now calls Appwrite directly from the browser. By default it targets:

- endpoint: `https://sfo.cloud.appwrite.io/v1`
- project: `69876eae003275d80ff8`
- function: `plexlists_scraper`

You can override those with public Vite env vars before starting Vite:

```bash
VITE_APPWRITE_ENDPOINT=https://your-region.cloud.appwrite.io/v1
VITE_APPWRITE_PROJECT_ID=your-project-id
VITE_APPWRITE_FUNCTION_ID=your-function-id
npm run dev
```

If you load the app from a new origin, add that origin as a Web platform in the Appwrite project or the browser will hit Appwrite CORS failures.

## Production build

```bash
npm run build
```

The production files are written to `dist/`.

For shared Plex lists from `watch.plex.tv`, the frontend still cannot talk to Plex directly from an arbitrary static host because Plex does not expose those pages cross-origin, and Plex's paginated fragment API still requires a valid token. The Appwrite function exists to bridge that gap.

If you are deploying under a subpath such as `/plexlists/`, build with:

```bash
BASE_PATH=/plexlists/ npm run build
```

## Required setup

You will need:

- A public Plex list share link
- The `plexlists_scraper` Appwrite Function deployed somewhere reachable by the frontend
- The frontend origin added as a Web platform in that Appwrite project

The current function is intentionally tokenless. It can scrape the first public page of a shared list and then enrich individual items when Plex exposes that metadata anonymously. Plex still blocks anonymous pagination for longer lists, so this app currently shows the first publicly retrievable page rather than the complete list.

## GitHub Pages

A GitHub Actions workflow is included to publish the static frontend to GitHub Pages with `BASE_PATH=/plexlists/`.

That workflow also packages the built files into `/plexlists/` inside the final Pages artifact so a custom domain can serve this repo from `https://apps.geddesworks.com/plexlists/` instead of from the domain root.

GitHub Pages only serves the React app. The data requests still go to Appwrite, so Pages by itself is not the backend.

If you want `apps.geddesworks.com/...` to host multiple apps from separate repos, do not point that custom domain directly at each individual tool repo. GitHub Pages can only publish one site per domain root. The workable shapes are:

- one shared "apps" site repo that owns `apps.geddesworks.com` and contains each tool at a subdirectory such as `/plexlists/`
- Cloudflare or another reverse proxy in front of multiple per-repo deployments

If you want to serve this specific app from `apps.geddesworks.com/plexlists/`, the likely shape is:

- GitHub Pages serves the static frontend at `/plexlists/`
- Cloudflare or DNS handles `apps.geddesworks.com`
- Appwrite handles the `plexlists_scraper` function backend

Without the Appwrite function, the deployed page will load but list requests will fail.
