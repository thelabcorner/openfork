import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/PromptAutocorrectionRegression"
const sessionID = "ses_prompt_autocorrection_regression"
const projectID = "proj_prompt_autocorrection_regression"

async function prepare(page: Page, general: Record<string, unknown>) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "prompt-autocorrection-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { "correction-test-model": {
            id: "correction-test-model",
            name: "Correction Test Model",
            limit: { context: 200_000 },
          } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "correction-test-model" },
    },
    sessions: [{
      id: sessionID,
      slug: "prompt-autocorrection",
      projectID,
      directory,
      title: "Prompt autocorrection",
      version: "dev",
      time: { created: 1700000000000, updated: 1700000000000 },
    }],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript((settings) => {
    if (!localStorage.getItem("settings.v3")) {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, ...settings } }))
    }
  }, general)
  // The composer synchronizes its first-party permission policy BEFORE prompt
  // admission; the shared mock intentionally does not provide a success reply.
  await page.route("**/session/" + sessionID + "/limit-recovery**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "null", headers: { "access-control-allow-origin": "*" } })
  })
  await page.route("**/permission/auto-accept**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "true",
      headers: { "access-control-allow-origin": "*" },
    })
  })
  const captured: unknown[] = []
  await page.route("**/session/" + sessionID + "/prompt_async", async (route) => {
    captured.push(route.request().postDataJSON())
    await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
  })
  await page.goto("/" + base64Encode(directory) + "/session/" + sessionID)
  const composer = page.locator('[data-component="prompt-input-v2"]')
  await expectAppVisible(composer)
  const input = composer.locator('[data-component="prompt-input"]')
  const posted = async () => {
    await expect.poll(() => captured.length).toBe(1)
    return JSON.stringify(captured[0])
  }
  return { input, composer, posted }
}

