import type { PlexSettings } from './storage'

export type PlexMediaType = 'movie' | 'show'
export type ReleaseFilter = 'all' | 'released' | 'upcoming'
export type SortOption =
  | 'list:asc'
  | 'titleSort:asc'
  | 'titleSort:desc'
  | 'originallyAvailableAt:desc'
  | 'originallyAvailableAt:asc'
  | 'rating:desc'
  | 'rating:asc'

export type PlexWatchlistItem = {
  id: string
  ratingKey: string
  guid: string
  type: PlexMediaType
  title: string
  titleSort: string
  year: number | null
  summary: string
  tagline: string
  studio: string
  contentRating: string
  durationMinutes: number | null
  childCount: number | null
  thumb: string
  art: string
  genres: string[]
  rating: number | null
  audienceRating: number | null
  originallyAvailableAt: string
  watchlistedAt: string
}

export type WatchlistFilters = {
  query: string
  type: 'all' | PlexMediaType
  release: ReleaseFilter
  genre: string
  minRating: number
}

const METADATA_BASE_URL = 'https://metadata.provider.plex.tv'
const PUBLIC_LIST_METADATA_BATCH_SIZE = 20

function plexHeaders() {
  return {
    Accept: 'application/xml',
    'X-Plex-Product': 'Plex List Picker',
    'X-Plex-Client-Identifier': 'plex-list-picker-spa',
    'X-Plex-Version': '1.0.0',
    'X-Plex-Platform': 'Web',
    'X-Plex-Platform-Version': window.navigator.userAgent,
  }
}

async function fetchThroughProxy(url: URL, headers: HeadersInit) {
  const proxyUrl = new URL('/api/plex-proxy', window.location.origin)
  proxyUrl.searchParams.set('url', url.toString())

  return fetch(proxyUrl, {
    headers,
  })
}

function isGatewayTimeout(response: Response) {
  return response.status === 524 || response.status === 504
}

function readText(node: Element, attribute: string) {
  return node.getAttribute(attribute)?.trim() ?? ''
}

function readNumber(node: Element, attribute: string) {
  const rawValue = node.getAttribute(attribute)
  if (!rawValue) {
    return null
  }

  const parsed = Number(rawValue)
  return Number.isFinite(parsed) ? parsed : null
}

function readDate(node: Element, attribute: string) {
  const rawValue = node.getAttribute(attribute)?.trim()
  if (!rawValue) {
    return ''
  }

  return Number.isFinite(Number(rawValue))
    ? new Date(Number(rawValue) * 1000).toISOString()
    : rawValue
}

function uniqueGenres(node: Element) {
  return [...node.querySelectorAll('Genre')]
    .map((genreNode) => readText(genreNode, 'tag'))
    .filter(Boolean)
}

function parseWatchlistItem(node: Element): PlexWatchlistItem | null {
  const type = readText(node, 'type')

  if (type !== 'movie' && type !== 'show') {
    return null
  }

  const title = readText(node, 'title')
  const ratingKey = readText(node, 'ratingKey')

  if (!title || !ratingKey) {
    return null
  }

  return {
    id: `${type}-${ratingKey}`,
    ratingKey,
    guid: readText(node, 'guid'),
    type,
    title,
    titleSort: readText(node, 'titleSort') || title,
    year: readNumber(node, 'year'),
    summary: readText(node, 'summary'),
    tagline: readText(node, 'tagline'),
    studio: readText(node, 'studio'),
    contentRating: readText(node, 'contentRating'),
    durationMinutes: (() => {
      const duration = readNumber(node, 'duration')
      return duration ? Math.round(duration / 60000) : null
    })(),
    childCount:
      readNumber(node, 'childCount') ??
      readNumber(node, 'leafCount') ??
      readNumber(node, 'viewedLeafCount'),
    thumb: readText(node, 'thumb'),
    art: readText(node, 'art'),
    genres: uniqueGenres(node),
    rating: readNumber(node, 'rating'),
    audienceRating: readNumber(node, 'audienceRating'),
    originallyAvailableAt: readDate(node, 'originallyAvailableAt'),
    watchlistedAt: readDate(node, 'watchlistedAt'),
  }
}

function itemElements(document: Document) {
  return [...document.querySelectorAll('Video, Directory, Metadata')]
}

