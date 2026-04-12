const METADATA_BASE_URL = 'https://metadata.provider.plex.tv'
const WATCH_BASE_URL = 'https://watch.plex.tv'
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

function decodeHtmlEntities(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

function normalizeShareUrl(rawValue) {
  const trimmedValue = rawValue?.trim()

  if (!trimmedValue) {
    throw new Error('Missing share URL.')
  }

  const nextUrl = /^https?:\/\//i.test(trimmedValue)
    ? new URL(trimmedValue)
    : new URL(`https://${trimmedValue}`)

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
  }
}

async function enrichItems(items, warnings, log) {
  const enrichedItems = []

  for (const item of items) {
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
    } catch (error) {
      log(`Metadata lookup failed for ${item.title}: ${error instanceof Error ? error.message : String(error)}`)
      warnings.push(`Metadata lookup threw for ${item.title}.`)
      enrichedItems.push(item)
    }
  }

  return enrichedItems
}

function readShareUrlFromBody(body) {
  if (!body) {
    return ''
  }

  if (typeof body === 'string') {
    const trimmedBody = body.trim()

    if (!trimmedBody) {
      return ''
    }

    try {
      return readShareUrlFromBody(JSON.parse(trimmedBody))
    } catch {
      return trimmedBody
    }
  }

  if (typeof body !== 'object') {
    return ''
  }

  if (typeof body.url === 'string') {
    return body.url
  }

  if (typeof body.shareUrl === 'string') {
    return body.shareUrl
  }

  if (typeof body.sharedListUrl === 'string') {
    return body.sharedListUrl
  }

  return ''
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
    const shareResponse = await fetch(shareUrl, {
      headers: {
        'user-agent': 'plexlists-appwrite-scraper',
      },
    })

    if (!shareResponse.ok) {
      return res.json(
        {
          ok: false,
          error: `Share page request failed with ${shareResponse.status}.`,
        },
        502,
        CORS_HEADERS,
      )
    }

    const { items, nextUrl } = parsePublicListHtml(await shareResponse.text())
    const warnings = []
    const enrichedItems = await enrichItems(items, warnings, log)

    if (nextUrl) {
      warnings.push(
        'The public share page exposes additional pagination, but the anonymous nextUrl currently requires Plex auth. This function returns the first public page only.',
      )
    }

    return res.json(
      {
        ok: true,
        shareUrl: shareUrl.toString(),
        total: enrichedItems.length,
        nextUrl,
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
