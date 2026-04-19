import { startTransition, useEffect, useRef, useState } from 'react'
import './App.css'
import tmdbLogo from './assets/tmdb-logo.svg'
import {
  buildArtworkUrl,
  fetchMyWatchlist,
  fetchSharedListFast,
  fetchTmdbEnrichment,
  filterItems,
  isReleased,
  normalizeWarnings,
  pickRandomItem,
  pollPlexOAuthToken,
  sortItems,
  startPlexOAuth,
  type PlexOAuthPin,
  type PlexWatchlistItem,
  type SortOption,
  type WatchlistFilters,
} from './lib/plex'
import {
  deleteCachedList,
  deleteSavedListLink,
  defaultSettings,
  loadCachedList,
  loadSettings,
  loadSavedListLinks,
  saveSettings,
  upsertCachedList,
  upsertSavedListLink,
  type AppMode,
  type CachedListData,
  type PlexSettings,
  type SavedListLink,
} from './lib/storage'

const DEFAULT_FILTERS: WatchlistFilters = {
  query: '',
  type: 'all',
  release: 'all',
  genre: 'all',
  minRating: 0,
}

const SORT_OPTIONS: Array<{ value: SortOption; label: string }> = [
  { value: 'list:asc', label: 'Default order' },
  { value: 'titleSort:asc', label: 'Title A-Z' },
  { value: 'titleSort:desc', label: 'Title Z-A' },
  { value: 'originallyAvailableAt:desc', label: 'Newest release' },
  { value: 'originallyAvailableAt:asc', label: 'Oldest release' },
  { value: 'rating:desc', label: 'Highest critic rating' },
  { value: 'rating:asc', label: 'Lowest critic rating' },
]

const INITIAL_PRIORITY_COUNT = 24
const ENRICHMENT_BATCH_SIZE = 20
const CACHE_FRESH_WINDOW_MS = 1000 * 60 * 60 * 8

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

function formatDate(value: string) {
  if (!value) {
    return 'Unknown'
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date)
}

function formatDuration(minutes: number | null, type: PlexWatchlistItem['type'], childCount: number | null) {
  if (type === 'show') {
    if (!childCount) {
      return 'Series'
    }

    return `${childCount} ${childCount === 1 ? 'episode' : 'episodes'}`
  }

  if (!minutes) {
    return 'Runtime unknown'
  }

  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60

  if (!hours) {
    return `${minutes} min`
  }

  return remainder ? `${hours}h ${remainder}m` : `${hours}h`
}

function ratingLabel(value: number | null) {
  return value ? `${value.toFixed(1)}/10` : 'No score'
}

function ratingSourceLabel(
  source: PlexWatchlistItem['ratingSource'] | PlexWatchlistItem['audienceRatingSource'] | undefined,
  fallback: string,
) {
  return source === 'tmdb' ? 'TMDB' : fallback
}

function dedupeWarnings(nextWarnings: string[]) {
  return [...new Set(nextWarnings)]
}

function mergeItemsById(
  currentItems: PlexWatchlistItem[],
  incomingItems: PlexWatchlistItem[],
) {
  const incomingMap = new Map(incomingItems.map((item) => [item.id, item]))
  return currentItems.map((item) => incomingMap.get(item.id) ?? item)
}

function isListEnriched(items: PlexWatchlistItem[]) {
  return items.some(
    (item) =>
      item.ratingSource === 'tmdb' ||
      item.audienceRatingSource === 'tmdb' ||
      item.imageSource === 'tmdb',
  )
}

function buildPriorityOrder(
  items: PlexWatchlistItem[],
  filters: WatchlistFilters,
  sort: SortOption,
) {
  const visibleIds = new Set(sortItems(filterItems(items, filters), sort).map((item) => item.id))
  const visibleItems = items
    .filter((item) => visibleIds.has(item.id))
    .slice(0, INITIAL_PRIORITY_COUNT)
  const visibleItemIds = new Set(visibleItems.map((item) => item.id))
  const backgroundItems = items.filter((item) => !visibleItemIds.has(item.id))

  return [...visibleItems, ...backgroundItems]
}

