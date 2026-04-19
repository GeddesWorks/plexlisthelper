import { randomUUID } from 'node:crypto'

const METADATA_BASE_URL = 'https://metadata.provider.plex.tv'
const DISCOVER_BASE_URL = 'https://discover.provider.plex.tv'
const WATCH_BASE_URL = 'https://watch.plex.tv'
const TMDB_API_BASE_URL = 'https://api.themoviedb.org/3'
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p'
const TMDB_POSTER_SIZE = 'w500'
const TMDB_BACKDROP_SIZE = 'w1280'
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

const PLEX_HEADERS = {
  Accept: 'application/xml',
  'X-Plex-Product': 'Plex List Picker',
  'X-Plex-Client-Identifier': 'plex-list-picker-appwrite',
  'X-Plex-Version': '1.0.0',
  'X-Plex-Platform': 'Web',
  'X-Plex-Platform-Version': 'Appwrite Function',
}

const BROWSER_SCRAPE_TIMEOUT_MS = 45_000
const MAX_SCROLL_STEPS = 22
const MAX_STABLE_SCROLL_STEPS = 5
const SCROLL_WAIT_MS = 700
const TMDB_MAX_LOOKUPS = 40
const TMDB_LOOKUP_CONCURRENCY = 6

function pushUniqueWarning(warnings, message) {
  if (!warnings.includes(message)) {
    warnings.push(message)
  }
}

function decodeHtmlEntities(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

function decodePossiblyEncodedUrl(value) {
  let nextValue = value

  for (let index = 0; index < 2; index += 1) {
    try {
      const decodedValue = decodeURIComponent(nextValue)

      if (decodedValue === nextValue) {
        break
      }

      nextValue = decodedValue
    } catch {
      break
    }
  }

  return nextValue
}

function normalizeShareUrl(rawValue) {
  const candidateValue = Array.isArray(rawValue) ? rawValue[0] : rawValue
  const trimmedValue = typeof candidateValue === 'string' ? candidateValue.trim() : ''

  if (!trimmedValue) {
    throw new Error('Missing share URL.')
  }

  const decodedValue = decodePossiblyEncodedUrl(trimmedValue)
  const nextUrl = /^https?:\/\//i.test(decodedValue)
    ? new URL(decodedValue)
    : new URL(`https://${decodedValue}`)

  if (nextUrl.hostname !== 'watch.plex.tv') {
    throw new Error('Only watch.plex.tv share links are supported.')
  }

  return nextUrl
}

function decodeNextFlightStream(html) {
  const chunkPattern = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g
  const chunks = [...html.matchAll(chunkPattern)].map((match) => match[1])

  if (!chunks.length) {
    return ''
  }

  return chunks
    .map((chunk) => {
      try {
        return JSON.parse(`"${chunk}"`)
      } catch {
        return chunk
      }
    })
    .join('')
}

function extractJsonArray(text, startIndex) {
  if (text[startIndex] !== '[') {
    return ''
  }

  let depth = 0
  let inString = false
  let isEscaped = false

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index]

    if (inString) {
      if (isEscaped) {
        isEscaped = false
        continue
      }

      if (char === '\\') {
        isEscaped = true
        continue
      }

      if (char === '"') {
        inString = false
      }

      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '[') {
      depth += 1
      continue
    }

    if (char === ']') {
      depth -= 1

      if (depth === 0) {
        return text.slice(startIndex, index + 1)
      }
    }
  }

  return ''
}

function readNextPageUrl(text, isEscaped) {
  const match = isEscaped
    ? text.match(/\\"nextUrl\\":\\"([\s\S]*?)\\"/)
    : text.match(/"nextUrl":"([\s\S]*?)"/)

  if (!match) {
    return ''
  }

  const rawValue = match[1]
  return isEscaped ? rawValue.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : rawValue
}

function mapPublicListItem(item) {
  const itemPath = item.link?.url ?? ''
  const title = item.title ?? ''
  const id = item.id ?? ''

  if (!id || !title || !/^\/(?:movie|show)\//.test(itemPath)) {
    return null
  }

  const year = Number(item.subtitle ?? '')
  const type = itemPath.startsWith('/show/') ? 'show' : 'movie'
  const imageUrl = item.image?.url ?? ''

  return {
    id: `${type}-${id}`,
    ratingKey: id,
    guid: itemPath,
    path: itemPath,
    canonicalUrl: new URL(itemPath, WATCH_BASE_URL).toString(),
    type,
    title,
    titleSort: title,
    year: Number.isFinite(year) ? year : null,
    summary: '',
    tagline: '',
    studio: '',
    contentRating: '',
    durationMinutes: null,
    childCount: null,
    thumb: imageUrl,
    art: imageUrl,
    genres: [],
    rating: null,
    audienceRating: null,
    originallyAvailableAt: Number.isFinite(year) ? `${year}-01-01` : '',
    watchlistedAt: '',
    ratingSource: '',
    audienceRatingSource: '',
    imageSource: imageUrl ? 'plex' : '',
  }
}

