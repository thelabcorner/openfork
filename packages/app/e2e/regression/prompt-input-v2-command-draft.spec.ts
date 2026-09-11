import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/PromptInputV2Editing"
const projectID = "proj_prompt_input_v2_editing"
const sessionID = "ses_prompt_input_v2_editing"

test("preserves the draft when a populated command menu triggers a built-in", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "prompt-input-v2-editing",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        slug: "prompt-input-v2-editing",
        projectID,
        directory,
        title: "Prompt input V2 editing",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="prompt-input-v2"]')
  const input = composer.locator('[data-component="prompt-input"]')
  await expectAppVisible(composer)

  await input.fill("keep me")
  await composer.getByRole("button", { name: "Add images and files" }).click()
  await page.getByRole("menuitem", { name: "Commands" }).click()
  await page.locator('[data-suggestion-id="model.choose"]').click()

  await expect(input).toHaveText("keep me")
})

test("keeps the session rendered when @ opens while the tool catalog is pending", async ({ page }) => {
  let releaseCatalog!: () => void
  let catalogRequests = 0
  const catalogGate = new Promise<void>((resolve) => {
    releaseCatalog = resolve
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "prompt-input-v2-editing",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "mention-model": {
              id: "mention-model",
              name: "Mention Model",
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "mention-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "prompt-input-v2-editing",
        projectID,
        directory,
        title: "Prompt input V2 editing",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  // Playwright resolves the most recently registered route first, so install
  // this after the shared mock server's catch-all handlers.
  await page.route("**/experimental/tool/catalog**", async (route) => {
    catalogRequests++
    await catalogGate
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="prompt-input-v2"]')
  const input = composer.locator('[data-component="prompt-input"]')
  await expectAppVisible(composer)
  await expect.poll(() => catalogRequests).toBeGreaterThan(0)

  try {
    await input.focus()
    await input.press("@")

    // Regression: reading the pending catalog through the normal Solid
    // resource accessor used to suspend the nearest route boundary here,
    // replacing the whole session with its dark loading fallback.
    await expect(composer).toBeVisible()
    await expect(input).toBeVisible()
    await expect(input).toHaveText("@")
  } finally {
    releaseCatalog()
  }
})

test("renders searched directories as folders without file metadata and preserves directory mention semantics", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "prompt-input-v2-editing",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        slug: "prompt-input-v2-editing",
        projectID,
        directory,
        title: "Prompt input V2 editing",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  // Register after the shared mock so this targeted response wins route
  // precedence. Intentionally include stale zero file metrics to verify the
  // directory classifier strips them before they can reach the picker.
  await page.route("**/find/search**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        results: [
          {
            kind: "file",
            path: "src/components",
            type: "directory",
            positions: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
            baseOffset: 4,
            size: 0,
            mtime: 0,
            lineCount: 0,
          },
        ],
        hasMore: false,
      }),
    })
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="prompt-input-v2"]')
  const input = composer.locator('[data-component="prompt-input"]')
  await expectAppVisible(composer)

  await input.focus()
  await input.pressSequentially("@components")

  const row = page.locator('[data-suggestion-id="file:src/components"]')
  await expect(row).toBeVisible()
  await expect(row).not.toContainText("0 B")
  await expect(row).not.toContainText("0 lines")
  await expect(row.locator('[data-component="file-icon"] use')).toHaveAttribute("href", /#FolderComponents$/)

  await row.click()
  const mention = input.locator('[data-path="src/components"]')
  await expect(mention).toHaveAttribute("data-mention", "reference")
  await expect(mention).toHaveAttribute("data-mime", "application/x-directory")
})