function buildSharedListUrl(settings: PlexSettings) {
  const sharedListUrl = settings.sharedListUrl.trim()

  if (!sharedListUrl) {
    throw new Error('Paste a public Plex share link to load a list.')
  }

  if (/^https?:\/\//i.test(sharedListUrl)) {
    return new URL(sharedListUrl)
  }

  return new URL(`https://${sharedListUrl}`)
}

function parseItemsResponse(responseText: string) {
  const trimmed = responseText.trim()

  if (!trimmed) {
    return []
  }

  if (trimmed.startsWith('{')) {
    const parsedJson = JSON.parse(trimmed) as {
      MediaContainer?: { Metadata?: unknown[] }
    }
    const metadataItems = parsedJson.MediaContainer?.Metadata

    if (!Array.isArray(metadataItems)) {
      return []
    }

    return metadataItems
      .map((item) => {
        const fakeNode = new DOMParser()
          .parseFromString(
            `<MediaContainer>${jsonItemToXml(item as Record<string, unknown>)}</MediaContainer>`,
            'application/xml',
          )
          .querySelector('Video, Directory, Metadata')

        return fakeNode ? parseWatchlistItem(fakeNode) : null
      })
      .filter((item): item is PlexWatchlistItem => item !== null)
  }

  if (trimmed.startsWith('<!DOCTYPE html') || trimmed.startsWith('<html')) {
    return parsePublicListHtml(trimmed).items
  }

  const parsed = new DOMParser().parseFromString(trimmed, 'application/xml')
  const parserError = parsed.querySelector('parsererror')

  if (parserError) {
    throw new Error('Plex returned a response that could not be parsed.')
  }

  return itemElements(parsed)
    .map(parseWatchlistItem)
    .filter((item): item is PlexWatchlistItem => item !== null)
}

function jsonItemToXml(item: Record<string, unknown>) {
  const type = typeof item.type === 'string' && item.type === 'show' ? 'Directory' : 'Video'
  const attrs = Object.entries(item)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => `${key}="${String(value).replaceAll('"', '&quot;')}"`)
    .join(' ')
  const genres = Array.isArray(item.Genre)
    ? item.Genre.map((genre) => {
        const tag = typeof genre === 'object' && genre && 'tag' in genre ? String(genre.tag) : ''
        return tag ? `<Genre tag="${tag.replaceAll('"', '&quot;')}" />` : ''
      }).join('')
    : ''

  return `<${type} ${attrs}>${genres}</${type}>`
}

type PublicListResponse = {
  items: PlexWatchlistItem[]
  nextUrl: string
}

function parsePublicListHtml(html: string) {
  const decodedFlightStream = decodeNextFlightStream(html)
  const searchableText = decodedFlightStream || html
  return parsePublicListResponseText(searchableText)
}