// Use PLAYWRIGHT_PORT=<unused-port> or PLAYWRIGHT_REUSE_EXISTING_SERVER=0
// to guarantee these requests are served by the current working tree.
test.describe("First-party prompt submission certification", () => {
test("opt-in submit normalizes before durable prompt admission", async ({ page }) => {
  const { input, posted } = await prepare(page, { promptAutocorrection: true })
  await input.fill("contienu the reasearch")
  await input.press("Enter")
  const body = await posted()
  expect(body).toContain("continue the research")
  expect(body).not.toContain("contienu")
})

test("opt-in Harper shows offline grammar squiggle suggestions and applies a fix before send", async ({ page }) => {
  const { input, composer } = await prepare(page, { promptGrammarHarper: true })
  const authored = "This is a example of a application."
  await input.fill(authored)
  const issues = composer.locator('[data-action="prompt-grammar-issues"]')
  await expect(composer).toHaveAttribute("data-harper-state", "ready", { timeout: 25_000 })
  await expect(issues).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => page.evaluate(() =>
    Array.from(CSS.highlights.keys()).filter((name) => name.startsWith("openfork-writing-")).length,
  )).toBeGreaterThan(0)
  const count = await issues.getAttribute("aria-label")
  expect(count).toContain("writing suggestions")
  await issues.click()
  const popup = page.locator('[data-action="prompt-grammar-suggestion-popup"]')
  await expect(popup).toBeVisible()
  const suggestions = popup.locator('[data-action="prompt-grammar-accept"]')
  await expect(suggestions.first()).toBeVisible()
  await suggestions.first().click()
  await expect(input).not.toHaveText(authored)
  const undo = composer.locator('[data-action="prompt-grammar-undo"]')
  await expect(undo).toBeVisible()
  await undo.click()
  await expect(input).toHaveText(authored)
  await expect(undo).toHaveCount(0)
})

test("opted-in Harper auto-applies vetted typos, with per-word reject and no reapplication", async ({ page }) => {
  const { input, composer, posted } = await prepare(page, {
    promptGrammarHarper: true,
    promptGrammarAutoApply: true,
    promptAutocorrection: true,
  })
  await input.fill("Please contienu the reasearch.")
  await expect(input).toHaveText("Please continue the research.", { timeout: 30_000 })
  const review = composer.locator('[data-action="prompt-grammar-auto-review"]')
  await expect(review).toContainText("2 auto-fixed")
  await review.click()
  const popup = page.locator('[data-action="prompt-grammar-auto-popup"]')
  await expect(popup).toBeVisible()
  await expect(popup.locator('[data-action="prompt-grammar-auto-entry"]')).toHaveCount(2)
  await popup.locator('[aria-label="Restore contienu"]').click()
  await expect(input).toHaveText("Please contienu the research.")
  await page.waitForTimeout(1_000)
  await expect(input).toHaveText("Please contienu the research.")
  await input.press("Enter")
  // A rejected automatic change must also veto separately enabled send-time
  // deterministic correction; never override the author's rejection.
  expect(await posted()).toContain("Please contienu the research.")
})

test("automatically corrected words show distinct clickable marks and can be rejected", async ({ page }) => {
  const { input, composer } = await prepare(page, {
    promptGrammarHarper: true,
    promptGrammarAutoApply: true,
  })
  await input.fill("Please contienu working.")
  await expect(input).toHaveText("Please continue working.", { timeout: 30_000 })
  await expect(composer.locator('[data-action="prompt-grammar-auto-review"]')).toBeVisible()
  const position = await page.evaluate(() => {
    const marker = [...CSS.highlights.entries()]
      .find(([key]) => key.startsWith("openfork-writing-corrected-"))
    const range = marker?.[1].values().next().value as Range | undefined
    const bounds = range?.getBoundingClientRect()
    if (!bounds) return undefined
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
  })
  expect(position).toBeDefined()
  if (!position) return
  await page.mouse.click(position.x, position.y)
  const popup = page.locator('[data-action="prompt-grammar-auto-popup"]')
  await expect(popup).toBeVisible()
  await popup.getByRole("button", { name: "Restore contienu" }).click()
  await expect(input).toHaveText("Please contienu working.")
})

test("hovering an auto-corrected word reveals an inline premium badge and X restores it", async ({ page }) => {
  const { input, composer } = await prepare(page, { promptGrammarHarper: true, promptGrammarAutoApply: true })
  await input.fill("Please contienu working.")
  await expect(input).toHaveText("Please continue working.", { timeout: 30_000 })
  await expect(composer.locator('[data-action="prompt-grammar-auto-review"]')).toBeVisible()
  const bounds = await page.evaluate(() => {
    const selected = [...CSS.highlights.entries()].find(([key]) => key.startsWith("openfork-writing-corrected-"))
    const range = selected?.[1].values().next().value as Range | undefined
    const rect = range?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : undefined
  })
  expect(bounds).toBeDefined()
  if (!bounds) return
  await page.mouse.move(bounds.x, bounds.y)
  const badge = page.locator('[data-action="prompt-writing-hover-badge"]')
  await expect(badge).toBeVisible()
  await expect(badge).toContainText("contienu")
  await expect(badge).toContainText("continue")
  await badge.getByRole("button", { name: "Restore contienu" }).click()
  await expect(input).toHaveText("Please contienu working.")
  await expect(badge).toHaveCount(0)
})

test("hovering an unresolved suggestion reveals X that dismisses only that issue", async ({ page }) => {
  const { input, composer } = await prepare(page, { promptGrammarHarper: true })
  const authored = "Please contienu the reasearch."
  await input.fill(authored)
  await expect(composer).toHaveAttribute("data-harper-state", "ready", { timeout: 25_000 })
  const counter = composer.locator('[data-action="prompt-grammar-issues"]')
  await expect(counter).toHaveAttribute("aria-label", "2 writing suggestions")
  const bounds = await page.evaluate(() => {
    const selected = [...CSS.highlights.entries()].find(([key]) => key.startsWith("openfork-writing-spelling-"))
    const range = selected?.[1].values().next().value as Range | undefined
    const rect = range?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : undefined
  })
  expect(bounds).toBeDefined()
  if (!bounds) return
  await page.mouse.move(bounds.x, bounds.y)
  const badge = page.locator('[data-action="prompt-writing-hover-badge"]')
  await expect(badge).toBeVisible()
  await badge.getByRole("button", { name: "Dismiss contienu suggestion" }).click()
  await expect(counter).toHaveAttribute("aria-label", "1 writing suggestions")
  await expect(input).toHaveText(authored)
})

test("hover chip primary action opens compact suggestion review without changing drafted text", async ({ page }) => {
  const { input, composer } = await prepare(page, { promptGrammarHarper: true })
  const authored = "Please contienu the reasearch."
  await input.fill(authored)
  const issues = composer.locator('[data-action="prompt-grammar-issues"]')
  await expect(issues).toHaveAttribute("aria-label", "2 writing suggestions", { timeout: 25_000 })
  const rect = await page.evaluate(() => {
    const marker = [...CSS.highlights.entries()].find(([id]) => id.startsWith("openfork-writing-spelling-"))
    const range = marker?.[1].values().next().value as Range | undefined
    const r = range?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined
  })
  expect(rect).toBeDefined()
  if (!rect) return
  await page.mouse.move(rect.x, rect.y)
  const badge = page.locator('[data-action="prompt-writing-hover-badge"]')
  await expect(badge).toBeVisible()
  await badge.locator('[data-action="prompt-writing-hover-open"]').click()
  const popup = page.locator('[data-action="prompt-grammar-suggestion-popup"]')
  await expect(popup).toBeVisible()
  await expect(input).toHaveText(authored)
  await expect(popup.locator('[data-action="prompt-grammar-accept"]')).toHaveCount(3)
  await popup.getByRole("button", { name: "Dismiss suggestion" }).click()
  await expect(issues).toHaveAttribute("aria-label", "1 writing suggestions")
  await expect(input).toHaveText(authored)
})

test("automatic correction remains rejectable after unrelated typing", async ({ page }) => {
  const { input, composer } = await prepare(page, {
    promptGrammarHarper: true,
    promptGrammarAutoApply: true,
  })
  await input.fill("Please contienu working.")
  await expect(input).toHaveText("Please continue working.", { timeout: 30_000 })
  await input.focus()
  await input.press("End")
  await input.press(" ")
  await input.type("More details.")
  await expect(input).toHaveText("Please continue working. More details.")
  await expect(composer.locator('[data-action="prompt-grammar-auto-review"]')).toBeVisible()
  await composer.locator('[data-action="prompt-grammar-auto-review"]').click()
  await page.locator('[data-action="prompt-grammar-auto-popup"]')
    .getByRole("button", { name: "Restore contienu" }).click()
  await expect(input).toHaveText("Please contienu working. More details.")
})

test("Ctrl+Z rejects the latest automatic correction rather than undoing unrelated typing", async ({ page }) => {
  const { input, composer } = await prepare(page, {
    promptGrammarHarper: true,
    promptGrammarAutoApply: true,
  })
  await input.fill("Please contienu working.")
  await expect(input).toHaveText("Please continue working.", { timeout: 30_000 })
  await expect(composer.locator('[data-action="prompt-grammar-auto-review"]')).toBeVisible()
  await input.focus()
  await input.press("Control+z")
  await expect(input).toHaveText("Please contienu working.")
  await expect(composer.locator('[data-action="prompt-grammar-auto-review"]')).toHaveCount(0)
  await page.waitForTimeout(800)
  await expect(input).toHaveText("Please contienu working.")
})

test("Harper automatically corrects the narrowly allowed a/an grammar rule, with reject", async ({ page }) => {
  const { input, composer } = await prepare(page, {
    promptGrammarHarper: true,
    promptGrammarAutoApply: true,
  })
  await input.fill("This is a example.")
  await expect(input).toHaveText("This is an example.", { timeout: 30_000 })
  await composer.locator('[data-action="prompt-grammar-auto-review"]').click()
  await page.locator('[data-action="prompt-grammar-auto-popup"]')
    .getByRole("button", { name: "Restore a" }).click()
  await expect(input).toHaveText("This is a example.")
  await page.waitForTimeout(800)
  await expect(input).toHaveText("This is a example.")
  await expect(composer.locator('[data-action="prompt-grammar-issues"]')).toHaveCount(0)
})

test("Harper auto-apply remains opt-in and never rewrites grammar or quoted code", async ({ page }) => {
  const { input, composer } = await prepare(page, {
    promptGrammarHarper: true,
    promptGrammarAutoApply: true,
  })
  const authored = 'I has a book. Keep "contienu" exactly.'
  await input.fill(authored)
  await expect(composer).toHaveAttribute("data-harper-state", "ready", { timeout: 30_000 })
  await expect(input).toHaveText(authored)
  await expect(composer.locator('[data-action="prompt-grammar-auto-review"]')).toHaveCount(0)
  await expect(composer.locator('[data-action="prompt-grammar-issues"]')).toBeVisible()
})

test("Harper squiggles open a suggestion at its actual text position without rewriting the editor", async ({ page }) => {
  const { input, composer } = await prepare(page, { promptGrammarHarper: true })
  const authored = "This is a example."
  await input.fill(authored)
  await expect(composer).toHaveAttribute("data-harper-state", "ready", { timeout: 25_000 })
  const rect = await page.evaluate(() => {
    const match = [...CSS.highlights.entries()].find(([name]) => name.startsWith("openfork-writing-"))
    const target = match?.[1].values().next().value as Range | undefined
    const r = target?.getBoundingClientRect()
    if (!r) return undefined
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  expect(rect).toBeDefined()
  if (!rect) return
  await page.mouse.click(rect.x, rect.y)
  const popup = page.locator('[data-action="prompt-grammar-suggestion-popup"]')
  await expect(popup).toBeVisible()
  await expect(input).toHaveText(authored)
  await popup.getByRole("button", { name: "Dismiss suggestion" }).click()
  await expect(input).toHaveText(authored)
})

test("Harper Ignore action persists a personal dictionary entry and removes only that spelling alert", async ({ page }) => {
  const { input, composer } = await prepare(page, { promptGrammarHarper: true })
  const authored = "Please contienu the reasearch."
  await input.fill(authored)
  await expect(composer).toHaveAttribute("data-harper-state", "ready", { timeout: 25_000 })
  const badge = composer.locator('[data-action="prompt-grammar-issues"]')
  await expect(badge).toHaveAttribute("aria-label", "2 writing suggestions")
  await badge.click()
  const popup = page.locator('[data-action="prompt-grammar-suggestion-popup"]')
  await expect(popup.getByRole("button", { name: "Ignore this spelling" })).toBeVisible()
  await popup.getByRole("button", { name: "Ignore this spelling" }).click()
  await expect.poll(async () => page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("settings.v3") ?? "{}") as {
      general?: { promptGrammarIgnoredWords?: string[] }
    }
    return raw.general?.promptGrammarIgnoredWords
  })).toEqual(["contienu"])
  await expect(badge).toHaveAttribute("aria-label", "1 writing suggestions", { timeout: 25_000 })
  await expect(input).toHaveText(authored)
})

