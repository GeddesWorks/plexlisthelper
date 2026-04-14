async page => {
  const items = Array.from({ length: 12 }, (_, index) => {
    const itemNumber = index + 1

    return {
      id: `id-${itemNumber}`,
      ratingKey: `rk-${itemNumber}`,
      guid: `guid://${itemNumber}`,
      type: itemNumber % 3 === 0 ? 'show' : 'movie',
      title:
        itemNumber % 2 === 0
          ? `A Very Long Movie Title ${itemNumber} That Wraps`
          : `Sample Title ${itemNumber}`,
      titleSort: `Title ${itemNumber}`,
      year: 2000 + itemNumber,
      summary: 'Demo summary for loading and poster layout checks.',
      tagline: '',
      studio: 'Studio',
      contentRating: 'PG-13',
      durationMinutes: itemNumber % 3 === 0 ? null : 100 + itemNumber,
      childCount: itemNumber % 3 === 0 ? 10 + itemNumber : null,
      thumb: '',
      art: '',
      genres: ['Drama'],
      rating: 7.1,
      audienceRating: 7.3,
      originallyAvailableAt: '2024-01-01',
      watchlistedAt: '2026-01-01',
    }
  })

  await page.route('**/functions/plexlists_scraper/executions', async route => {
    await new Promise((resolve) => setTimeout(resolve, 2600))

    const payload = {
      ok: true,
      items,
      warnings: [],
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        responseStatusCode: 200,
        responseBody: JSON.stringify(payload),
      }),
    })
  })

  return 'Slow mock route armed'
}