function parsePublicListResponseText(text: string): PublicListResponse {
  const markerCandidates = ['"list":[', '\\"list\\":[']
  const matchedMarker = markerCandidates.find((marker) => text.includes(marker)) ?? ''

  if (!matchedMarker) {
    throw new Error(
      'The shared Plex list page loaded, but the embedded list data block was not found. Expected a plain or escaped list marker.',
    )
  }

  const listMarkerIndex = text.indexOf(matchedMarker)
  const arrayStartIndex = listMarkerIndex + matchedMarker.length - 1
  const arrayText = extractJsonArray(text, arrayStartIndex)

  if (!arrayText) {
    throw new Error(
      `The shared Plex list page loaded, but the embedded list JSON could not be isolated after marker ${matchedMarker}.`,
    )
  }

  let parsedItems: Array<{
    id?: string
    image?: { url?: string }
    title?: string
    subtitle?: string
    link?: { url?: string }
  }>

  try {
    const normalizedArrayText =
      matchedMarker.startsWith('\\"') ? arrayText.replace(/\\"/g, '"') : arrayText
    parsedItems = JSON.parse(normalizedArrayText) as Array<{
      id?: string
      image?: { url?: string }
      title?: string
      subtitle?: string
      link?: { url?: string }
    }>
  } catch {
    throw new Error(
      `The shared Plex list page loaded, but the embedded list JSON was not parseable after matching ${matchedMarker}.`,
    )
  }

  const items = parsedItems.map(mapPublicListItem).filter((item): item is PlexWatchlistItem => item !== null)

  if (!items.length) {
    throw new Error(
      `The shared Plex list page loaded, but no usable items were found in the embedded list data (${parsedItems.length} raw entries).`,
    )
  }

  const nextUrl = readNextPageUrl(text, matchedMarker.startsWith('\\"'))

  return { items, nextUrl }
}

function mapPublicListItem(item: {
  id?: string
  image?: { url?: string }
  title?: string
  subtitle?: string
  link?: { url?: string }
}): PlexWatchlistItem | null {
  const itemPath = item.link?.url ?? ''
  const title = item.title ?? ''
  const id = item.id ?? ''

  if (!id || !title || !/^\/(?:movie|show)\//.test(itemPath)) {
    return null
  }

  const year = Number(item.subtitle ?? '')
  const type: PlexMediaType = itemPath.startsWith('/show/') ? 'show' : 'movie'

  return {
    id: `${type}-${id}`,
    ratingKey: id,
    guid: itemPath,
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
    thumb: item.image?.url ?? '',
    art: item.image?.url ?? '',
    genres: [],
    rating: null,
    audienceRating: null,
    originallyAvailableAt: Number.isFinite(year) ? `${year}-01-01` : '',
    watchlistedAt: '',
  }
}

function readNextPageUrl(text: string, isEscaped: boolean) {
  const match = isEscaped
    ? text.match(/\\"nextUrl\\":\\"([\s\S]*?)\\"/)
    : text.match(/"nextUrl":"([\s\S]*?)"/)

  if (!match) {
    return ''
  }

  const rawValue = match[1]
  return isEscaped ? rawValue.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : rawValue
}

function decodeNextFlightStream(html: string) {
  const chunkPattern = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g
  const chunks = [...html.matchAll(chunkPattern)].map((match) => match[1])

  if (!chunks.length) {
    return ''
  }

  return chunks
    .map((chunk) => {
      try {
        return JSON.parse(`"${chunk}"`) as string
      } catch {
        return chunk
      }
    })
    .join('')
}

function extractJsonArray(text: string, startIndex: number) {
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

export async function fetchSharedList(settings: PlexSettings) {
  const initialUrl = buildSharedListUrl(settings)
  const itemsById = new Map<string, PlexWatchlistItem>()
  let nextUrl = initialUrl.toString()
  let isFirstPage = true

  while (nextUrl) {
    const response = await fetchThroughProxy(new URL(nextUrl), plexHeaders())

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          'The Plex proxy could not access list pagination. Set PLEX_TOKEN on the server that hosts /api/plex-proxy.',
        )
      }

      if (itemsById.size > 0 && isGatewayTimeout(response)) {
        break
      }

      throw new Error(
        `Plex custom list request failed with ${response.status} ${response.statusText}.`,
      )
    }

    const bodyText = await response.text()
    const page = isFirstPage
      ? parsePublicListHtml(bodyText)
      : parsePublicListFragment(bodyText)

    for (const item of page.items) {
      itemsById.set(item.id, item)
    }

    nextUrl = page.nextUrl
    isFirstPage = false
  }

  return enrichPublicListItems([...itemsById.values()])
}

function parsePublicListFragment(bodyText: string) {
  const trimmed = bodyText.trim()

  if (!trimmed.startsWith('{')) {
    throw new Error('The Plex custom list fragment returned an unexpected response format.')
  }

  const parsed = JSON.parse(trimmed) as {
    content?: Array<{
      id?: string
      image?: { url?: string }
      title?: string
      subtitle?: string
      link?: { url?: string }
    }>
    pagination?: { nextUrl?: string }
  }

  const items = Array.isArray(parsed.content)
    ? parsed.content.map(mapPublicListItem).filter((item): item is PlexWatchlistItem => item !== null)
    : []

  if (!items.length) {
    throw new Error('The Plex custom list fragment loaded, but did not contain any usable items.')
  }

  return {
    items,
    nextUrl: parsed.pagination?.nextUrl ?? '',
  }
}