test("Harper cancels in-progress composition, clears ranges and resumes after IME completion", async ({ page }) => {
  const { input, composer } = await prepare(page, { promptGrammarHarper: true })
  const authored = "This is a example."
  await input.fill(authored)
  await expect(composer).toHaveAttribute("data-harper-state", "ready", { timeout: 25_000 })
  await expect(composer.locator('[data-action="prompt-grammar-issues"]')).toBeVisible()

  await input.dispatchEvent("compositionstart", { data: "a" })
  await expect(composer).toHaveAttribute("data-harper-state", "off")
  await expect(composer.locator('[data-action="prompt-grammar-issues"]')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() =>
    Array.from(CSS.highlights.keys()).filter((name) => name.startsWith("openfork-writing-")).length,
  )).toBe(0)
  await expect(input).toHaveText(authored)

  await input.dispatchEvent("compositionend", { data: "a" })
  await expect(composer).toHaveAttribute("data-harper-state", "ready", { timeout: 25_000 })
  await expect(composer.locator('[data-action="prompt-grammar-issues"]')).toBeVisible()
  await expect(input).toHaveText(authored)
})

test("rapid edits suppress obsolete suggestions and do not rewrite later prose", async ({ page }) => {
  const { input, composer } = await prepare(page, { promptGrammarHarper: true })
  await input.fill("This is a example.")
  await input.fill("This is an example.")
  await expect(composer).toHaveAttribute("data-harper-state", "ready", { timeout: 25_000 })
  await expect(composer.locator('[data-action="prompt-grammar-issues"]')).toHaveCount(0)
  await expect(input).toHaveText("This is an example.")
})

