import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/ModelSelectorPointerFocus"

const MODELS = ["Alpha Model", "Bravo Model", "Charlie Model", "Delta Model", "Echo Model", "Foxtrot Model"]

// The composer binds fork-owned usage projections unconditionally, so both
// surfaces need a real shape here; an empty snapshot is enough for row hover.
const workload = {
  inputTokens: 1_200,
  cacheReadTokens: 54_000,
  cacheWriteTokens: 800,
  outputTokens: 1_100,
  reasoningTokens: 500,
  contextTokens: 56_000,
  generationTokens: 1_600,
  totalTokens: 57_600,
}
const forkGeneralUsage = {
  source: "personal-general",
  fingerprint: "general-v1:pointer-focus",
  fallback: workload,
  typical: workload,
  corpus: [],
  evidence: { observations: 0, requestEffectiveSamples: 0, sessionEffectiveSamples: 0 },
  models: [],
}
const forkCapacity = {
  providerID: "opencode-go",
  priorStatus: "ok",
  priorFetchedAt: 0,
  routed: [],
  accounts: [],
  providers: [],
  generalUsage: forkGeneralUsage,
}
const modelRows = (page: Page) =>
  page.locator("[data-option-key]").filter({ hasText: /(?:Alpha|Bravo|Charlie|Delta|Echo|Foxtrot) Model/ })

// Kobalte focuses a menu item on every mouse pointermove. Counting the focus
// events rows actually receive is the only way to prove a scan stayed CSS-only:
// which element holds focus afterwards is indistinguishable either way, because
// leaving a row returns focus to the menu content.
const countRowFocusEvents = async (page: Page) => {
  await page.evaluate(() => {
    const state = window as unknown as { __rowFocusEvents?: number }
    state.__rowFocusEvents = 0
    document.addEventListener(
      "focusin",
      (event) => {
        const target = event.target
        if (target instanceof Element && target.closest("[data-option-key]")) {
          state.__rowFocusEvents = (state.__rowFocusEvents ?? 0) + 1
        }
      },
      true,
    )
  })
}

const rowFocusEvents = (page: Page) =>
  page.evaluate(() => (window as unknown as { __rowFocusEvents?: number }).__rowFocusEvents ?? 0)

async function openModelSelector(page: Page) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_model_selector_focus",
      worktree: directory,
      vcs: "git",
      name: "ModelSelectorPointerFocus",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "bench",
          name: "Bench",
          models: Object.fromEntries(
            MODELS.map((name, index) => [
              `focus-model-${index}`,
              {
                id: `focus-model-${index}`,
                name,
                cost: { input: 1 + index / 10, output: 2 + index / 10, cache: { read: 0.1, write: 0 } },
                limit: { context: 200_000 },
              },
            ]),
          ),
        },
      ],
      connected: ["bench"],
      default: { providerID: "bench", modelID: "focus-model-0" },
    },
    sessions: [],
    pageMessages: () => ({ items: [] }),
    forkGeneralUsage,
    forkCapacity,
    fileList: (path) =>
      path
        ? []
        : [
            {
              name: "ModelSelectorPointerFocus",
              path: "ModelSelectorPointerFocus",
              absolute: directory,
              type: "directory",
              ignored: false,
            },
          ],
    findFiles: () => ["ModelSelectorPointerFocus"],
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [] } }))
  })

  await page.goto("/")
  const addProject = page.locator('[data-action="home-add-project-row"]')
  await expectAppVisible(addProject)
  await addProject.click()
  await page.locator("[data-directory-path]").click()
  await page.locator('[data-action="home-new-session"]').click()

  const trigger = page.locator('[data-action="prompt-model"][data-control-type="popover"][aria-haspopup]')
  await expectAppVisible(trigger)
  const box = await trigger.boundingBox()
  if (!box) throw new Error("Model selector trigger has no layout box")
  // Kobalte opens this DropdownMenu on pointerdown for a mouse, so a trusted
  // mouse press/release pair is required; release only once the portalled
  // content is up, so the same gesture cannot click through it.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  const search = page.locator("input[data-model-selector-search]")
  try {
    await expect(search).toBeVisible()
  } finally {
    await page.mouse.up()
  }
  // The trigger sits where the portalled content lands, so the resting pointer
  // is over a row the moment the menu opens. Park it on the search field so
  // every later pointer event in a test is the one that test performed.
  const searchBox = await search.boundingBox()
  if (!searchBox) throw new Error("Model selector search has no layout box")
  await page.mouse.move(searchBox.x + searchBox.width / 2, searchBox.y + searchBox.height / 2)
  await expect(modelRows(page).first()).toBeVisible()
  return trigger
}

test("scanning model rows with the mouse never takes DOM focus", async ({ page }) => {
  await openModelSelector(page)
  await countRowFocusEvents(page)

  const rows = modelRows(page)
  expect(await rows.count()).toBeGreaterThanOrEqual(4)
  const first = await rows.first().boundingBox()
  const last = await rows.last().boundingBox()
  if (!first || !last) throw new Error("Model selector rows have no layout box")

  // One stepped move across the whole list: every row is crossed in a couple of
  // milliseconds, far below the 64 ms hover-intent dwell. This is the fast-scan
  // path production must keep CSS-only.
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
  await page.mouse.move(first.x + first.width / 2, last.y + last.height / 2, { steps: 12 })

  expect(await rowFocusEvents(page)).toBe(0)
  await expect(page.locator("[data-option-key]:focus")).toHaveCount(0)
  await expect(page.locator('[data-component="model-inspector-float"]')).toHaveCount(0)
})

test("an admitted hover intent focuses the intended model row so keyboard continues there", async ({ page }) => {
  await openModelSelector(page)
  await countRowFocusEvents(page)

  const target = page.getByRole("menuitem", { name: "Charlie Model" })
  await expect(target).toBeVisible()
  await target.hover()

  await expect(target).toBeFocused()
  await expect(page.locator('[data-component="model-inspector-float"]')).toHaveCount(1)
  expect(await rowFocusEvents(page)).toBe(1)

  await page.keyboard.press("ArrowDown")
  await expect(target).not.toBeFocused()
  await expect(page.locator("[data-option-key]:focus")).toHaveCount(1)
})

test("clicking a model row still selects it", async ({ page }) => {
  const trigger = await openModelSelector(page)

  const target = page.getByRole("menuitem", { name: "Foxtrot Model" })
  await expect(target).toBeVisible()
  await target.click()

  await expect(page.locator("input[data-model-selector-search]")).toHaveCount(0)
  await expect(trigger).toContainText("Foxtrot Model")
})
