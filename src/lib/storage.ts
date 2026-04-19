import type { PlexWatchlistItem } from './plex'

export type AppMode = 'shared-list' | 'my-watchlist'

export type PlexSettings = {
  sharedListUrl: string
  plexToken: string
  appMode: AppMode
}

const STORAGE_KEY = 'plex-list-picker.settings.v2'
const SAVED_LISTS_KEY = 'plex-list-picker.saved-lists.v1'
const LIST_CACHE_KEY = 'plex-list-picker.list-cache.v1'
const MAX_SAVED_LISTS = 24
const MAX_CACHED_LISTS = 8

export type SavedListLink = {
  url: string
  name: string
  lastLoadedAt: string
}

export type CachedListData = {
  items: PlexWatchlistItem[]
  warnings: string[]
  cachedAt: string
}

type CachedListEntry = CachedListData & {
  url: string
  lastAccessedAt: string
}

export const defaultSettings: PlexSettings = {
  sharedListUrl: '',
  plexToken: '',
  appMode: 'shared-list',
}

export function loadSettings(): PlexSettings {
  const rawValue = window.localStorage.getItem(STORAGE_KEY)

  if (!rawValue) {
    return defaultSettings
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<PlexSettings>

    return {
      sharedListUrl: parsed.sharedListUrl?.trim() ?? '',
      plexToken: parsed.plexToken?.trim() ?? '',
      appMode: parsed.appMode === 'my-watchlist' ? 'my-watchlist' : 'shared-list',
    }
  } catch {
    return defaultSettings
  }
}

export function saveSettings(settings: PlexSettings) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function loadSavedListLinks(): SavedListLink[] {
  const rawValue = window.localStorage.getItem(SAVED_LISTS_KEY)

  if (!rawValue) {
    return []
  }

  try {
    const parsed = JSON.parse(rawValue)

    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null
        }

        const url = typeof entry.url === 'string' ? entry.url.trim() : ''
        const name = typeof entry.name === 'string' ? entry.name.trim() : ''
        const lastLoadedAt = typeof entry.lastLoadedAt === 'string' ? entry.lastLoadedAt : ''

        if (!url || !name) {
          return null
        }

        return {
          url,
          name,
          lastLoadedAt,
        } satisfies SavedListLink
      })
      .filter((entry): entry is SavedListLink => !!entry)
      .sort((left, right) => right.lastLoadedAt.localeCompare(left.lastLoadedAt))
      .slice(0, MAX_SAVED_LISTS)
  } catch {
    return []
  }
}

function writeSavedListLinks(entries: SavedListLink[]) {
  window.localStorage.setItem(SAVED_LISTS_KEY, JSON.stringify(entries))
}

export function upsertSavedListLink(entry: SavedListLink) {
  const currentEntries = loadSavedListLinks().filter(
    (currentEntry) => currentEntry.url !== entry.url,
  )

  writeSavedListLinks([entry, ...currentEntries].slice(0, MAX_SAVED_LISTS))
}

export function deleteSavedListLink(url: string) {
  if (!url.trim()) {
    return
  }

  const nextEntries = loadSavedListLinks().filter((entry) => entry.url !== url)
  writeSavedListLinks(nextEntries)
}

function readCachedListEntries(): CachedListEntry[] {
  const rawValue = window.localStorage.getItem(LIST_CACHE_KEY)

  if (!rawValue) {
    return []
  }

  try {
    const parsed = JSON.parse(rawValue)

    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null
        }

        const url = typeof entry.url === 'string' ? entry.url.trim() : ''
        const items = Array.isArray(entry.items) ? (entry.items as PlexWatchlistItem[]) : []
        const warnings = Array.isArray(entry.warnings)
          ? entry.warnings.filter((warning: unknown): warning is string => typeof warning === 'string')
          : []
        const cachedAt = typeof entry.cachedAt === 'string' ? entry.cachedAt : ''
        const lastAccessedAt =
          typeof entry.lastAccessedAt === 'string' ? entry.lastAccessedAt : cachedAt

        if (!url || !items.length) {
          return null
        }

        return {
          url,
          items,
          warnings,
          cachedAt,
          lastAccessedAt,
        } satisfies CachedListEntry
      })
      .filter((entry): entry is CachedListEntry => !!entry)
      .sort((left, right) => right.lastAccessedAt.localeCompare(left.lastAccessedAt))
      .slice(0, MAX_CACHED_LISTS)
  } catch {
    return []
  }
}

function writeCachedListEntries(entries: CachedListEntry[]) {
  window.localStorage.setItem(LIST_CACHE_KEY, JSON.stringify(entries.slice(0, MAX_CACHED_LISTS)))
}

export function loadCachedList(url: string): CachedListData | null {
  const normalizedUrl = url.trim()

  if (!normalizedUrl) {
    return null
  }

  const cachedEntries = readCachedListEntries()
  const matchedEntry = cachedEntries.find((entry) => entry.url === normalizedUrl)

  if (!matchedEntry) {
    return null
  }

  const touchedEntry = {
    ...matchedEntry,
    lastAccessedAt: new Date().toISOString(),
  }
  const nextEntries = [
    touchedEntry,
    ...cachedEntries.filter((entry) => entry.url !== normalizedUrl),
  ]
  writeCachedListEntries(nextEntries)

  return {
    items: matchedEntry.items,
    warnings: matchedEntry.warnings,
    cachedAt: matchedEntry.cachedAt,
  }
}

export function upsertCachedList(url: string, data: CachedListData) {
  const normalizedUrl = url.trim()

  if (!normalizedUrl || !data.items.length) {
    return
  }

  const now = new Date().toISOString()
  const nextEntry: CachedListEntry = {
    url: normalizedUrl,
    items: data.items,
    warnings: data.warnings,
    cachedAt: data.cachedAt || now,
    lastAccessedAt: now,
  }
  const currentEntries = readCachedListEntries().filter((entry) => entry.url !== normalizedUrl)
  writeCachedListEntries([nextEntry, ...currentEntries])
}

export function deleteCachedList(url: string) {
  const normalizedUrl = url.trim()

  if (!normalizedUrl) {
    return
  }

  const nextEntries = readCachedListEntries().filter((entry) => entry.url !== normalizedUrl)
  writeCachedListEntries(nextEntries)
}