test("Harper opt-out never activates grammar worker or custom highlights", async ({ page }) => {
  const { input, composer } = await prepare(page, {})
  await input.fill("This is a example.")
  await expect(composer).toHaveAttribute("data-harper-state", "off")
  await expect(composer.locator('[data-action="prompt-grammar-issues"]')).toHaveCount(0)
  expect(await page.evaluate(() =>
    [...CSS.highlights.keys()].filter((key) => key.startsWith("openfork-writing-")).length,
  )).toBe(0)
  await expect(input).toHaveText("This is a example.")
})

test("Harper personal dictionary filters named technical spelling errors without modifying prose", async ({ page }) => {
  const { input, composer } = await prepare(page, {
    promptGrammarHarper: true,
    promptGrammarIgnoredWords: ["contienu"],
  })
  const authored = "Please contienu the reasearch."
  await input.fill(authored)
  await expect(composer).toHaveAttribute("data-harper-state", "ready", { timeout: 25_000 })
  const issues = composer.locator('[data-action="prompt-grammar-issues"]')
  await expect(issues).toHaveAttribute("aria-label", "1 writing suggestions")
  await expect(input).toHaveText(authored)
})

test("disabled default preserves authored text", async ({ page }) => {
  const { input, composer, posted } = await prepare(page, {})
  await input.fill("contienu the reasearch")
  await composer.getByRole("button", { name: "Send", exact: true }).click()
  expect(await posted()).toContain("contienu the reasearch")
})

