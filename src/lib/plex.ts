import { Client, ExecutionMethod, Functions } from 'appwrite'
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
  ratingSource?: 'plex' | 'tmdb' | ''
  audienceRatingSource?: 'plex' | 'tmdb' | ''
  imageSource?: 'plex' | 'tmdb' | ''
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

export type SharedListResult = {
  items: PlexWatchlistItem[]
  warnings: string[]
}

export type TmdbMode = 'auto' | 'none'

const METADATA_BASE_URL = 'https://metadata.provider.plex.tv'
const DEFAULT_APPWRITE_ENDPOINT = 'https://sfo.cloud.appwrite.io/v1'
const DEFAULT_APPWRITE_PROJECT_ID = '69876eae003275d80ff8'
const DEFAULT_APPWRITE_FUNCTION_ID = 'plexlists_scraper'

const APPWRITE_ENDPOINT = (
  import.meta.env.VITE_APPWRITE_ENDPOINT?.trim() || DEFAULT_APPWRITE_ENDPOINT
).replace(/\/+$/, '')
const APPWRITE_PROJECT_ID =
  import.meta.env.VITE_APPWRITE_PROJECT_ID?.trim() || DEFAULT_APPWRITE_PROJECT_ID
const APPWRITE_FUNCTION_ID =
  import.meta.env.VITE_APPWRITE_FUNCTION_ID?.trim() || DEFAULT_APPWRITE_FUNCTION_ID

const appwriteClient = new Client()
  .setEndpoint(APPWRITE_ENDPOINT)
  .setProject(APPWRITE_PROJECT_ID)

const appwriteFunctions = new Functions(appwriteClient)

type AppwriteExecution = {
  status?: string
  responseStatusCode?: number
  responseBody?: string
  errors?: string
}

type ScraperPayload = {
  ok?: boolean
  items?: PlexWatchlistItem[]
  warnings?: string[]
  error?: string
}

function buildSharedListUrl(settings: PlexSettings) {
  const sharedListUrl = settings.sharedListUrl.trim()

  if (!sharedListUrl) {
    throw new Error('Paste a public Plex share link to load a list.')
  }

  const nextUrl = /^https?:\/\//i.test(sharedListUrl)
    ? new URL(sharedListUrl)
    : new URL(`https://${sharedListUrl}`)

  if (nextUrl.hostname !== 'watch.plex.tv') {
    throw new Error('Use a public watch.plex.tv share link.')
  }

  return nextUrl
}

type ScraperExecutionRequest = {
  body: Record<string, unknown>
  xpath?: string
}

async function requestScraperExecution({ body, xpath }: ScraperExecutionRequest) {
  try {
    return (await appwriteFunctions.createExecution({
      functionId: APPWRITE_FUNCTION_ID,
      async: false,
      body: JSON.stringify(body),
      method: ExecutionMethod.POST,
      xpath,
      headers: {
        'content-type': 'application/json',
      },
    })) as AppwriteExecution
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Appwrite error.'

    if (!/Failed to fetch/i.test(message)) {
      throw new Error(`Appwrite execution request failed. ${message}`)
    }

    throw new Error(
      'The Appwrite scraper could not be reached. If this site is on a new domain, add it as a Web platform in the quote dump Appwrite project.',
    )
  }
}

export function normalizeWarnings(warnings: string[]) {
  const nextWarnings = new Set<string>()

  for (const warning of warnings) {
    if (
      warning.startsWith('Metadata lookup failed') ||
      warning.startsWith('Metadata lookup threw') ||
      warning.startsWith('Metadata for ') ||
      warning.startsWith('Some ratings were filled from TMDB') ||
      warning.startsWith('Some posters or backdrops were filled from TMDB')
    ) {
      continue
    }

    nextWarnings.add(warning)
  }

  return [...nextWarnings]
}