function parsePublicListHtml(html) {
  const searchableText = decodeNextFlightStream(html) || html
  const markerCandidates = ['"list":[', '\\"list\\":[']
  const matchedMarker = markerCandidates.find((marker) => searchableText.includes(marker)) ?? ''

  if (!matchedMarker) {
    throw new Error('The share page loaded, but the public list block was not found.')
  }

  const listMarkerIndex = searchableText.indexOf(matchedMarker)
  const arrayStartIndex = listMarkerIndex + matchedMarker.length - 1
  const arrayText = extractJsonArray(searchableText, arrayStartIndex)

  if (!arrayText) {
    throw new Error('The public list JSON could not be isolated from the share page.')
  }

  const normalizedArrayText =
    matchedMarker.startsWith('\\"') ? arrayText.replace(/\\"/g, '"') : arrayText
  const parsedItems = JSON.parse(normalizedArrayText)
  const items = parsedItems.map(mapPublicListItem).filter(Boolean)
  const nextUrl = readNextPageUrl(searchableText, matchedMarker.startsWith('\\"'))

  return { items, nextUrl }
}

function mapDomScrapedItem(item) {
  if (!item || typeof item.path !== 'string') {
    return null
  }

  const itemPath = item.path.trim()

  if (!/^\/(?:movie|show)\//.test(itemPath)) {
    return null
  }

  const type = itemPath.startsWith('/show/') ? 'show' : 'movie'
  const slug = itemPath.split('/').filter(Boolean).slice(1).join('/')
  const year = Number(item.year)
  const title = item.title?.trim() || slug.replaceAll('-', ' ')
  const imageUrl = item.imageUrl?.trim() ?? ''

  return {
    id: `${type}-${slug}`,
    ratingKey: slug,
    guid: itemPath,
    path: itemPath,
    canonicalUrl: new URL(itemPath, WATCH_BASE_URL).toString(),
    type,
    title,
    titleSort: title,
    year: Number.isFinite(year) ? year : null,
    summary: '',
    tagline: '',
    studio: '',
    contentRating: '',
    durationMinutes: null,
    childCount: null,
    thumb: imageUrl,
    art: imageUrl,
    genres: [],
    rating: null,
    audienceRating: null,
    originallyAvailableAt: Number.isFinite(year) ? `${year}-01-01` : '',
    watchlistedAt: '',
    ratingSource: '',
    audienceRatingSource: '',
    imageSource: imageUrl ? 'plex' : '',
  }
}

function addItemsByPath(targetMap, items) {
  for (const item of items) {
    if (!item?.path) {
      continue
    }

    const currentItem = targetMap.get(item.path)

    if (!currentItem) {
      targetMap.set(item.path, item)
      continue
    }

    // Preserve the strongest available identifier and artwork when merging.
    targetMap.set(item.path, {
      ...item,
      id: /^[0-9a-f]{24}$/i.test(currentItem.ratingKey) ? currentItem.id : item.id,
      ratingKey: /^[0-9a-f]{24}$/i.test(currentItem.ratingKey)
        ? currentItem.ratingKey
        : item.ratingKey,
      thumb: currentItem.thumb || item.thumb,
      art: currentItem.art || item.art,
    })
  }
}

function isMetadataRatingKey(ratingKey) {
  return /^[0-9a-f]{24}$/i.test(ratingKey)
}

function resolvePackagedChromiumPath() {
  const localBrowsersDir = path.join(
    process.cwd(),
    'node_modules',
    'playwright-core',
    '.local-browsers',
  )

  if (!fs.existsSync(localBrowsersDir)) {
    return ''
  }

  const entries = fs.readdirSync(localBrowsersDir).filter((entry) =>
    entry.startsWith('chromium_headless_shell-'),
  )

  if (!entries.length) {
    return ''
  }

  const latestEntry = [...entries].sort().at(-1)

  if (!latestEntry) {
    return ''
  }

  const executablePath = path.join(
    localBrowsersDir,
    latestEntry,
    'chrome-headless-shell-linux64',
    'chrome-headless-shell',
  )

  return fs.existsSync(executablePath) ? executablePath : ''
}

function readXmlAttribute(source, name) {
  const pattern = new RegExp(`${name}="([^"]*)"`)
  const match = source.match(pattern)
  return match ? decodeHtmlEntities(match[1]) : ''
}

function readXmlNumber(source, name) {
  const value = readXmlAttribute(source, name)

  if (!value) {
    return null
  }

  const parsedValue = Number(value)
  return Number.isFinite(parsedValue) ? parsedValue : null
}

function readXmlDate(source, name) {
  const value = readXmlAttribute(source, name)

  if (!value) {
    return ''
  }

  const numericValue = Number(value)
  return Number.isFinite(numericValue)
    ? new Date(numericValue * 1000).toISOString()
    : value
}

function buildTmdbConfig() {
  const readAccessToken =
    process.env.TMDB_API_READ_ACCESS_TOKEN?.trim() ||
    process.env.TMDB_READ_ACCESS_TOKEN?.trim() ||
    ''
  const apiKey = process.env.TMDB_API_KEY?.trim() || ''

  if (!readAccessToken && !apiKey) {
    return null
  }

  return {
    readAccessToken,
    apiKey,
  }
}

function tmdbRequestHeaders(config) {
  const headers = {
    accept: 'application/json',
  }

  if (config.readAccessToken) {
    headers.authorization = `Bearer ${config.readAccessToken}`
  }

  return headers
}

function tmdbImageUrl(path, size) {
  if (!path || typeof path !== 'string') {
    return ''
  }

  if (/^https?:\/\//i.test(path)) {
    return path
  }

  return `${TMDB_IMAGE_BASE_URL}/${size}${path}`
}

function tmdbNormalizeText(value) {
  return (value ?? '').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

function tmdbResultTitle(result, itemType) {
  if (itemType === 'show') {
    return result.name ?? result.original_name ?? ''
  }

  return result.title ?? result.original_title ?? ''
}

function tmdbResultYear(result, itemType) {
  const rawDate = itemType === 'show' ? result.first_air_date : result.release_date

  if (!rawDate || typeof rawDate !== 'string') {
    return null
  }

  const parsedYear = Number.parseInt(rawDate.slice(0, 4), 10)
  return Number.isFinite(parsedYear) ? parsedYear : null
}

function tmdbPickBestResult(item, results) {
  const normalizedItemTitle = tmdbNormalizeText(item.title)
  let bestResult = null
  let bestScore = Number.NEGATIVE_INFINITY

  for (const result of results) {
    const candidateTitle = tmdbResultTitle(result, item.type)
    const normalizedCandidateTitle = tmdbNormalizeText(candidateTitle)

    if (!normalizedCandidateTitle) {
      continue
    }

    let score = 0

    if (normalizedCandidateTitle === normalizedItemTitle) {
      score += 9
    } else if (
      normalizedCandidateTitle.includes(normalizedItemTitle) ||
      normalizedItemTitle.includes(normalizedCandidateTitle)
    ) {
      score += 5
    } else if (normalizedCandidateTitle.slice(0, 8) === normalizedItemTitle.slice(0, 8)) {
      score += 2
    }

    const candidateYear = tmdbResultYear(result, item.type)

    if (item.year && candidateYear) {
      const yearDelta = Math.abs(item.year - candidateYear)

      if (yearDelta === 0) {
        score += 5
      } else if (yearDelta === 1) {
        score += 2
      } else if (yearDelta <= 2) {
        score += 1
      } else {
        score -= 2
      }
    }

    if (typeof result.vote_count === 'number' && result.vote_count > 0) {
      score += Math.min(Math.log10(result.vote_count + 1), 2.25)
    }

    if (score > bestScore) {
      bestScore = score
      bestResult = result
    }
  }

  return {
    result: bestResult,
    score: bestScore,
  }
}

async function tmdbRequestJson(path, queryEntries, config) {
  const url = new URL(`${TMDB_API_BASE_URL}${path}`)
  const queryParams = new URLSearchParams(queryEntries)

  if (config.apiKey) {
    queryParams.set('api_key', config.apiKey)
  }

  url.search = queryParams.toString()

  const response = await fetch(url, {
    headers: tmdbRequestHeaders(config),
  })

  if (!response.ok) {
    const responseText = await response.text()
    const compactText = responseText.replace(/\s+/g, ' ').trim()

    throw new Error(
      `TMDB request failed with ${response.status}${compactText ? `: ${compactText.slice(0, 180)}` : '.'}`,
    )
  }

  return response.json()
}

async function tmdbFetchGenreMap(config, mediaType, log) {
  try {
    const payload = await tmdbRequestJson(`/genre/${mediaType}/list`, [['language', 'en-US']], config)
    const genreMap = new Map()

    for (const genre of payload.genres ?? []) {
      if (!genre?.id || !genre?.name) {
        continue
      }

      genreMap.set(genre.id, genre.name)
    }

    return genreMap
  } catch (caughtError) {
    log(
      `TMDB genre lookup failed (${mediaType}): ${
        caughtError instanceof Error ? caughtError.message : String(caughtError)
      }`,
    )

    return new Map()
  }
}

function tmdbMapGenres(genreIds, itemType, movieGenreMap, tvGenreMap) {
  if (!Array.isArray(genreIds) || !genreIds.length) {
    return []
  }

  const sourceMap = itemType === 'show' ? tvGenreMap : movieGenreMap
  return genreIds.map((genreId) => sourceMap.get(genreId)).filter(Boolean)
}

async function mapWithConcurrency(items, concurrency, worker) {
  if (!items.length) {
    return []
  }

  const workers = []
  let currentIndex = 0

  for (let index = 0; index < Math.min(concurrency, items.length); index += 1) {
    workers.push(
      (async () => {
        while (currentIndex < items.length) {
          const nextIndex = currentIndex
          currentIndex += 1
          await worker(items[nextIndex], nextIndex)
        }
      })(),
    )
  }

  await Promise.all(workers)
}

async function enrichItemsWithTmdb(items, warnings, log, options = {}) {
  const tmdbConfig = buildTmdbConfig()

  if (!tmdbConfig) {
    pushUniqueWarning(
      warnings,
      'TMDB enrichment is disabled on the scraper function because no TMDB credentials are configured.',
    )

    return items
  }

  const lookupLimitRaw =
    typeof options.maxLookups === 'number' ? options.maxLookups : Number(options.maxLookups)
  const lookupLimit = Number.isFinite(lookupLimitRaw)
    ? Math.max(1, Math.min(lookupLimitRaw, TMDB_MAX_LOOKUPS))
    : TMDB_MAX_LOOKUPS
  const onlyMissing = options.onlyMissing !== false
  const movieGenreMap = await tmdbFetchGenreMap(tmdbConfig, 'movie', log)
  const tvGenreMap = await tmdbFetchGenreMap(tmdbConfig, 'tv', log)
  const eligibleItems = items.filter(
    (item) =>
      !!item.title &&
      (item.type === 'movie' || item.type === 'show') &&
      (!onlyMissing ||
        !item.thumb ||
        !item.art ||
        item.rating == null ||
        item.audienceRating == null ||
        !item.summary),
  )
  const targetItems = eligibleItems.slice(0, lookupLimit)

  if (!targetItems.length) {
    return items
  }

  if (eligibleItems.length > lookupLimit) {
    pushUniqueWarning(
      warnings,
      `TMDB enrichment was capped to ${lookupLimit} items to keep response times stable.`,
    )
  }

  const tmdbResultCache = new Map()
  const enrichedItemsById = new Map()
  let appliedTmdbRating = false
  let appliedTmdbImage = false

  await mapWithConcurrency(targetItems, TMDB_LOOKUP_CONCURRENCY, async (item) => {
    const cacheKey = `${item.type}:${tmdbNormalizeText(item.title)}:${item.year ?? ''}`

    if (tmdbResultCache.has(cacheKey)) {
      enrichedItemsById.set(item.id, tmdbResultCache.get(cacheKey))
      return
    }

    const endpoint = item.type === 'show' ? '/search/tv' : '/search/movie'
    const queryEntries = [
      ['query', item.title],
      ['language', 'en-US'],
      ['include_adult', 'false'],
      ['page', '1'],
    ]

    if (item.year) {
      queryEntries.push([item.type === 'show' ? 'first_air_date_year' : 'year', String(item.year)])
    }

    try {
      const payload = await tmdbRequestJson(endpoint, queryEntries, tmdbConfig)
      const results = Array.isArray(payload.results) ? payload.results : []

      if (!results.length) {
        tmdbResultCache.set(cacheKey, item)
        enrichedItemsById.set(item.id, item)
        return
      }

      const bestMatch = tmdbPickBestResult(item, results)

      if (!bestMatch.result || bestMatch.score < 4) {
        tmdbResultCache.set(cacheKey, item)
        enrichedItemsById.set(item.id, item)
        return
      }

      const tmdbRating =
        typeof bestMatch.result.vote_average === 'number'
          ? Number(bestMatch.result.vote_average.toFixed(1))
          : null
      const tmdbPoster = tmdbImageUrl(bestMatch.result.poster_path, TMDB_POSTER_SIZE)
      const tmdbBackdrop = tmdbImageUrl(bestMatch.result.backdrop_path, TMDB_BACKDROP_SIZE)
      const tmdbGenres = tmdbMapGenres(
        bestMatch.result.genre_ids,
        item.type,
        movieGenreMap,
        tvGenreMap,
      )
      const tmdbYear = tmdbResultYear(bestMatch.result, item.type)

      const nextItem = {
        ...item,
        year: item.year ?? tmdbYear ?? null,
        summary: item.summary || bestMatch.result.overview || '',
        thumb: tmdbPoster || item.thumb,
        art: tmdbBackdrop || tmdbPoster || item.art,
        genres: item.genres?.length ? item.genres : tmdbGenres,
        rating: item.rating ?? tmdbRating,
        audienceRating: item.audienceRating ?? tmdbRating,
        ratingSource: item.rating != null ? item.ratingSource ?? 'plex' : tmdbRating != null ? 'tmdb' : '',
        audienceRatingSource:
          item.audienceRating != null
            ? item.audienceRatingSource ?? 'plex'
            : tmdbRating != null
              ? 'tmdb'
              : '',
        imageSource: tmdbPoster || tmdbBackdrop ? 'tmdb' : item.imageSource ?? '',
      }

      if (tmdbRating != null && (item.rating == null || item.audienceRating == null)) {
        appliedTmdbRating = true
      }

      if ((tmdbPoster || tmdbBackdrop) && (!item.thumb || !item.art || item.imageSource !== 'plex')) {
        appliedTmdbImage = true
      }

      tmdbResultCache.set(cacheKey, nextItem)
      enrichedItemsById.set(item.id, nextItem)
    } catch (caughtError) {
      log(
        `TMDB enrichment failed for ${item.title}: ${
          caughtError instanceof Error ? caughtError.message : String(caughtError)
        }`,
      )
      tmdbResultCache.set(cacheKey, item)
      enrichedItemsById.set(item.id, item)
    }
  })

  return items.map((item) => enrichedItemsById.get(item.id) ?? item)
}

function parseMetadataXml(xml) {
  const match = xml.match(/<(Video|Directory|Metadata)\b([^>]*)>([\s\S]*?)<\/\1>/)

  if (!match) {
    return null
  }

  const attributes = match[2]
  const innerXml = match[3]
  const genres = [...innerXml.matchAll(/<Genre\b[^>]*tag="([^"]*)"[^/]*\/>/g)].map((genreMatch) =>
    decodeHtmlEntities(genreMatch[1]),
  )

  const duration = readXmlNumber(attributes, 'duration')

  return {
    guid: readXmlAttribute(attributes, 'guid'),
    summary: readXmlAttribute(attributes, 'summary'),
    tagline: readXmlAttribute(attributes, 'tagline'),
    studio: readXmlAttribute(attributes, 'studio'),
    contentRating: readXmlAttribute(attributes, 'contentRating'),
    durationMinutes: duration ? Math.round(duration / 60000) : null,
    childCount:
      readXmlNumber(attributes, 'childCount') ??
      readXmlNumber(attributes, 'leafCount') ??
      readXmlNumber(attributes, 'viewedLeafCount'),
    thumb: readXmlAttribute(attributes, 'thumb'),
    art: readXmlAttribute(attributes, 'art'),
    genres,
    rating: readXmlNumber(attributes, 'rating'),
    audienceRating: readXmlNumber(attributes, 'audienceRating'),
    originallyAvailableAt: readXmlDate(attributes, 'originallyAvailableAt'),
    watchlistedAt: readXmlDate(attributes, 'watchlistedAt'),
    ratingSource: readXmlNumber(attributes, 'rating') != null ? 'plex' : '',
    audienceRatingSource: readXmlNumber(attributes, 'audienceRating') != null ? 'plex' : '',
    imageSource:
      readXmlAttribute(attributes, 'thumb') || readXmlAttribute(attributes, 'art') ? 'plex' : '',
  }
}

async function enrichItems(items, warnings, log, options = {}) {
  const enrichedItems = []

  for (const item of items) {
    if (!isMetadataRatingKey(item.ratingKey)) {
      enrichedItems.push(item)
      continue
    }

    try {
      const response = await fetch(`${METADATA_BASE_URL}/library/metadata/${item.ratingKey}`, {
        headers: PLEX_HEADERS,
      })

      if (!response.ok) {
        warnings.push(`Metadata lookup failed for ${item.title} with ${response.status}.`)
        enrichedItems.push(item)
        continue
      }

      const metadata = parseMetadataXml(await response.text())

      if (!metadata) {
        warnings.push(`Metadata for ${item.title} returned an unexpected XML payload.`)
        enrichedItems.push(item)
        continue
      }

      enrichedItems.push({
        ...item,
        ...metadata,
        id: item.id,
        ratingKey: item.ratingKey,
        path: item.path,
        canonicalUrl: item.canonicalUrl,
        thumb: item.thumb || metadata.thumb,
        art: item.art || metadata.art,
      })
    } catch (caughtError) {
      log(
        `Metadata lookup failed for ${item.title}: ${caughtError instanceof Error ? caughtError.message : String(caughtError)}`,
      )
      warnings.push(`Metadata lookup threw for ${item.title}.`)
      enrichedItems.push(item)
    }
  }

  const tmdbMode = options.tmdbMode === 'none' ? 'none' : 'auto'

  if (tmdbMode === 'none') {
    return enrichedItems
  }

  return enrichItemsWithTmdb(enrichedItems, warnings, log, options.tmdbOptions ?? {})
}

async function scrapeListWithFetch(shareUrl) {
  const shareResponse = await fetch(shareUrl, {
    headers: {
      'user-agent': 'plexlists-appwrite-scraper',
    },
  })

  if (!shareResponse.ok) {
    throw new Error(`Share page request failed with ${shareResponse.status}.`)
  }

  const parsed = parsePublicListHtml(await shareResponse.text())

  return {
    mode: 'html',
    items: parsed.items,
    nextUrl: parsed.nextUrl,
    initialCount: parsed.items.length,
  }
}

async function driveScrollPagination(page, itemMap) {
  let previousCount = itemMap.size
  let stableSteps = 0

  for (let step = 0; step < MAX_SCROLL_STEPS && stableSteps < MAX_STABLE_SCROLL_STEPS; step += 1) {
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight)
    })
    await page.waitForTimeout(SCROLL_WAIT_MS)
    await page.mouse.wheel(0, 3200)
    await page.waitForTimeout(SCROLL_WAIT_MS)

    const currentCount = itemMap.size

    if (currentCount === previousCount) {
      stableSteps += 1
      continue
    }

    previousCount = currentCount
    stableSteps = 0
  }
}