test("custom and ignored words obey priority on the same submitted prompt", async ({ page }) => {
  const { input, composer, posted } = await prepare(page, {
    promptAutocorrection: true,
    promptAutocorrectionIgnore: ["reasearch"],
    promptAutocorrectionCustom: { gaol: "goal" },
  })
  await input.fill("My gaol is to contienu the reasearch")
  await composer.getByRole("button", { name: "Send", exact: true }).click()
  const body = await posted()
  expect(body).toContain("My goal is to continue the reasearch")
})

test("send exactly as written explicitly bypasses opt-in corrections", async ({ page }) => {
  const { input, composer, posted } = await prepare(page, { promptAutocorrection: true })
  await input.fill("contienu the reasearch")
  await composer.locator('[data-slot="prompt-send-group"]').hover()
  await composer.locator('[data-action="prompt-send-options"]').click({ position: { x: 10, y: 2 } })
  await page.getByRole("menuitem", { name: "Send exactly as written" }).click()
  const body = await posted()
  expect(body).toContain("contienu the reasearch")
})

test("optional review lists only protected-safe word changes and sends the approved correction", async ({ page }) => {
  const { input, composer, posted } = await prepare(page, { promptAutocorrection: true })
  await input.fill('Please contienu the reasearch while preserving "contienu".')
  await composer.locator('[data-slot="prompt-send-group"]').hover()
  await composer.locator('[data-action="prompt-send-options"]').click({ position: { x: 10, y: 2 } })
  await page.getByRole("menuitem", { name: "Review spelling changes…" }).click()

  const review = page.getByRole("dialog", { name: "Review spelling corrections" })
  await expect(review).toBeVisible()
  await expect(review.locator('[data-action="prompt-correction-review-entry"]')).toHaveCount(2)
  await expect(review.getByText("contienu", { exact: true })).toHaveCount(1)
  await expect(review.getByText("reasearch", { exact: true })).toHaveCount(1)
  await review.getByRole("button", { name: "Cancel" }).click()
  await expect(review).not.toBeVisible()
  await expect(input).toContainText("Please contienu the reasearch")

  const options = composer.locator('[data-action="prompt-send-options"]')
  await options.focus()
  await page.keyboard.press("Enter")
  await page.getByRole("menuitem", { name: "Review spelling changes…" }).click()
  await page.locator('[data-action="prompt-correction-review-send"]').click()
  const body = await posted()
  expect(body).toContain('Please continue the research while preserving')
  expect(JSON.stringify(JSON.parse(body))).toContain("contienu")
})