function parseScraperExecution(execution: AppwriteExecution): SharedListResult {
  if (execution.errors) {
    throw new Error(execution.errors)
  }

  if (typeof execution.responseStatusCode !== 'number') {
    throw new Error('Appwrite returned an execution without an HTTP status.')
  }

  const rawBody = execution.responseBody?.trim() ?? ''

  if (!rawBody) {
    throw new Error(
      `Appwrite scraper returned ${execution.responseStatusCode} without a response body.`,
    )
  }

  let payload: ScraperPayload

  try {
    payload = JSON.parse(rawBody) as ScraperPayload
  } catch {
    throw new Error('Appwrite scraper returned a non-JSON response body.')
  }

  if (execution.responseStatusCode >= 400 || payload.ok === false) {
    throw new Error(
      payload.error ?? `Appwrite scraper returned ${execution.responseStatusCode}.`,
    )
  }

  if (!Array.isArray(payload.items)) {
    throw new Error('Appwrite scraper returned an unexpected item payload.')
  }

  return {
    items: payload.items,
    warnings: normalizeWarnings(payload.warnings ?? []),
  }
}

export async function fetchSharedList(settings: PlexSettings): Promise<SharedListResult> {
  const shareUrl = buildSharedListUrl(settings)
  const execution = await requestScraperExecution({
    body: {
      url: shareUrl.toString(),
      tmdbMode: 'auto',
    },
  })
  return parseScraperExecution(execution)
}

export async function fetchSharedListFast(
  settings: PlexSettings,
  tmdbMode: TmdbMode = 'none',
): Promise<SharedListResult> {
  const shareUrl = buildSharedListUrl(settings)
  const execution = await requestScraperExecution({
    body: {
      url: shareUrl.toString(),
      tmdbMode,
    },
  })
  return parseScraperExecution(execution)
}

export async function fetchTmdbEnrichment(items: PlexWatchlistItem[]): Promise<SharedListResult> {
  if (!items.length) {
    return {
      items: [],
      warnings: [],
    }
  }

  const execution = await requestScraperExecution({
    xpath: '/tmdb-enrich',
    body: {
      items,
    },
  })

  return parseScraperExecution(execution)
}

export async function fetchMyWatchlist(plexToken: string): Promise<SharedListResult> {
  const execution = await requestScraperExecution({
    xpath: '/watchlist',
    body: { plexToken },
  })
  return parseScraperExecution(execution)
}

const PLEX_OAUTH_CLIENT_ID = 'plex-list-picker-web'
const PLEX_OAUTH_PRODUCT = 'Plex List Picker'

const plexOAuthHeaders = {
  Accept: 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded',
  'X-Plex-Product': PLEX_OAUTH_PRODUCT,
  'X-Plex-Client-Identifier': PLEX_OAUTH_CLIENT_ID,
  'X-Plex-Version': '1.0.0',
}

export type PlexOAuthPin = {
  id: number
  code: string
  authUrl: string
}

export async function startPlexOAuth(): Promise<PlexOAuthPin> {
  const response = await fetch('https://plex.tv/api/v2/pins', {
    method: 'POST',
    headers: plexOAuthHeaders,
    body: new URLSearchParams({ strong: 'true' }),
  })

  if (!response.ok) {
    throw new Error('Failed to initiate Plex sign-in. Please try again.')
  }

  const data = (await response.json()) as { id: number; code: string }
  const authUrl =
    `https://app.plex.tv/auth/#?clientID=${PLEX_OAUTH_CLIENT_ID}` +
    `&code=${data.code}` +
    `&context[device][product]=${encodeURIComponent(PLEX_OAUTH_PRODUCT)}`

  return { id: data.id, code: data.code, authUrl }
}

export async function pollPlexOAuthToken(pinId: number): Promise<string | null> {
  const response = await fetch(`https://plex.tv/api/v2/pins/${pinId}`, {
    headers: {
      Accept: 'application/json',
      'X-Plex-Client-Identifier': PLEX_OAUTH_CLIENT_ID,
    },
  })

  if (!response.ok) {
    return null
  }

  const data = (await response.json()) as { authToken?: string | null }
  return data.authToken ?? null
}

export function buildArtworkUrl(path: string) {
  if (!path) {
    return ''
  }

  if (/^https?:\/\//i.test(path)) {
    return path
  }

  return new URL(path, METADATA_BASE_URL).toString()
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