async function extractDomItems(page) {
  const domItems = await page.evaluate(() => {
    const rowLinks = [
      ...document.querySelectorAll('a[aria-label][href^="/movie/"], a[aria-label][href^="/show/"]'),
    ]

    return rowLinks.map((link) => {
      const path = link.getAttribute('href') ?? ''
      const title = link.getAttribute('aria-label') ?? ''
      const rowRoot = link.closest('div')?.parentElement ?? link.parentElement ?? link
      const imageUrl = rowRoot.querySelector('img')?.getAttribute('src') ?? ''
      const textBlob = rowRoot.textContent?.replace(/\s+/g, ' ').trim() ?? ''
      const yearMatch = textBlob.match(/\b(19|20)\d{2}\b/)

      return {
        path,
        title,
        imageUrl,
        year: yearMatch ? Number(yearMatch[0]) : null,
      }
    })
  })

  return domItems.map(mapDomScrapedItem).filter(Boolean)
}

async function scrapeListWithBrowser(shareUrl, log) {
  let browser

  try {
    const launchOptions = {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    }
    const defaultExecutablePath = chromium.executablePath()

    if (!fs.existsSync(defaultExecutablePath)) {
      const packagedExecutablePath = resolvePackagedChromiumPath()

      if (packagedExecutablePath) {
        launchOptions.executablePath = packagedExecutablePath
        log(`Using packaged Chromium at: ${packagedExecutablePath}`)
      }
    }

    browser = await chromium.launch(launchOptions)

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(BROWSER_SCRAPE_TIMEOUT_MS)

    const itemMap = new Map()

    await page.goto(shareUrl.toString(), { waitUntil: 'domcontentloaded' })

    const initialParse = parsePublicListHtml(await page.content())
    addItemsByPath(itemMap, initialParse.items)

    await page.waitForTimeout(1_200)
    await driveScrollPagination(page, itemMap)
    const domItems = await extractDomItems(page)
    addItemsByPath(itemMap, domItems)

    if (itemMap.size <= initialParse.items.length) {
      log('Browser scrape did not discover additional list items after scrolling.')
    }

    return {
      mode: 'browser',
      items: [...itemMap.values()],
      nextUrl: initialParse.nextUrl,
      initialCount: initialParse.items.length,
    }
  } finally {
    if (browser) {
      await browser.close()
    }
  }
}