test("review accepts a selected subset and leaves rejected typos untouched", async ({ page }) => {
  const { input, composer, posted } = await prepare(page, { promptAutocorrection: true })
  await input.fill("contienu the reasearch")
  const trigger = composer.locator('[data-action="prompt-send-options"]')
  await trigger.focus()
  await page.keyboard.press("Enter")
  await page.getByRole("menuitem", { name: "Review spelling changes…" }).click()
  const review = page.getByRole("dialog", { name: "Review spelling corrections" })
  const items = review.locator('[data-action="prompt-correction-review-entry"]')
  await expect(items).toHaveCount(2)
  const sendSelected = review.locator('[data-action="prompt-correction-review-send"]')
  await review.locator('[data-action="prompt-correction-review-select-none"]').click()
  await expect(review.getByText("0 of 2 changes selected")).toBeVisible()
  await expect(sendSelected).toBeDisabled()
  await review.locator('[data-action="prompt-correction-review-select-all"]').click()
  await expect(review.getByText("2 of 2 changes selected")).toBeVisible()
  await expect(sendSelected).toBeEnabled()
  await items.nth(1).locator('[data-slot="checkbox-v2-control"]').click()
  await expect(review.getByText("1 of 2 changes selected")).toBeVisible()
  await review.locator('[data-action="prompt-correction-review-send"]').click()
  const body = await posted()
  expect(body).toContain("continue the reasearch")
  expect(body).not.toContain("continue the research")
})

test("failed selected-correction admission restores the original full draft", async ({ page }) => {
  const { input, composer } = await prepare(page, { promptAutocorrection: true })
  let attempts = 0
  await page.route("**/session/" + sessionID + "/prompt_async", async (route) => {
    attempts++
    await route.fulfill({ status: 500, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ error: "synthetic-review-admission-failure" }) })
  })
  const original = "contienu the reasearch"
  await input.fill(original)
  const trigger = composer.locator('[data-action="prompt-send-options"]')
  await trigger.focus()
  await page.keyboard.press("Enter")
  await page.getByRole("menuitem", { name: "Review spelling changes…" }).click()
  const review = page.getByRole("dialog", { name: "Review spelling corrections" })
  await review.locator('[data-action="prompt-correction-review-entry"]').nth(1)
    .locator('[data-slot="checkbox-v2-control"]').click()
  await review.locator('[data-action="prompt-correction-review-send"]').click()
  await expect.poll(() => attempts).toBe(1)
  await expect(input).toHaveText(original)
})

test("review can explicitly submit the original without applying a single spelling change", async ({ page }) => {
  const { input, composer, posted } = await prepare(page, { promptAutocorrection: true })
  await input.fill("contienu the reasearch")
  await composer.locator('[data-slot="prompt-send-group"]').hover()
  await composer.locator('[data-action="prompt-send-options"]').click({ position: { x: 10, y: 2 } })
  await page.getByRole("menuitem", { name: "Review spelling changes…" }).click()
  await page.locator('[data-action="prompt-correction-review-send-exact"]').click()
  expect(await posted()).toContain("contienu the reasearch")
})

test("optional review of a clean draft makes no mutation and opens no dialog", async ({ page }) => {
  const { input, composer } = await prepare(page, { promptAutocorrection: true })
  const authored = "Inspect the renderer and report the measured results."
  await input.fill(authored)
  const trigger = composer.locator('[data-action="prompt-send-options"]')
  await trigger.focus()
  await page.keyboard.press("Enter")
  await page.getByRole("menuitem", { name: "Review spelling changes…" }).click()
  const review = page.getByRole("dialog", { name: "Review spelling corrections" })
  await expect(review).toBeVisible()
  await expect(review.getByText("No eligible spelling changes in this draft.")).toBeVisible()
  await expect(review.locator('[data-action="prompt-correction-review-entry"]')).toHaveCount(0)
  await expect(review.locator('[data-action="prompt-correction-review-send"]')).toHaveCount(0)
  await review.getByRole("button", { name: "Cancel" }).click()
  await expect(input).toHaveText(authored)
})

