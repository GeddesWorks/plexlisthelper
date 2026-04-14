async page => {
  const items = Array.from({ length: 28 }, (_, index) => {
    const itemNumber = index + 1
    const isShow = itemNumber % 3 === 0
    const title =
      itemNumber % 4 === 0
        ? `The Extremely Long Showcase Title ${itemNumber} With A Subtitle That Must Wrap Cleanly`
        : `Sample Title ${itemNumber}`

    return {
      id: `id-${itemNumber}`,
      ratingKey: `rk-${itemNumber}`,
      guid: `guid://${itemNumber}`,
      type: isShow ? 'show' : 'movie',
      title,
      titleSort: title,
      year: 2004 + (itemNumber % 21),
      summary:
        'Long summary text for UI validation. This content intentionally wraps across multiple lines to expose spacing and overlap issues.',
      tagline: `Tagline ${itemNumber}`,
      studio:
        itemNumber % 5 === 0
          ? `Very Long Studio Name ${itemNumber} Global Distribution Group`
          : `Studio ${itemNumber}`,
      contentRating: itemNumber % 2 === 0 ? 'PG-13' : 'R',
      durationMinutes: isShow ? null : 88 + itemNumber,
      childCount: isShow ? 7 + itemNumber : null,
      thumb: '',
      art: '',
      genres: ['Drama', 'Science Fiction', 'Mystery'],
      rating: Number((6 + (itemNumber % 5) * 0.7).toFixed(1)),
      audienceRating: Number((5.5 + (itemNumber % 6) * 0.7).toFixed(1)),
      originallyAvailableAt: `202${itemNumber % 6}-0${(itemNumber % 9) + 1}-15`,
      watchlistedAt: '2026-04-01T00:00:00Z',
    }
  })

  await page.route('**/functions/plexlists_scraper/executions', async route => {
    const payload = {
      ok: true,
      items,
      warnings: ['Some titles only returned basic public metadata.'],
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

  return `Mock route armed with ${items.length} items`
}
