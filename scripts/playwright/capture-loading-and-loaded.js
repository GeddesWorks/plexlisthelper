async page => {
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.getByRole('textbox', { name: 'Plex share link' }).fill(
    'https://watch.plex.tv/u/GeddesWorks/lists/Nw7q-the-real-list',
  )
  await page.getByRole('button', { name: 'Load list' }).click()

  await page.waitForTimeout(500)
  await page.screenshot({ path: 'output/playwright/ui-loading-state-v1.png' })

  await page.waitForTimeout(3000)
  await page.screenshot({ path: 'output/playwright/ui-loaded-state-v1.png' })

  return 'Captured loading + loaded states'
}