test("protected slash-command drafts show explicit correction bypass instead of a false clean bill", async ({ page }) => {
  const { input, composer } = await prepare(page, { promptAutocorrection: true })
  const authored = "/review contienu the reasearch"
  await input.fill(authored)
  const trigger = composer.locator('[data-action="prompt-send-options"]')
  await trigger.focus()
  await page.keyboard.press("Enter")
  await page.getByRole("menuitem", { name: "Review spelling changes…" }).click()
  const review = page.getByRole("dialog", { name: "Review spelling corrections" })
  await expect(review).toBeVisible()
  await expect(review.getByText("This draft is protected or outside the correction limits.", { exact: false })).toBeVisible()
  await expect(review.locator('[data-action="prompt-correction-review-send"]')).toHaveCount(0)
  await review.getByRole("button", { name: "Cancel" }).click()
  await expect(input).toHaveText(authored)
})

test("review is keyboard-accessible and Escape preserves the unsent draft", async ({ page }) => {
  const { input, composer } = await prepare(page, { promptAutocorrection: true })
  const authored = "contienu the reasearch"
  await input.fill(authored)
  const trigger = composer.locator('[data-action="prompt-send-options"]')
  await trigger.focus()
  await page.keyboard.press("Enter")
  const item = page.getByRole("menuitem", { name: "Review spelling changes…" })
  await item.focus()
  await page.keyboard.press("Enter")
  const review = page.getByRole("dialog", { name: "Review spelling corrections" })
  await expect(review).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(review).not.toBeVisible()
  await expect(input).toHaveText(authored)
})

test("keyboard-activated Send exactly as written preserves the authored prompt", async ({ page }) => {
  const { input, composer, posted } = await prepare(page, { promptAutocorrection: true })
  await input.fill("contienu the reasearch")
  const trigger = composer.locator('[data-action="prompt-send-options"]')
  await trigger.focus()
  await page.keyboard.press("Enter")
  const item = page.getByRole("menuitem", { name: "Send exactly as written" })
  await expect(item).toBeVisible()
  await item.focus()
  await page.keyboard.press("Enter")
  expect(await posted()).toContain("contienu the reasearch")
})

test("inline literals, quoted code and unsafe structured references are never autocorrected", async ({ page }) => {
  const { input, composer, posted } = await prepare(page, { promptAutocorrection: true })
  const authored = 'Please contienu, but preserve ' + String.fromCharCode(96) + 'contienu' +
    String.fromCharCode(96) + ', "contienu", C:\\\\tools\\\\contienu.ts and --contienu.'
  await input.fill(authored)
  await composer.getByRole("button", { name: "Send", exact: true }).click()
  const body: unknown = JSON.parse(await posted())
  if (!body || typeof body !== "object" || !("parts" in body) || !Array.isArray(body.parts))
    throw new Error("Invalid mock prompt request")
  const text = body.parts.flatMap((part: unknown) => {
    if (!part || typeof part !== "object" || !("type" in part) || !("text" in part)) return []
    return part.type === "text" && typeof part.text === "string" ? [part.text] : []
  })[0] ?? ""
  expect(text).toContain("Please continue, but preserve")
  expect(text).toContain('"contienu"')
  expect(text).toContain("--contienu")
  expect(text).not.toContain("Please contienu")
})

test("slash commands never undergo dictionary mutation", async ({ page }) => {
  const { input, composer, posted } = await prepare(page, { promptAutocorrection: true })
  await input.fill("/review contienu the reasearch")
  await composer.getByRole("button", { name: "Send", exact: true }).click()
  expect(await posted()).toContain("/review contienu the reasearch")
})

test("rejected API admission restores the exact authored draft, not corrected output", async ({ page }) => {
  const { input, composer } = await prepare(page, { promptAutocorrection: true })
  let attempts = 0
  await page.route("**/session/" + sessionID + "/prompt_async", async (route) => {
    attempts++
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ error: "synthetic-admission-failure" }),
    })
  })
  const authored = "contienu the reasearch"
  await input.fill(authored)
  await composer.getByRole("button", { name: "Send", exact: true }).click()
  await expect.poll(() => attempts).toBe(1)
  await expect(input).toHaveText(authored)
})

