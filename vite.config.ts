import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Connect } from 'vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const ALLOWED_HOSTS = new Set([
  'discover.provider.plex.tv',
  'luma.plex.tv',
  'metadata.provider.plex.tv',
  'watch.plex.tv',
])

const PLEX_TOKEN = process.env.PLEX_TOKEN?.trim() ?? ''
const BASE_PATH = process.env.BASE_PATH?.trim() || '/'

function proxyHandler(req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) {
  const requestUrl = new URL(req.url ?? '/', 'http://localhost')

  if (requestUrl.pathname !== '/api/plex-proxy') {
    next()
    return
  }

  const target = requestUrl.searchParams.get('url')

  if (!target) {
    res.statusCode = 400
    res.end('Missing url query parameter')
    return
  }

  let targetUrl: URL

  try {
    targetUrl = new URL(target)
  } catch {
    res.statusCode = 400
    res.end('Invalid url query parameter')
    return
  }

  if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
    res.statusCode = 403
    res.end('Host is not allowed')
    return
  }

  const upstreamHeaders = new Headers()

  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) {
      continue
    }

    const normalizedKey = key.toLowerCase()

    if (
      normalizedKey === 'host' ||
      normalizedKey === 'origin' ||
      normalizedKey === 'referer' ||
      normalizedKey === 'connection' ||
      normalizedKey === 'content-length' ||
      normalizedKey === 'x-plex-token'
    ) {
      continue
    }

    upstreamHeaders.set(key, Array.isArray(value) ? value.join(', ') : value)
  }

  if (PLEX_TOKEN) {
    upstreamHeaders.set('X-Plex-Token', PLEX_TOKEN)
  }

  fetch(targetUrl, {
    headers: upstreamHeaders,
  })
    .then(async (upstreamResponse) => {
      res.statusCode = upstreamResponse.status

      upstreamResponse.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'content-encoding' || key.toLowerCase() === 'transfer-encoding') {
          return
        }

        res.setHeader(key, value)
      })

      const body = Buffer.from(await upstreamResponse.arrayBuffer())
      res.end(body)
    })
    .catch((error) => {
      res.statusCode = 502
      res.end(error instanceof Error ? error.message : 'Proxy request failed')
    })
}

export default defineConfig({
  base: BASE_PATH,
  plugins: [
    react(),
    {
      name: 'plex-proxy',
      configureServer(server) {
        server.middlewares.use(proxyHandler)
      },
      configurePreviewServer(server) {
        server.middlewares.use(proxyHandler)
      },
    },
  ],
})