function readBodyObject(body) {
  if (!body) {
    return null
  }

  if (typeof body === 'string') {
    const trimmedBody = body.trim()

    if (!trimmedBody) {
      return null
    }

    try {
      const parsed = JSON.parse(trimmedBody)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  return typeof body === 'object' ? body : null
}

function readShareUrlFromBody(body) {
  const bodyObject = readBodyObject(body)

  if (!bodyObject) {
    return ''
  }

  if (typeof bodyObject.url === 'string') {
    return bodyObject.url
  }

  if (typeof bodyObject.shareUrl === 'string') {
    return bodyObject.shareUrl
  }

  if (typeof bodyObject.sharedListUrl === 'string') {
    return bodyObject.sharedListUrl
  }

  return ''
}

function readQueryStringParam(value) {
  if (Array.isArray(value)) {
    return readQueryStringParam(value[0])
  }

  return typeof value === 'string' ? value : ''
}

function readTmdbModeValue(value) {
  if (typeof value !== 'string') {
    return ''
  }

  const normalizedValue = value.trim().toLowerCase()

  if (normalizedValue === 'none' || normalizedValue === 'auto') {
    return normalizedValue
  }

  return ''
}

function readTmdbModeFromBody(body) {
  const bodyObject = readBodyObject(body)

  if (!bodyObject) {
    return ''
  }

  return readTmdbModeValue(bodyObject.tmdbMode)
}

function normalizeTmdbEnrichmentItem(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') {
    return null
  }

  const type = rawItem.type === 'show' ? 'show' : rawItem.type === 'movie' ? 'movie' : ''
  const id = typeof rawItem.id === 'string' ? rawItem.id.trim() : ''
  const title = typeof rawItem.title === 'string' ? rawItem.title.trim() : ''

  if (!type || !id || !title) {
    return null
  }

  const yearValue =
    typeof rawItem.year === 'number' ? rawItem.year : Number.parseInt(String(rawItem.year ?? ''), 10)
  const year = Number.isFinite(yearValue) ? yearValue : null

  return {
    id,
    ratingKey: typeof rawItem.ratingKey === 'string' ? rawItem.ratingKey : id,
    guid: typeof rawItem.guid === 'string' ? rawItem.guid : '',
    path: typeof rawItem.path === 'string' ? rawItem.path : '',
    canonicalUrl: typeof rawItem.canonicalUrl === 'string' ? rawItem.canonicalUrl : '',
    type,
    title,
    titleSort: typeof rawItem.titleSort === 'string' ? rawItem.titleSort : title,
    year,
    summary: typeof rawItem.summary === 'string' ? rawItem.summary : '',
    tagline: typeof rawItem.tagline === 'string' ? rawItem.tagline : '',
    studio: typeof rawItem.studio === 'string' ? rawItem.studio : '',
    contentRating: typeof rawItem.contentRating === 'string' ? rawItem.contentRating : '',
    durationMinutes:
      typeof rawItem.durationMinutes === 'number' && Number.isFinite(rawItem.durationMinutes)
        ? rawItem.durationMinutes
        : null,
    childCount:
      typeof rawItem.childCount === 'number' && Number.isFinite(rawItem.childCount)
        ? rawItem.childCount
        : null,
    thumb: typeof rawItem.thumb === 'string' ? rawItem.thumb : '',
    art: typeof rawItem.art === 'string' ? rawItem.art : '',
    genres: Array.isArray(rawItem.genres)
      ? rawItem.genres.filter((genre) => typeof genre === 'string' && genre.trim()).map((genre) => genre.trim())
      : [],
    rating: typeof rawItem.rating === 'number' && Number.isFinite(rawItem.rating) ? rawItem.rating : null,
    audienceRating:
      typeof rawItem.audienceRating === 'number' && Number.isFinite(rawItem.audienceRating)
        ? rawItem.audienceRating
        : null,
    originallyAvailableAt:
      typeof rawItem.originallyAvailableAt === 'string' ? rawItem.originallyAvailableAt : '',
    watchlistedAt: typeof rawItem.watchlistedAt === 'string' ? rawItem.watchlistedAt : '',
    ratingSource: rawItem.ratingSource === 'tmdb' || rawItem.ratingSource === 'plex' ? rawItem.ratingSource : '',
    audienceRatingSource:
      rawItem.audienceRatingSource === 'tmdb' || rawItem.audienceRatingSource === 'plex'
        ? rawItem.audienceRatingSource
        : '',
    imageSource: rawItem.imageSource === 'tmdb' || rawItem.imageSource === 'plex' ? rawItem.imageSource : '',
  }
}

function readTmdbEnrichmentItemsFromBody(body) {
  const bodyObject = readBodyObject(body)

  if (!bodyObject || !Array.isArray(bodyObject.items)) {
    return []
  }

  return bodyObject.items.map(normalizeTmdbEnrichmentItem).filter(Boolean)
}

const legacyHandler = async ({ req, res, log, error }) => {
  if (req.method === 'OPTIONS') {
    return res.text('', 204, CORS_HEADERS)
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.json(
      {
        ok: false,
        error: 'Only GET, POST, and OPTIONS are supported.',
      },
      405,
      CORS_HEADERS,
    )
  }

  const rawShareUrl = req.query.url ?? req.query.shareUrl ?? readShareUrlFromBody(req.body)

  if (!rawShareUrl) {
    return res.json(
      {
        ok: false,
        error:
          'Provide a watch.plex.tv share link in the url query parameter or in a JSON POST body.',
      },
      400,
      CORS_HEADERS,
    )
  }

  try {
    const shareUrl = normalizeShareUrl(rawShareUrl)
    const warnings = []

    let scraped

    try {
      scraped = await scrapeListWithBrowser(shareUrl, log)
    } catch (caughtError) {
      log(
        `Browser scrape failed, falling back to first-page parser: ${
          caughtError instanceof Error ? caughtError.message : String(caughtError)
        }`,
      )
      pushUniqueWarning(
        warnings,
        'Headless browser pagination failed, so this run fell back to first-page parsing.',
      )
      scraped = await scrapeListWithFetch(shareUrl)
    }

    if (scraped.nextUrl && scraped.items.length <= scraped.initialCount) {
      pushUniqueWarning(
        warnings,
        'This list appears to have additional pages, but this run only retrieved the first page.',
      )
    }

    const enrichedItems = await enrichItems(scraped.items, warnings, log)

    return res.json(
      {
        ok: true,
        shareUrl: shareUrl.toString(),
        scrapeMode: scraped.mode,
        total: enrichedItems.length,
        nextUrl: scraped.nextUrl,
        items: enrichedItems,
        warnings,
      },
      200,
      CORS_HEADERS,
    )
  } catch (caughtError) {
    const message =
      caughtError instanceof Error
        ? caughtError.message
        : 'The scraper failed for an unknown reason.'

    error(message)

    return res.json(
      {
        ok: false,
        error: message,
      },
      500,
      CORS_HEADERS,
    )
  }
}

const V2_DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/147.0.0.0 Safari/537.36'
const V2_WATCH_LUMA_PROXY_URL = `${WATCH_BASE_URL}/api/luma`
const V2_MAX_LUMA_PAGES = 80

function v2ReadSetCookieHeaders(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie()
  }

  return []
}