async function enrichPublicListItems(items: PlexWatchlistItem[]) {
  if (!items.length) {
    return items
  }

  const enrichedItems = new Map(items.map((item) => [item.ratingKey, item]))

  for (let index = 0; index < items.length; index += PUBLIC_LIST_METADATA_BATCH_SIZE) {
    const batch = items.slice(index, index + PUBLIC_LIST_METADATA_BATCH_SIZE)
    const batchIds = batch.map((item) => item.ratingKey).filter(Boolean)

    if (!batchIds.length) {
      continue
    }

    const metadataUrl = new URL(`${METADATA_BASE_URL}/library/metadata/${batchIds.join(',')}`)
    const response = await fetchThroughProxy(metadataUrl, plexHeaders())

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          'The Plex proxy could not access metadata enrichment. Set PLEX_TOKEN on the server that hosts /api/plex-proxy.',
        )
      }

      if (isGatewayTimeout(response)) {
        continue
      }

      throw new Error(
        `Plex metadata request failed with ${response.status} ${response.statusText}.`,
      )
    }

    const bodyText = await response.text()
    const parsedItems = parseItemsResponse(bodyText)

    for (const parsedItem of parsedItems) {
      const currentItem = enrichedItems.get(parsedItem.ratingKey)

      if (!currentItem) {
        continue
      }

      enrichedItems.set(parsedItem.ratingKey, {
        ...currentItem,
        ...parsedItem,
        id: currentItem.id,
      })
    }
  }

  return items.map((item) => enrichedItems.get(item.ratingKey) ?? item)
}

export function buildArtworkUrl(path: string) {
  if (!path) {
    return ''
  }

  if (/^https?:\/\//i.test(path)) {
    return path
  }

  const url = new URL('/api/plex-proxy', window.location.origin)
  url.searchParams.set('url', `${METADATA_BASE_URL}${path}`)
  return url.toString()
}

export function isReleased(item: PlexWatchlistItem) {
  if (!item.originallyAvailableAt) {
    return true
  }

  return new Date(item.originallyAvailableAt).getTime() <= Date.now()
}

export function filterItems(items: PlexWatchlistItem[], filters: WatchlistFilters) {
  const normalizedQuery = filters.query.trim().toLowerCase()

  return items.filter((item) => {
    if (filters.type !== 'all' && item.type !== filters.type) {
      return false
    }

    if (filters.release === 'released' && !isReleased(item)) {
      return false
    }

    if (filters.release === 'upcoming' && isReleased(item)) {
      return false
    }

    if (filters.genre !== 'all' && !item.genres.includes(filters.genre)) {
      return false
    }

    if (filters.minRating > 0 && (item.rating ?? 0) < filters.minRating) {
      return false
    }

    if (!normalizedQuery) {
      return true
    }

    const haystack = [
      item.title,
      item.summary,
      item.studio,
      item.contentRating,
      ...item.genres,
      item.year?.toString() ?? '',
    ]
      .join(' ')
      .toLowerCase()

    return haystack.includes(normalizedQuery)
  })
}

export function sortItems(items: PlexWatchlistItem[], sort: SortOption) {
  const sortedItems = [...items]

  sortedItems.sort((left, right) => {
    switch (sort) {
      case 'titleSort:asc':
        return left.titleSort.localeCompare(right.titleSort)
      case 'titleSort:desc':
        return right.titleSort.localeCompare(left.titleSort)
      case 'originallyAvailableAt:desc':
        return compareDates(right.originallyAvailableAt, left.originallyAvailableAt)
      case 'originallyAvailableAt:asc':
        return compareDates(left.originallyAvailableAt, right.originallyAvailableAt)
      case 'rating:desc':
        return (right.rating ?? -1) - (left.rating ?? -1)
      case 'rating:asc':
        return (left.rating ?? Number.POSITIVE_INFINITY) - (right.rating ?? Number.POSITIVE_INFINITY)
      case 'list:asc':
      default:
        return 0
    }
  })

  return sortedItems
}

function compareDates(left: string, right: string) {
  const leftValue = left ? new Date(left).getTime() : Number.NaN
  const rightValue = right ? new Date(right).getTime() : Number.NaN

  if (Number.isNaN(leftValue) && Number.isNaN(rightValue)) {
    return 0
  }

  if (Number.isNaN(leftValue)) {
    return 1
  }

  if (Number.isNaN(rightValue)) {
    return -1
  }

  return leftValue - rightValue
}

export function pickRandomItem(items: PlexWatchlistItem[]) {
  if (!items.length) {
    return null
  }

  const randomIndex = Math.floor(Math.random() * items.length)
  return items[randomIndex]
}
