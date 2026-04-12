import { startTransition, useEffect, useState } from 'react'
import './App.css'
import {
  buildArtworkUrl,
  fetchSharedList,
  filterItems,
  isReleased,
  pickRandomItem,
  sortItems,
  type SharedListResult,
  type PlexWatchlistItem,
  type SortOption,
  type WatchlistFilters,
} from './lib/plex'
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  type PlexSettings,
} from './lib/storage'

const DEFAULT_FILTERS: WatchlistFilters = {
  query: '',
  type: 'all',
  release: 'all',
  genre: 'all',
  minRating: 0,
}

const SORT_OPTIONS: Array<{ value: SortOption; label: string }> = [
  { value: 'list:asc', label: 'Shared list order' },
  { value: 'titleSort:asc', label: 'Title A-Z' },
  { value: 'titleSort:desc', label: 'Title Z-A' },
  { value: 'originallyAvailableAt:desc', label: 'Newest release' },
  { value: 'originallyAvailableAt:asc', label: 'Oldest release' },
  { value: 'rating:desc', label: 'Highest critic rating' },
  { value: 'rating:asc', label: 'Lowest critic rating' },
]

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

async function requestWatchlist(settings: PlexSettings): Promise<SharedListResult> {
  return fetchSharedList(settings)
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

  useEffect(() => {
    const storedSettings = loadSettings()
    setSettings(storedSettings)
    setDraftSettings(storedSettings)
  }, [])

  useEffect(() => {
    if (!settings.sharedListUrl) {
      setItems([])
      setSelectedItem(null)
      setWarnings([])
      setLastUpdated('')
      setError('Paste a public Plex share link to load a list.')
      return
    }

    const loadWatchlist = async () => {
      setLoading(true)
      setError('')

      try {
        const nextResult = await requestWatchlist(settings)
        const nextItems = nextResult.items

        startTransition(() => {
          setItems(nextItems)
          setWarnings(nextResult.warnings)
          setSelectedItem((currentSelection) => {
            if (!currentSelection) {
              return null
            }

            return nextItems.find((item) => item.id === currentSelection.id) ?? null
          })
          setLastUpdated(new Date().toISOString())
        })
      } catch (caughtError) {
        setWarnings([])
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : 'The shared Plex list request failed for an unknown reason.',
        )
      } finally {
        setLoading(false)
      }
    }

    void loadWatchlist()
  }, [settings])

  const filteredItems = sortItems(filterItems(items, filters), sort)
  const availableGenres = [...new Set(items.flatMap((item) => item.genres))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))

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

    const nextSettings = {
      sharedListUrl: draftSettings.sharedListUrl.trim(),
    }

    saveSettings(nextSettings)
    setSettings(nextSettings)

    if (!nextSettings.sharedListUrl) {
      setItems([])
      setSelectedItem(null)
      setWarnings([])
      setLastUpdated('')
      setError('Paste a public Plex share link to load a list.')
    }
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
          <h1>Load a public Plex list, filter it down, and let the app pick tonight&apos;s watch.</h1>
          <p className="hero-text">
            This app loads public Plex share links through an Appwrite scraper function. Paste a
            shared list URL, browse the items that are publicly retrievable, and reroll a random
            pick from the current results.
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
              <h2>Public share link</h2>
            </div>
            <button className="ghost-button" type="submit">
              Save and refresh
            </button>
          </div>

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
            The browser only stores the share link. Public list data now comes from the Appwrite
            function in the quote dump project, and Plex still limits anonymous pagination. If this
            site runs on a new domain, add that origin as a Web platform in Appwrite.
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
            <h2>Current shared list</h2>
          </div>
          <div className="status-cluster">
            {lastUpdated ? <span>Updated {formatDate(lastUpdated)}</span> : null}
            {loading ? <span>Loading...</span> : null}
          </div>
        </div>

        {warnings.length ? (
          <div className="warning-banner">
            {warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        ) : null}

        {error ? <p className="error-banner">{error}</p> : null}

        {!loading && !error && !filteredItems.length ? (
          <div className="empty-state">
            <h3>No titles match the current filters.</h3>
            <p>Broaden the search, lower the rating threshold, or load a different share link.</p>
          </div>
        ) : null}

        <div className="media-grid">
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
                  Make active pick
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
                    <span>Critic {ratingLabel(item.rating)}</span>
                    <span>Audience {ratingLabel(item.audienceRating)}</span>
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