function v2CookieHeaderFromSetCookie(setCookieHeaders) {
  if (!setCookieHeaders?.length) {
    return ''
  }

  return setCookieHeaders.map((cookie) => cookie.split(';')[0]).join('; ')
}

function v2MergeCookieHeaders(...cookieHeaders) {
  return cookieHeaders
    .filter(Boolean)
    .map((value) => value.trim())
    .filter(Boolean)
    .join('; ')
}

function v2NormalizeLumaNextUrl(rawValue) {
  const trimmedValue = rawValue?.trim()

  if (!trimmedValue) {
    return ''
  }

  if (/^https?:\/\//i.test(trimmedValue)) {
    return trimmedValue
  }

  if (trimmedValue.startsWith('/')) {
    return new URL(trimmedValue, 'https://luma.plex.tv').toString()
  }

  return ''
}

function v2ParseLumaListPage(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Luma response was empty or invalid.')
  }

  if (!Array.isArray(payload.content)) {
    throw new Error('Luma response did not include a content array.')
  }

  return {
    items: payload.content.map(mapPublicListItem).filter(Boolean),
    nextUrl: v2NormalizeLumaNextUrl(payload.pagination?.nextUrl ?? ''),
  }
}

async function v2ReadJsonOrThrow(response, sourceName) {
  const bodyText = await response.text()

  if (!response.ok) {
    const compactBody = bodyText.replace(/\s+/g, ' ').trim()
    throw new Error(
      `${sourceName} returned ${response.status}${compactBody ? `: ${compactBody.slice(0, 200)}` : '.'}`,
    )
  }

  if (!bodyText.trim()) {
    throw new Error(`${sourceName} returned 200 but no JSON body.`)
  }

  try {
    return JSON.parse(bodyText)
  } catch {
    throw new Error(`${sourceName} returned a non-JSON payload.`)
  }
}