function chunkItems(items: PlexWatchlistItem[], chunkSize: number) {
  const chunks: PlexWatchlistItem[][] = []

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize))
  }

  return chunks
}

function deriveListName(shareUrl: string) {
  try {
    const parsedUrl = /^https?:\/\//i.test(shareUrl)
      ? new URL(shareUrl)
      : new URL(`https://${shareUrl}`)
    const segments = parsedUrl.pathname.split('/').filter(Boolean)
    const slug = segments.at(-1) ?? ''

    if (!slug) {
      return 'Saved Plex list'
    }

    return slug
      .replaceAll('-', ' ')
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase())
  } catch {
    return 'Saved Plex list'
  }
}

function isCacheFresh(cachedAt: string) {
  const cachedTimestamp = new Date(cachedAt).getTime()

  if (Number.isNaN(cachedTimestamp)) {
    return false
  }

  return Date.now() - cachedTimestamp <= CACHE_FRESH_WINDOW_MS
}

function App() {
  const [settings, setSettings] = useState<PlexSettings>(defaultSettings)
  const [draftSettings, setDraftSettings] = useState<PlexSettings>(defaultSettings)
  const [filters, setFilters] = useState<WatchlistFilters>(DEFAULT_FILTERS)
  const [sort, setSort] = useState<SortOption>('list:asc')
  const [items, setItems] = useState<PlexWatchlistItem[]>([])
  const [selectedItem, setSelectedItem] = useState<PlexWatchlistItem | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [lastUpdated, setLastUpdated] = useState('')
  const [showingCachedData, setShowingCachedData] = useState(false)
  const [savedListLinks, setSavedListLinks] = useState<SavedListLink[]>([])
  const [tmdbProgress, setTmdbProgress] = useState({
    active: false,
    processed: 0,
    total: 0,
  })
  const [oauthPending, setOauthPending] = useState<PlexOAuthPin | null>(null)
  const oauthPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const filtersRef = useRef(filters)
  const sortRef = useRef(sort)
  const forceRefreshRef = useRef(false)

  useEffect(() => {
    const storedSettings = loadSettings()
    setSettings(storedSettings)
    setDraftSettings(storedSettings)
    setSavedListLinks(loadSavedListLinks())

    return () => {
      if (oauthPollRef.current) {
        clearInterval(oauthPollRef.current)
      }
    }
  }, [])

  useEffect(() => {
    filtersRef.current = filters
  }, [filters])

  useEffect(() => {
    sortRef.current = sort
  }, [sort])

  useEffect(() => {
    let isCancelled = false

    const isMyWatchlistMode = settings.appMode === 'my-watchlist'
    const hasSource = isMyWatchlistMode ? !!settings.plexToken : !!settings.sharedListUrl

    if (!hasSource) {
      setItems([])
      setSelectedItem(null)
      setWarnings([])
      setLastUpdated('')
      setShowingCachedData(false)
      setTmdbProgress({ active: false, processed: 0, total: 0 })
      setError(
        isMyWatchlistMode
          ? 'Enter your Plex token or sign in with Plex to load your watchlist.'
          : 'Paste a public Plex share link to load a list.',
      )
      return () => {
        isCancelled = true
      }
    }

    const runEnrichment = async (args: {
      normalizedShareUrl: string
      startingItems: PlexWatchlistItem[]
      freshWarnings: string[]
      freshLoadedAt: string
      getIsCancelled: () => boolean
    }) => {
      const { normalizedShareUrl, startingItems, freshWarnings, freshLoadedAt, getIsCancelled } =
        args

      const prioritizedItems = buildPriorityOrder(
        startingItems,
        filtersRef.current,
        sortRef.current,
      )
      const batches = chunkItems(prioritizedItems, ENRICHMENT_BATCH_SIZE)

      if (!batches.length) {
        return
      }

      setTmdbProgress({
        active: true,
        processed: 0,
        total: prioritizedItems.length,
      })

      let processedCount = 0
      let cachedItems = startingItems

      for (const batch of batches) {
        if (getIsCancelled()) {
          return
        }

        try {
          const enrichmentResult = await fetchTmdbEnrichment(batch)

          if (getIsCancelled()) {
            return
          }

          processedCount = Math.min(prioritizedItems.length, processedCount + batch.length)
          cachedItems = mergeItemsById(cachedItems, enrichmentResult.items)

          if (normalizedShareUrl) {
            upsertCachedList(normalizedShareUrl, {
              items: cachedItems,
              warnings: freshWarnings,
              cachedAt: freshLoadedAt,
            } satisfies CachedListData)
          }

          startTransition(() => {
            setItems((currentItems) => mergeItemsById(currentItems, enrichmentResult.items))
            setSelectedItem((currentSelection) => {
              if (!currentSelection) {
                return null
              }

              return (
                enrichmentResult.items.find((item) => item.id === currentSelection.id) ??
                currentSelection
              )
            })

            if (enrichmentResult.warnings.length) {
              setWarnings((currentWarnings) =>
                dedupeWarnings([...currentWarnings, ...enrichmentResult.warnings]),
              )
            }
          })
        } catch {
          processedCount = Math.min(prioritizedItems.length, processedCount + batch.length)
          setWarnings((currentWarnings) =>
            dedupeWarnings([
              ...currentWarnings,
              'TMDB enrichment was partially skipped because one background request failed.',
            ]),
          )
        } finally {
          if (!getIsCancelled()) {
            setTmdbProgress({
              active: processedCount < prioritizedItems.length,
              processed: processedCount,
              total: prioritizedItems.length,
            })
          }
        }
      }
    }

    const loadWatchlist = async () => {
      const normalizedShareUrl = isMyWatchlistMode
        ? 'plex://my-watchlist'
        : settings.sharedListUrl.trim()
      const forceRefresh = forceRefreshRef.current
      forceRefreshRef.current = false
      const cachedList = loadCachedList(normalizedShareUrl)
      const shouldSkipRemoteRefresh =
        !!cachedList && !forceRefresh && isCacheFresh(cachedList.cachedAt)

      setLoading(!cachedList || forceRefresh)
      setError('')
      setShowingCachedData(!!cachedList)
      setTmdbProgress({
        active: false,
        processed: 0,
        total: 0,
      })

      if (cachedList) {
        startTransition(() => {
          setItems(cachedList.items)
          setWarnings(dedupeWarnings(normalizeWarnings(cachedList.warnings)))
          setSelectedItem((currentSelection) => {
            if (!currentSelection) {
              return null
            }

            return cachedList.items.find((item) => item.id === currentSelection.id) ?? null
          })
          setLastUpdated(cachedList.cachedAt)
        })
      }

      if (shouldSkipRemoteRefresh && cachedList) {
        setWarnings(
          dedupeWarnings([
            ...normalizeWarnings(cachedList.warnings),
            'Using cached list data from this browser. Press "Load list" to refresh from Plex now.',
          ]),
        )
        setLoading(false)

        if (isListEnriched(cachedList.items)) {
          return
        }

        await runEnrichment({
          normalizedShareUrl,
          startingItems: cachedList.items,
          freshWarnings: dedupeWarnings(normalizeWarnings(cachedList.warnings)),
          freshLoadedAt: cachedList.cachedAt,
          getIsCancelled: () => isCancelled,
        })
        return
      }

      try {
        const nextResult = isMyWatchlistMode
          ? await fetchMyWatchlist(settings.plexToken)
          : await fetchSharedListFast(settings, 'none')

        if (isCancelled) {
          return
        }

        const nextItems = nextResult.items
        const freshWarnings = dedupeWarnings(nextResult.warnings)
        const freshLoadedAt = new Date().toISOString()

        startTransition(() => {
          setItems(nextItems)
          setWarnings(freshWarnings)
          setSelectedItem((currentSelection) => {
            if (!currentSelection) {
              return null
            }

            return nextItems.find((item) => item.id === currentSelection.id) ?? null
          })
          setLastUpdated(freshLoadedAt)
        })
        setShowingCachedData(false)

        if (normalizedShareUrl) {
          if (!isMyWatchlistMode) {
            upsertSavedListLink({
              url: normalizedShareUrl,
              name: deriveListName(normalizedShareUrl),
              lastLoadedAt: freshLoadedAt,
            })
            setSavedListLinks(loadSavedListLinks())
          }
          upsertCachedList(normalizedShareUrl, {
            items: nextItems,
            warnings: freshWarnings,
            cachedAt: freshLoadedAt,
          } satisfies CachedListData)
        }

        if (!isCancelled) {
          setLoading(false)
        }

        await runEnrichment({
          normalizedShareUrl,
          startingItems: nextItems,
          freshWarnings,
          freshLoadedAt,
          getIsCancelled: () => isCancelled,
        })
      } catch (caughtError) {
        if (cachedList?.items.length) {
          setWarnings((currentWarnings) =>
            dedupeWarnings([
              ...currentWarnings,
              'Live refresh failed. Showing locally cached list data from this browser.',
            ]),
          )
          setError('')
          setShowingCachedData(true)
        } else {
          setWarnings([])
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : 'The shared Plex list request failed for an unknown reason.',
          )
        }

        setTmdbProgress({
          active: false,
          processed: 0,
          total: 0,
        })
      } finally {
        if (!isCancelled) {
          setLoading(false)
        }
      }
    }

    void loadWatchlist()

    return () => {
      isCancelled = true
    }
  }, [settings])

  const filteredItems = sortItems(filterItems(items, filters), sort)
  const availableGenres = [...new Set(items.flatMap((item) => item.genres))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
  const showInitialLoading = loading && !items.length && !error
  const showEnrichmentLoading = tmdbProgress.active && !showInitialLoading && !error
  const enrichmentPercent =
    tmdbProgress.total > 0 ? Math.round((tmdbProgress.processed / tmdbProgress.total) * 100) : 0

  useEffect(() => {
    if (!selectedItem) {
      return
    }

    const stillVisible = filteredItems.some((item) => item.id === selectedItem.id)

    if (!stillVisible) {
      setSelectedItem(null)
    }
  }, [filteredItems, selectedItem])

  const releasedCount = items.filter((item) => isReleased(item)).length

  const handleSettingChange = (key: keyof PlexSettings, value: string) => {
    setDraftSettings((current) => ({ ...current, [key]: value }))
  }

  const handleSaveSettings = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const nextSettings: PlexSettings = {
      ...draftSettings,
      sharedListUrl: draftSettings.sharedListUrl.trim(),
      plexToken: draftSettings.plexToken.trim(),
    }

    forceRefreshRef.current = true
    saveSettings(nextSettings)
    setSettings(nextSettings)

    const isMyWatchlist = nextSettings.appMode === 'my-watchlist'
    const hasSource = isMyWatchlist ? !!nextSettings.plexToken : !!nextSettings.sharedListUrl
    if (!hasSource) {
      setItems([])
      setSelectedItem(null)
      setWarnings([])
      setLastUpdated('')
      setError(
        isMyWatchlist
          ? 'Enter your Plex token or sign in with Plex to load your watchlist.'
          : 'Paste a public Plex share link to load a list.',
      )
    }
  }

  const handleForceRefresh = () => {
    forceRefreshRef.current = true
    setSettings((current) => ({ ...current }))
  }

  const handleLoadSavedList = (url: string) => {
    const nextSettings = { ...settings, sharedListUrl: url.trim(), appMode: 'shared-list' as AppMode }
    forceRefreshRef.current = true
    setDraftSettings(nextSettings)
    saveSettings(nextSettings)
    setSettings(nextSettings)
  }

  const handleRemoveSavedList = (url: string) => {
    deleteSavedListLink(url)
    deleteCachedList(url)
    setSavedListLinks(loadSavedListLinks())
  }

  const handleSwitchMode = (mode: AppMode) => {
    const nextSettings = { ...settings, appMode: mode }
    setDraftSettings(nextSettings)
    saveSettings(nextSettings)
    setSettings(nextSettings)
  }

  const handleStartPlexOAuth = async () => {
    try {
      const pin = await startPlexOAuth()
      setOauthPending(pin)
      window.open(pin.authUrl, '_blank', 'noopener,noreferrer')

      oauthPollRef.current = setInterval(async () => {
        const token = await pollPlexOAuthToken(pin.id)

        if (token) {
          clearInterval(oauthPollRef.current!)
          oauthPollRef.current = null
          setOauthPending(null)
          const nextSettings = { ...settings, plexToken: token, appMode: 'my-watchlist' as AppMode }
          setDraftSettings(nextSettings)
          saveSettings(nextSettings)
          forceRefreshRef.current = true
          setSettings(nextSettings)
        }
      }, 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Plex sign-in failed.')
    }
  }

  const handleCancelPlexOAuth = () => {
    if (oauthPollRef.current) {
      clearInterval(oauthPollRef.current)
      oauthPollRef.current = null
    }
    setOauthPending(null)
  }

  const handleClearPlexToken = () => {
    if (oauthPollRef.current) {
      clearInterval(oauthPollRef.current)
      oauthPollRef.current = null
    }
    setOauthPending(null)
    const nextSettings = { ...settings, plexToken: '', appMode: 'shared-list' as AppMode }
    setDraftSettings(nextSettings)
    saveSettings(nextSettings)
    setSettings(nextSettings)
  }

  const handleRandomPick = () => {
    startTransition(() => {
      setSelectedItem(pickRandomItem(filteredItems))
    })
  }

  const heroArtwork = selectedItem ? buildArtworkUrl(selectedItem.art || selectedItem.thumb) : ''

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Plex Shared Lists</p>
          <h1>Load a public Plex list, refine it fast, and pick something worth watching.</h1>
          <p className="hero-text">
            Paste a share link, browse every title from the list, then reroll a random pick from
            your current filtered results.
          </p>
          <div className="stat-row">
            <article className="stat-card">
              <span className="stat-label">Loaded items</span>
              <strong>{items.length}</strong>
            </article>
            <article className="stat-card">
              <span className="stat-label">Released now</span>
              <strong>{releasedCount}</strong>
            </article>
            <article className="stat-card">
              <span className="stat-label">Shown after filters</span>
              <strong>{filteredItems.length}</strong>
            </article>
          </div>
        </div>

        <div className={`picker-panel${selectedItem ? ' has-selection' : ''}`}>
          {heroArtwork ? (
            <div className="picker-backdrop" style={{ backgroundImage: `url(${heroArtwork})` }} />
          ) : null}
          <div className="picker-content">
            <p className="picker-label">Random picker</p>
            {selectedItem ? (
              <>
                <h2>{selectedItem.title}</h2>
                <p className="picker-meta">
                  {selectedItem.type === 'movie' ? 'Movie' : 'Series'}
                  {selectedItem.year ? ` - ${selectedItem.year}` : ''}
                  {` - ${formatDuration(selectedItem.durationMinutes, selectedItem.type, selectedItem.childCount)}`}
                </p>
                <p className="picker-summary">
                  {selectedItem.summary || 'No summary came back from Plex for this title.'}
                </p>
                <div className="picker-actions">
                  <button className="primary-button" onClick={handleRandomPick}>
                    Reroll
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>No pick yet</h2>
                <p className="picker-summary">
                  Use the filters below, then pull a random title from the current results.
                </p>
                <button
                  className="primary-button"
                  onClick={handleRandomPick}
                  disabled={!filteredItems.length}
                >
                  Pick for me
                </button>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="panel-grid">
        <form className="panel settings-panel" onSubmit={handleSaveSettings}>
          <div className="panel-header">
            <div>
              <p className="eyebrow">List Source</p>
              <h2>{settings.appMode === 'my-watchlist' ? 'My Watchlist' : 'Public share link'}</h2>
            </div>
            <button className="ghost-button" type="submit" disabled={loading}>
              {loading ? 'Loading...' : 'Load list'}
            </button>
          </div>

          <div className="mode-tabs">
            <button
              type="button"
              className={`mode-tab${settings.appMode === 'shared-list' ? ' is-active' : ''}`}
              onClick={() => handleSwitchMode('shared-list')}
            >
              Shared list
            </button>
            <button
              type="button"
              className={`mode-tab${settings.appMode === 'my-watchlist' ? ' is-active' : ''}`}
              onClick={() => handleSwitchMode('my-watchlist')}
            >
              My Watchlist
            </button>
          </div>

          {settings.appMode === 'shared-list' ? (
            <>
              <label className="field">
                <span>Plex share link</span>
                <input
                  type="url"
                  value={draftSettings.sharedListUrl}
                  onChange={(event) => handleSettingChange('sharedListUrl', event.target.value)}
                  placeholder="https://watch.plex.tv/u/username/lists/your-list-slug"
                />
              </label>

              <p className="panel-note">
                Share links and list snapshots are saved only in this browser. The app can show
                cached results instantly while refreshing in the background.
              </p>

              {savedListLinks.length ? (
                <section className="saved-lists" aria-label="Saved list links">
                  <p className="saved-lists-title">Recent links</p>
                  <div className="saved-lists-grid">
                    {savedListLinks.map((entry) => (
                      <div className="saved-list-row" key={entry.url}>
                        <button
                          className="saved-list-load"
                          type="button"
                          onClick={() => handleLoadSavedList(entry.url)}
                        >
                          <span>{entry.name}</span>
                          <small>{formatDate(entry.lastLoadedAt)}</small>
                        </button>
                        <button
                          className="saved-list-remove"
                          type="button"
                          onClick={() => handleRemoveSavedList(entry.url)}
                          aria-label={`Remove ${entry.name}`}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </>
          ) : (
            <>
              {settings.plexToken ? (
                <div className="watchlist-token-row">
                  <span className="watchlist-token-set">Plex account connected</span>
                  <button
                    type="button"
                    className="ghost-button cached-refresh-button"
                    onClick={handleClearPlexToken}
                  >
                    Disconnect
                  </button>
                </div>
              ) : oauthPending ? (
                <div className="watchlist-oauth-pending">
                  <p>Waiting for Plex sign-in…</p>
                  <p className="panel-note">
                    Complete sign-in in the Plex tab that opened. This page will update
                    automatically.
                  </p>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={handleCancelPlexOAuth}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="primary-button plex-signin-button"
                    onClick={handleStartPlexOAuth}
                  >
                    Sign in with Plex
                  </button>

                  <div className="watchlist-divider">
                    <span>or enter token manually</span>
                  </div>

                  <label className="field">
                    <span>Plex token</span>
                    <input
                      type="password"
                      value={draftSettings.plexToken}
                      onChange={(event) => handleSettingChange('plexToken', event.target.value)}
                      placeholder="xxxxxxxxxxxxxxxxxxxx"
                      autoComplete="off"
                    />
                  </label>

                  <p className="panel-note">
                    Find your token in Plex by opening any media item, clicking ···, selecting
                    "Get Info", then "View XML" — the token appears in the URL.
                  </p>
                </>
              )}
            </>
          )}

          <p className="tmdb-attribution">
            <img src={tmdbLogo} alt="TMDB logo" />
            <span>
              This product uses the TMDB API but is not endorsed or certified by TMDB.
            </span>
          </p>
        </form>

        <section className="panel filters-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Filters</p>
              <h2>Shape the picker pool</h2>
            </div>
            <button
              className="ghost-button"
              onClick={() => setFilters(DEFAULT_FILTERS)}
              type="button"
            >
              Reset filters
            </button>
          </div>

          <div className="filter-grid">
            <label className="field field-wide">
              <span>Search</span>
              <input
                type="search"
                value={filters.query}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, query: event.target.value }))
                }
                placeholder="Title, genre, studio, summary, year..."
              />
            </label>

            <label className="field">
              <span>Type</span>
              <select
                value={filters.type}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    type: event.target.value as WatchlistFilters['type'],
                  }))
                }
              >
                <option value="all">Movies and shows</option>
                <option value="movie">Movies only</option>
                <option value="show">Shows only</option>
              </select>
            </label>

            <label className="field">
              <span>Release state</span>
              <select
                value={filters.release}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    release: event.target.value as WatchlistFilters['release'],
                  }))
                }
              >
                <option value="all">Everything</option>
                <option value="released">Released</option>
                <option value="upcoming">Upcoming</option>
              </select>
            </label>

            <label className="field">
              <span>Genre</span>
              <select
                value={filters.genre}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, genre: event.target.value }))
                }
              >
                <option value="all">All genres</option>
                {availableGenres.map((genre) => (
                  <option key={genre} value={genre}>
                    {genre}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Minimum critic rating</span>
              <select
                value={filters.minRating}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    minRating: Number(event.target.value),
                  }))
                }
              >
                <option value="0">Any rating</option>
                <option value="6">6.0+</option>
                <option value="7">7.0+</option>
                <option value="8">8.0+</option>
                <option value="9">9.0+</option>
              </select>
            </label>

            <label className="field">
              <span>Sort</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as SortOption)}>
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
      </section>

      <section className="panel results-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">List Viewer</p>
            <h2>{settings.appMode === 'my-watchlist' ? 'My Watchlist' : 'Current list'}</h2>
          </div>
          <div className="status-cluster">
            {lastUpdated ? <span>Updated {formatDate(lastUpdated)}</span> : null}
            {loading ? <span>Loading list...</span> : null}
            {showingCachedData ? (
              <>
                <span className="cached-data-chip">Viewing cached data</span>
                <button className="ghost-button cached-refresh-button" onClick={handleForceRefresh}>
                  Refresh
                </button>
              </>
            ) : null}
            {showEnrichmentLoading ? (
              <span>
                Enhancing metadata {tmdbProgress.processed}/{tmdbProgress.total}
              </span>
            ) : null}
          </div>
        </div>

        {warnings.filter((w) => !w.startsWith('Using cached list data')).length ? (
          <div className="warning-banner">
            {warnings
              .filter((w) => !w.startsWith('Using cached list data'))
              .map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
          </div>
        ) : null}

        {error ? <p className="error-banner">{error}</p> : null}

        {loading ? (
          <div className="loading-state" aria-live="polite" aria-busy="true">
            <div className="loading-spinner" aria-hidden="true" />
            <div className="loading-copy">
              {items.length ? (
                <p className="loading-title">Updating</p>
              ) : (
                <>
                  <p className="loading-title">Loading Plex list</p>
                  <p>
                    Pulling pages and metadata. This can take up to a minute for large shared lists.
                  </p>
                </>
              )}
            </div>
          </div>
        ) : null}

        {showEnrichmentLoading ? (
          <div className="loading-state loading-state-secondary" aria-live="polite" aria-busy="true">
            <div className="loading-spinner loading-spinner-secondary" aria-hidden="true" />
            <div className="loading-copy">
              <p className="loading-title">Enhancing posters and ratings</p>
              <p>
                Processing {tmdbProgress.processed} of {tmdbProgress.total} titles in the
                background.
              </p>
            </div>
            <div className="loading-meter" aria-hidden="true">
              <div style={{ width: `${enrichmentPercent}%` }} />
            </div>
          </div>
        ) : null}

        {showInitialLoading ? (
          <div className="loading-skeleton-grid" aria-hidden="true">
            {Array.from({ length: 8 }, (_, index) => (
              <article className="loading-skeleton-card" key={`skeleton-${index}`}>
                <div className="loading-skeleton-button" />
                <div className="loading-skeleton-poster" />
                <div className="loading-skeleton-line short" />
                <div className="loading-skeleton-line" />
                <div className="loading-skeleton-line" />
                <div className="loading-skeleton-line short" />
              </article>
            ))}
          </div>
        ) : null}

        {!showInitialLoading && !loading && !error && !filteredItems.length ? (
          <div className="empty-state">
            <h3>No titles match the current filters.</h3>
            <p>Broaden the search, lower the rating threshold, or load a different list.</p>
          </div>
        ) : null}

        <div className={`media-grid${showInitialLoading ? ' is-hidden' : ''}`}>
          {filteredItems.map((item) => {
            const posterUrl = buildArtworkUrl(item.thumb || item.art)

            return (
              <article
                key={item.id}
                className={`media-card${selectedItem?.id === item.id ? ' is-selected' : ''}`}
              >
                <button
                  className="card-pick-button"
                  onClick={() => setSelectedItem(item)}
                  type="button"
                >
                  Set as active pick
                </button>

                <div className="poster-frame">
                  {posterUrl ? (
                    <img src={posterUrl} alt={`Poster for ${item.title}`} loading="lazy" />
                  ) : (
                    <div className="poster-fallback">{item.title.slice(0, 2).toUpperCase()}</div>
                  )}
                </div>

                <div className="card-body">
                  <div className="title-row">
                    <h3>{item.title}</h3>
                    <span className={`badge badge-${item.type}`}>
                      {item.type === 'movie' ? 'Movie' : 'Show'}
                    </span>
                  </div>

                  <p className="card-meta">
                    {item.year ? `${item.year} - ` : ''}
                    {formatDuration(item.durationMinutes, item.type, item.childCount)}
                  </p>

                  <div className="score-row">
                    <span>
                      {ratingSourceLabel(item.ratingSource, 'Critic')} {ratingLabel(item.rating)}
                    </span>
                    <span>
                      {ratingSourceLabel(item.audienceRatingSource, 'Audience')}{' '}
                      {ratingLabel(item.audienceRating)}
                    </span>
                  </div>

                  <p className="summary">
                    {item.summary || 'No summary returned from Plex for this title.'}
                  </p>

                  <div className="chip-row">
                    {item.genres.slice(0, 4).map((genre) => (
                      <span className="chip" key={`${item.id}-${genre}`}>
                        {genre}
                      </span>
                    ))}
                    {!isReleased(item) ? <span className="chip chip-alert">Upcoming</span> : null}
                  </div>

                  <dl className="details-grid">
                    <div>
                      <dt>Release</dt>
                      <dd>{formatDate(item.originallyAvailableAt)}</dd>
                    </div>
                    <div>
                      <dt>Studio</dt>
                      <dd>{item.studio || 'Unknown'}</dd>
                    </div>
                    <div>
                      <dt>Rated</dt>
                      <dd>{item.contentRating || 'Unrated'}</dd>
                    </div>
                  </dl>
                </div>
              </article>
            )
          })}
        </div>
      </section>
    </main>
  )
}

export default App