test("Harper settings are separately opt-in and personal dictionary survives reload", async ({ page }) => {
  await prepare(page, {})
  await page.keyboard.press("Control+,")
  const settings = page.getByRole("tabpanel", { name: "General" })
  await expect(settings).toBeVisible()
  const switcher = settings.locator('[data-action="settings-prompt-grammar-harper"]')
  await expect(switcher.getByRole("switch")).toHaveAttribute("aria-checked", "false")
  await switcher.locator('[data-slot="switch-control"]').click()
  await expect(switcher.getByRole("switch")).toHaveAttribute("aria-checked", "true")
  const auto = settings.locator('[data-action="settings-prompt-grammar-autofix"]')
  await expect(auto.getByRole("switch")).toHaveAttribute("aria-checked", "false")
  await auto.locator('[data-slot="switch-control"]').click()
  await expect(auto.getByRole("switch")).toHaveAttribute("aria-checked", "true")
  const dictionary = settings.locator('[data-action="settings-prompt-grammar-ignored"]')
  await expect(dictionary).toBeVisible()
  await dictionary.fill("OpenFork, Nacre, Silica, openfork")
  await dictionary.press("Tab")
  await expect(dictionary).toHaveValue("openfork, nacre, silica")
  await expect(settings.locator('[data-action="settings-prompt-autocorrection"]').getByRole("switch"))
    .toHaveAttribute("aria-checked", "false")
  await page.reload()
  await expect(settings).toBeVisible()
  await expect(switcher.getByRole("switch")).toHaveAttribute("aria-checked", "true")
  await expect(auto.getByRole("switch")).toHaveAttribute("aria-checked", "true")
  await expect(dictionary).toHaveValue("openfork, nacre, silica")
  await switcher.locator('[data-slot="switch-control"]').click()
  await expect(switcher.getByRole("switch")).toHaveAttribute("aria-checked", "false")
  await expect(dictionary).not.toBeVisible()
  await expect(auto).not.toBeVisible()
})

test("General Settings toggle, personal rules and exclusions persist across reload", async ({ page }) => {
  const { composer } = await prepare(page, {})
  await page.keyboard.press("Control+,")
  const dialog = page.getByRole("tabpanel", { name: "General" })
  await expect(dialog).toBeVisible()
  const toggle = dialog.locator('[data-action="settings-prompt-autocorrection"]').getByRole("switch")
  await expect(toggle).toHaveAttribute("aria-checked", "false")
  await dialog.locator('[data-action="settings-prompt-autocorrection"] [data-slot="switch-control"]').click()
  await expect(toggle).toHaveAttribute("aria-checked", "true")
  const ignore = dialog.locator('[data-action="settings-prompt-autocorrection-ignore"]')
  const personal = dialog.locator('[data-action="settings-prompt-autocorrection-custom"]')
  await expect(ignore).toBeVisible()
  await ignore.fill("reasearch")
  await ignore.press("Tab")
  // Safety-critical mappings must not be stored as though they were active.
  await personal.fill("gaol=goal, approve=reject, public=private")
  await personal.press("Tab")
  await expect(personal).toHaveValue("gaol=goal")
  await expect.poll(async () => {
    const raw = await page.evaluate(() => localStorage.getItem("settings.v3"))
    const value: unknown = JSON.parse(raw ?? "{}")
    const general = value && typeof value === "object" && "general" in value &&
      value.general && typeof value.general === "object" ? value.general : {}
    return JSON.stringify({
      enabled: "promptAutocorrection" in general ? general.promptAutocorrection : undefined,
      excluded: "promptAutocorrectionIgnore" in general ? general.promptAutocorrectionIgnore : undefined,
      custom: "promptAutocorrectionCustom" in general ? general.promptAutocorrectionCustom : undefined,
    })
  }).toBe(JSON.stringify({ enabled: true, excluded: ["reasearch"], custom: { gaol: "goal" } }))

  await page.reload()
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-action="settings-prompt-autocorrection"]').getByRole("switch"))
    .toHaveAttribute("aria-checked", "true")
  await expect(dialog.locator('[data-action="settings-prompt-autocorrection-ignore"]')).toHaveValue("reasearch")
  await expect(dialog.locator('[data-action="settings-prompt-autocorrection-custom"]')).toHaveValue("gaol=goal")
  await page.getByRole("button", { name: "Back to app" }).click()
  await expectAppVisible(composer)
})
})
