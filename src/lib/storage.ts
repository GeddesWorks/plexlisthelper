export type PlexSettings = {
  sharedListUrl: string
}

const STORAGE_KEY = 'plex-list-picker.settings.v2'

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