async function v2CreateAnonymousAuth(log) {
  const clientIdentifier = `plex-list-picker-${randomUUID()}`
  const response = await fetch('https://plex.tv/api/v2/users/anonymous', {
    method: 'POST',
    headers: {
      'user-agent': V2_DEFAULT_USER_AGENT,
      accept: 'application/xml',
      'x-plex-client-identifier': clientIdentifier,
      'x-plex-product': 'Plex Mediaverse',
      'x-plex-provider-version': '1',
    },
  })

  const xml = await response.text()

  if (!response.ok) {
    const compactBody = xml.replace(/\s+/g, ' ').trim()
    throw new Error(
      `Anonymous auth request failed with ${response.status}${compactBody ? `: ${compactBody.slice(0, 200)}` : '.'}`,
    )
  }

  const tokenMatch = xml.match(/authToken="([^"]+)"/i)

  if (!tokenMatch?.[1]) {
    throw new Error('Anonymous auth response did not include an auth token.')
  }

  log('Created anonymous Plex auth token for pagination attempts.')

  return {
    token: tokenMatch[1],
    cookieHeader: v2CookieHeaderFromSetCookie(v2ReadSetCookieHeaders(response)),
    clientIdentifier,
  }
}

async function v2FetchLumaViaWatchProxy(nextUrl, shareUrl, extraHeaders, auth) {
  const params = new URLSearchParams({
    lumaCache: 'always-dynamic',
    url: encodeURIComponent(nextUrl),
  })
  const headers = {
    referer: shareUrl.toString(),
    'user-agent': V2_DEFAULT_USER_AGENT,
    accept: '*/*',
    ...extraHeaders,
  }
  const mergedCookie = v2MergeCookieHeaders(headers.cookie ?? '', auth?.cookieHeader ?? '')

  if (mergedCookie) {
    headers.cookie = mergedCookie
  }

  if (auth?.token) {
    headers['x-plex-token'] = auth.token
    headers['x-plex-client-identifier'] = auth.clientIdentifier
    headers['x-plex-product'] = 'Plex Mediaverse'
    headers['x-plex-provider-version'] = '1'
  }

  const response = await fetch(`${V2_WATCH_LUMA_PROXY_URL}?${params.toString()}`, {
    method: 'POST',
    headers,
  })

  return v2ReadJsonOrThrow(response, 'Watch luma proxy')
}

async function v2FetchLumaDirect(nextUrl, shareUrl, auth) {
  if (!auth?.token) {
    throw new Error('Direct luma fetch requires a token.')
  }

  const response = await fetch(nextUrl, {
    headers: {
      referer: shareUrl.toString(),
      'user-agent': V2_DEFAULT_USER_AGENT,
      accept: 'application/json',
      cookie: auth.cookieHeader ?? '',
      'x-plex-token': auth.token,
      'x-plex-client-identifier': auth.clientIdentifier,
      'x-plex-product': 'Plex Mediaverse',
      'x-plex-provider-version': '1',
    },
  })

  return v2ReadJsonOrThrow(response, 'Luma direct')
}

async function v2FetchNextLumaPage(nextUrl, shareUrl, shareCookieHeader, auth, log) {
  const strategies = [
    {
      name: 'watch-proxy-basic',
      run: () =>
        v2FetchLumaViaWatchProxy(
          nextUrl,
          shareUrl,
          {
            origin: WATCH_BASE_URL,
          },
          null,
        ),
    },
    {
      name: 'watch-proxy-browser-headers',
      run: () =>
        v2FetchLumaViaWatchProxy(
          nextUrl,
          shareUrl,
          {
            origin: WATCH_BASE_URL,
            'sec-fetch-site': 'same-origin',
            'sec-fetch-mode': 'cors',
            'sec-fetch-dest': 'empty',
            'sec-ch-ua': '"HeadlessChrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
          },
          null,
        ),
    },
    {
      name: 'watch-proxy-share-cookie',
      run: () =>
        v2FetchLumaViaWatchProxy(
          nextUrl,
          shareUrl,
          {
            origin: WATCH_BASE_URL,
            cookie: shareCookieHeader,
          },
          null,
        ),
    },
    {
      name: 'watch-proxy-auth-token',
      run: () =>
        v2FetchLumaViaWatchProxy(
          nextUrl,
          shareUrl,
          {
            origin: WATCH_BASE_URL,
            cookie: shareCookieHeader,
          },
          auth,
        ),
    },
    {
      name: 'luma-direct-auth-token',
      run: () => v2FetchLumaDirect(nextUrl, shareUrl, auth),
    },
  ]

  let lastError = null

  for (const strategy of strategies) {
    try {
      const payload = await strategy.run()
      log(`Pagination strategy succeeded: ${strategy.name}`)
      return payload
    } catch (caughtError) {
      lastError = caughtError
      log(
        `Pagination strategy failed (${strategy.name}): ${
          caughtError instanceof Error ? caughtError.message : String(caughtError)
        }`,
      )
    }
  }

  throw lastError ?? new Error('All pagination strategies failed.')
}

