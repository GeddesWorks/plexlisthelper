import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const rawSubdir = process.env.DEPLOY_SUBDIR?.trim() ?? ''

if (!rawSubdir) {
  process.exit(0)
}

const segments = rawSubdir.split('/').filter(Boolean)

if (!segments.length) {
  process.exit(0)
}

const appName = process.env.APP_NAME?.trim() || 'App'
const sitePath = `/${segments.join('/')}/`
const distDir = resolve('dist')

if (!existsSync(distDir)) {
  throw new Error('The dist directory was not found. Run the build before packaging the Pages artifact.')
}

const targetDir = join(distDir, ...segments)
mkdirSync(targetDir, { recursive: true })

for (const entry of readdirSync(distDir)) {
  if (entry === segments[0]) {
    continue
  }

  renameSync(join(distDir, entry), join(targetDir, entry))
}

const rootIndex = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${appName}</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: "Segoe UI", sans-serif;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top, #28324a 0%, transparent 45%),
          linear-gradient(160deg, #0f1117 0%, #1b2130 100%);
        color: #f4f7fb;
      }

      main {
        width: min(640px, calc(100vw - 3rem));
        padding: 2rem;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 24px;
        background: rgba(10, 14, 22, 0.72);
        backdrop-filter: blur(18px);
      }

      h1 {
        margin: 0 0 0.75rem;
        font-size: clamp(2rem, 5vw, 3rem);
      }

      p {
        margin: 0 0 1rem;
        line-height: 1.55;
      }

      a {
        color: #9fd3ff;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${appName}</h1>
      <p>This build is published under <a href="${sitePath}">${sitePath}</a>.</p>
      <p>If you want multiple tools on this domain, use a shared host repo or a reverse proxy in front of the per-tool repos.</p>
    </main>
  </body>
</html>
`

writeFileSync(join(distDir, 'index.html'), rootIndex)
writeFileSync(join(distDir, '404.html'), rootIndex)
