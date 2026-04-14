export type PlexSettings = {
  sharedListUrl: string
}

const STORAGE_KEY = 'plex-list-picker.settings.v2'
const SAVED_LISTS_KEY = 'plex-list-picker.saved-lists.v1'
const MAX_SAVED_LISTS = 24

export type SavedListLink = {
  url: string
  name: string
  lastLoadedAt: string
}

export const defaultSettings: PlexSettings = {
  sharedListUrl: '',
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