async function v2PaginatePublicList(initialItems, initialNextUrl, shareUrl, shareCookieHeader, warnings, log, preferredAuth) {
  const itemMap = new Map()
  addItemsByPath(itemMap, initialItems)

  let nextUrl = v2NormalizeLumaNextUrl(initialNextUrl)

  if (!nextUrl) {
    return {
      mode: 'html',
      items: [...itemMap.values()],
      nextUrl: '',
    }
  }

  let auth = preferredAuth ?? null

  if (!auth) {
    try {
      auth = await v2CreateAnonymousAuth(log)
    } catch (caughtError) {
      log(
        `Anonymous auth setup failed: ${
          caughtError instanceof Error ? caughtError.message : String(caughtError)
        }`,
      )
    }
  }

  const seenUrls = new Set()
  let loadedPages = 0

  while (nextUrl && !seenUrls.has(nextUrl) && loadedPages < V2_MAX_LUMA_PAGES) {
    seenUrls.add(nextUrl)

    let payload

    try {
      payload = await v2FetchNextLumaPage(nextUrl, shareUrl, shareCookieHeader, auth, log)
    } catch (caughtError) {
      pushUniqueWarning(
        warnings,
        'Anonymous pagination requests were blocked, so only the first page could be loaded.',
      )
      log(
        `Pagination stopped after ${loadedPages} pages: ${
          caughtError instanceof Error ? caughtError.message : String(caughtError)
        }`,
      )
      break
    }

    let parsedPage

    try {
      parsedPage = v2ParseLumaListPage(payload)
    } catch (caughtError) {
      pushUniqueWarning(
        warnings,
        'A pagination response had an unexpected format, so loading stopped early.',
      )
      log(
        `Pagination parse failed: ${
          caughtError instanceof Error ? caughtError.message : String(caughtError)
        }`,
      )
      break
    }

    addItemsByPath(itemMap, parsedPage.items)
    nextUrl = parsedPage.nextUrl
    loadedPages += 1
  }

  if (loadedPages >= V2_MAX_LUMA_PAGES && nextUrl) {
    pushUniqueWarning(
      warnings,
      `Pagination stopped after ${V2_MAX_LUMA_PAGES} pages to avoid unbounded requests.`,
    )
  }

  return {
    mode: loadedPages > 0 ? 'html+luma' : 'html',
    items: [...itemMap.values()],
    nextUrl,
  }
}

async function v2ScrapeListWithFetch(shareUrl, warnings, log, plexToken) {
  const extraHeaders = {}

  if (plexToken) {
    extraHeaders['x-plex-token'] = plexToken
    extraHeaders['cookie'] = `token=${plexToken}; myPlexAccessToken=${plexToken}`
  }

  const shareResponse = await fetch(shareUrl.toString(), {
    headers: {
      'user-agent': V2_DEFAULT_USER_AGENT,
      ...extraHeaders,
    },
  })

  if (shareResponse.status === 401 || shareResponse.status === 403) {
    throw new Error(
      plexToken
        ? "This list is private and your Plex account doesn't have access to it."
        : "This list is private. Sign in with Plex and try again, or make the list public.",
    )
  }

  if (shareResponse.status === 404) {
    throw new Error(
      plexToken
        ? 'List not found. The link may be wrong or the list may have been removed.'
        : "List not found. If it's a private list, sign in with Plex and try again, or make the list public.",
    )
  }

  if (!shareResponse.ok) {
    throw new Error(`Share page request failed with ${shareResponse.status}.`)
  }

  const shareCookieHeader = v2CookieHeaderFromSetCookie(v2ReadSetCookieHeaders(shareResponse))
  const htmlText = await shareResponse.text()

  let parsed

  try {
    parsed = parsePublicListHtml(htmlText)
  } catch (parseError) {
    if (!plexToken) {
      throw new Error(
        "This list couldn't be loaded. It may be private — sign in with Plex and try again, or make the list public.",
      )
    }

    throw parseError
  }

  const preferredAuth = plexToken
    ? {
        token: plexToken,
        cookieHeader: '',
        clientIdentifier: 'plex-list-picker-web',
      }
    : null

  const paginated = await v2PaginatePublicList(
    parsed.items,
    parsed.nextUrl,
    shareUrl,
    shareCookieHeader,
    warnings,
    log,
    preferredAuth,
  )

  return {
    mode: paginated.mode,
    items: paginated.items,
    nextUrl: paginated.nextUrl,
    initialCount: parsed.items.length,
  }
}

function mapWatchlistApiItem(item, plexToken) {
  const ratingKey = typeof item.ratingKey === 'string' ? item.ratingKey : ''
  const guid = typeof item.guid === 'string' ? item.guid : ''
  const title = typeof item.title === 'string' ? item.title.trim() : ''

  if (!title) {
    return null
  }

  const type = item.type === 'show' ? 'show' : 'movie'
  const id = ratingKey || guid || `${type}-${title}`
  const year = typeof item.year === 'number' ? item.year : null

  const thumb =
    typeof item.thumb === 'string' && item.thumb
      ? `${METADATA_BASE_URL}${item.thumb}?X-Plex-Token=${plexToken}`
      : ''
  const art =
    typeof item.art === 'string' && item.art
      ? `${METADATA_BASE_URL}${item.art}?X-Plex-Token=${plexToken}`
      : ''

  const genres = Array.isArray(item.Genre)
    ? item.Genre.map((g) => (typeof g.tag === 'string' ? g.tag : '')).filter(Boolean)
    : []

  const rating = typeof item.rating === 'number' ? item.rating : null
  const audienceRating = typeof item.audienceRating === 'number' ? item.audienceRating : null

  const watchlistedAt =
    typeof item.addedAt === 'number' ? new Date(item.addedAt * 1000).toISOString() : ''

  return {
    id,
    ratingKey,
    guid,
    type,
    title,
    titleSort: typeof item.titleSort === 'string' ? item.titleSort : title,
    year,
    summary: typeof item.summary === 'string' ? item.summary : '',
    tagline: typeof item.tagline === 'string' ? item.tagline : '',
    studio: typeof item.studio === 'string' ? item.studio : '',
    contentRating: typeof item.contentRating === 'string' ? item.contentRating : '',
    durationMinutes:
      typeof item.duration === 'number' ? Math.round(item.duration / 60000) : null,
    childCount: typeof item.childCount === 'number' ? item.childCount : null,
    thumb,
    art,
    genres,
    rating,
    audienceRating,
    ratingSource: rating !== null ? 'plex' : '',
    audienceRatingSource: audienceRating !== null ? 'plex' : '',
    imageSource: thumb ? 'plex' : '',
    originallyAvailableAt:
      typeof item.originallyAvailableAt === 'string'
        ? item.originallyAvailableAt
        : year
          ? `${year}-01-01`
          : '',
    watchlistedAt,
  }
}

