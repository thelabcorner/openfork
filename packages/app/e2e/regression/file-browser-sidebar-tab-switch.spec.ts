import { test } from "@playwright/test"

test.use({ viewport: { width: 1440, height: 900 } })

test("keeps the file-browser sidebar mounted when switching file tabs", async () => {
  // TODO: re-implement without the review panel (removed from the app)
})
