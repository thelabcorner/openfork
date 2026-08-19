import { test } from "@playwright/test"

test.use({ viewport: { width: 1440, height: 900 } })

test("expands a folder whose path has a trailing Windows separator", async () => {
  // TODO: re-implement without the review panel (removed from the app)
})