async function fetchPlexWatchlistItems(plexToken, log) {
  const headers = {
    ...PLEX_HEADERS,
    Accept: 'application/json',
    'X-Plex-Token': plexToken,
  }

  const pageSize = 100
  let offset = 0
  const allItems = []

  while (true) {
    const url = `${DISCOVER_BASE_URL}/library/sections/watchlist/all?X-Plex-Container-Start=${offset}&X-Plex-Container-Size=${pageSize}`
    log(`Fetching watchlist page offset=${offset}`)

    const response = await fetch(url, { headers })

    if (response.status === 401) {
      throw new Error('Invalid or expired Plex token. Please check your token and try again.')
    }

    if (!response.ok) {
      throw new Error(`Plex watchlist API returned ${response.status}.`)
    }

    const data = await response.json()
    const metadata = Array.isArray(data?.MediaContainer?.Metadata)
      ? data.MediaContainer.Metadata
      : []

    allItems.push(...metadata)

    const totalSize =
      typeof data?.MediaContainer?.totalSize === 'number'
        ? data.MediaContainer.totalSize
        : metadata.length

    offset += metadata.length

    if (metadata.length === 0 || offset >= totalSize) {
      break
    }
  }

  log(`Fetched ${allItems.length} watchlist items`)
  return allItems.map((item) => mapWatchlistApiItem(item, plexToken)).filter(Boolean)
}

export default async ({ req, res, log, error }) => {
  if (req.method === 'OPTIONS') {
    return res.text('', 204, CORS_HEADERS)
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.json(
      {
        ok: false,
        error: 'Only GET, POST, and OPTIONS are supported.',
      },
      405,
      CORS_HEADERS,
    )
  }

  const bodyObject = readBodyObject(req.body)
  const requestPath = typeof req.path === 'string' ? req.path : '/'
  const isTmdbEnrichmentRoute = requestPath === '/tmdb-enrich' || requestPath === 'tmdb-enrich'
  const isWatchlistRoute = requestPath === '/watchlist' || requestPath === 'watchlist'

  if (isTmdbEnrichmentRoute) {
    if (req.method !== 'POST') {
      return res.json(
        {
          ok: false,
          error: 'TMDB enrichment only supports POST requests.',
        },
        405,
        CORS_HEADERS,
      )
    }

    const incomingItems = readTmdbEnrichmentItemsFromBody(bodyObject)

    if (!incomingItems.length) {
      return res.json(
        {
          ok: false,
          error: 'Provide a non-empty items array with id, type, and title for TMDB enrichment.',
        },
        400,
        CORS_HEADERS,
      )
    }

    try {
      const warnings = []
      const enrichedItems = await enrichItemsWithTmdb(incomingItems, warnings, log, {
        maxLookups: incomingItems.length,
        onlyMissing: false,
      })

      return res.json(
        {
          ok: true,
          total: enrichedItems.length,
          items: enrichedItems,
          warnings,
        },
        200,
        CORS_HEADERS,
      )
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : 'TMDB batch enrichment failed for an unknown reason.'

      error(message)

      return res.json(
        {
          ok: false,
          error: message,
        },
        500,
        CORS_HEADERS,
      )
    }
  }

  if (isWatchlistRoute) {
    if (req.method !== 'POST') {
      return res.json(
        { ok: false, error: 'Watchlist route only supports POST requests.' },
        405,
        CORS_HEADERS,
      )
    }

    const plexToken =
      typeof bodyObject?.plexToken === 'string' ? bodyObject.plexToken.trim() : ''

    if (!plexToken) {
      return res.json(
        { ok: false, error: 'Provide a plexToken in the POST body.' },
        400,
        CORS_HEADERS,
      )
    }

    try {
      const warnings = []
      const items = await fetchPlexWatchlistItems(plexToken, log)
      const enrichedItems = await enrichItems(items, warnings, log, { tmdbMode: 'none' })

      return res.json({ ok: true, items: enrichedItems, warnings }, 200, CORS_HEADERS)
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : 'Failed to fetch Plex watchlist for an unknown reason.'

      error(message)

      return res.json({ ok: false, error: message }, 500, CORS_HEADERS)
    }
  }

  const rawShareUrl = req.query.url ?? req.query.shareUrl ?? readShareUrlFromBody(req.body)

  if (!rawShareUrl) {
    return res.json(
      {
        ok: false,
        error:
          'Provide a watch.plex.tv share link in the url query parameter or in a JSON POST body.',
      },
      400,
      CORS_HEADERS,
    )
  }

  const plexToken =
    typeof bodyObject?.plexToken === 'string' ? bodyObject.plexToken.trim() : ''

  try {
    const shareUrl = normalizeShareUrl(rawShareUrl)
    const tmdbMode =
      readTmdbModeValue(readQueryStringParam(req.query.tmdbMode)) ||
      readTmdbModeFromBody(req.body) ||
      'auto'
    const warnings = []
    const scraped = await v2ScrapeListWithFetch(shareUrl, warnings, log, plexToken || undefined)

    if (scraped.nextUrl && scraped.items.length <= scraped.initialCount) {
      pushUniqueWarning(
        warnings,
        'This list appears to have additional pages, but this run only retrieved the first page.',
      )
    }

    const enrichedItems = await enrichItems(scraped.items, warnings, log, {
      tmdbMode,
    })

    return res.json(
      {
        ok: true,
        shareUrl: shareUrl.toString(),
        tmdbMode,
        scrapeMode: scraped.mode,
        total: enrichedItems.length,
        nextUrl: scraped.nextUrl,
        items: enrichedItems,
        warnings,
      },
      200,
      CORS_HEADERS,
    )
  } catch (caughtError) {
    const message =
      caughtError instanceof Error
        ? caughtError.message
        : 'The scraper failed for an unknown reason.'

    error(message)

    return res.json(
      {
        ok: false,
        error: message,
      },
      500,
      CORS_HEADERS,
    )
  }
}
