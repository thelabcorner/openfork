import { expect, test, type Page } from "@playwright/test"
import {
  defineVisualRegions,
  reportVisualStability,
  startVisualProbe,
  stopVisualProbe,
  visualPlan,
} from "../../utils/visual-stability"
import {
  assistantMessage,
  directory,
  sessionID,
  setupTimeline,
  shell,
  textPart,
  toolPart,
  userMessage,
  waitForVisualSettle,
} from "./fixture"

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZkKsAAAAASUVORK5CYII="

async function installVisualPreviewHost(page: Page) {
  await page.evaluate((png) => {
    const binary = atob(png)
    const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0))
    const calls: Array<{ context: unknown; input: unknown }> = []
    ;(window as any).__snapeyePreviewCalls = calls
    const api = (window as any).api ?? {}
    ;(window as any).api = {
      ...api,
      browser: {
        ...(api.browser ?? {}),
        visualArtifactPreview: async (context: unknown, input: any) => {
          calls.push({ context, input })
          const path =
            input.source === "baseline"
              ? `.snapeye/baselines/${input.name}.png`
              : `.snapeye/runs/${input.runId}/${input.artifact}.png`
          return {
            descriptor: {
              kind: input.source === "baseline" ? "baseline" : input.artifact,
              path,
              mime: "image/png",
              byteLength: bytes.byteLength,
            },
            bytes,
            sha256: "a".repeat(64),
          }
        },
      },
    }
  }, ONE_PIXEL_PNG)
}

test("surfaces browser screenshots outside collapsed tool details with premium visual controls", async ({ page }) => {
  const screenshotID = "prt_interaction_visual_screenshot"
  const followingID = "prt_interaction_visual_following"
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          screenshotID,
          "browser",
          "completed",
          { action: "call", operation: "screenshot", args: {} },
          {
            output: "captured image/png screenshot",
            metadata: {
              browserAction: "call",
              operation: "screenshot",
              delegatedTool: "browser_screenshot",
              op: "screenshot",
              mime: "image/png",
              data: ONE_PIXEL_PNG,
              width: 1440,
              height: 900,
            },
          },
        ),
        textPart(followingID, "Following visual verification"),
      ]),
    ],
    cpuRate: 4,
    seedHistory: true,
    // Static completed history is sufficient for this visual-control test.
    // The worktree's current SSE harness is independently failing to observe
    // its backend connection even in untouched interaction tests.
    waitForConnection: false,
  })

  const part = page.locator(`[data-timeline-part-id="${screenshotID}"]`)
  const trigger = part.locator('[data-slot="collapsible-trigger"]')
  const visual = part.locator('[data-component="tool-visual-media"]')
  const visualShell = part.locator('[data-component="tool-visual-media-shell"]')
  const visualRow = part.locator('xpath=ancestor::*[@data-timeline-row="AssistantPart"]')
  await waitForVisualSettle(page, [`[data-timeline-part-id="${screenshotID}"]`])

  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await expect(visual).toBeVisible()
  await expect(visual.locator("img")).toBeVisible()
  await expect(part).toContainText("1440×900")
  const collapsedShell = await visualShell.boundingBox()
  const collapsedRow = await visualRow.boundingBox()
  expect(collapsedShell).not.toBeNull()
  expect(collapsedRow).not.toBeNull()

  await visual.getByRole("button", { name: "Zoom in" }).click()
  await expect(visual.getByRole("button", { name: "Reset zoom" })).toContainText("125%")

  await visual.getByRole("button", { name: "Expand visual" }).click()
  await expect(visual).toHaveAttribute("data-expanded", "true")
  const expandedShell = await visualShell.boundingBox()
  const expandedRow = await visualRow.boundingBox()
  expect(Math.abs((expandedShell?.height ?? 0) - (collapsedShell?.height ?? 0))).toBeLessThanOrEqual(1)
  expect(Math.abs((expandedRow?.height ?? 0) - (collapsedRow?.height ?? 0))).toBeLessThanOrEqual(1)
  expect(Math.abs((expandedRow?.y ?? 0) - (collapsedRow?.y ?? 0))).toBeLessThanOrEqual(1)
  await page.keyboard.press("Escape")
  await expect(visual).not.toHaveAttribute("data-expanded", "true")
  await expect(visual.getByRole("button", { name: "Reset zoom" })).toContainText("100%")
})

test("surfaces SnapEye diff artifacts through the session-scoped lazy preview resolver", async ({ page }) => {
  const diffID = "prt_interaction_snapeye_diff"
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          diffID,
          "browser_visual_diff",
          "completed",
          { name: "settings" },
          {
            output: "SnapEye settings: changed (1.2500%, 3 regions)",
            metadata: {
              op: "visual_diff",
              runId: "run_snapeye_1",
              status: "ok",
              name: "settings",
              image: { pixelWidth: 1440, pixelHeight: 900 },
              diff: { changed: true, changedRatio: 0.0125, regionCount: 3, regionsTruncated: false },
              artifacts: {
                baseline: "../../baselines/settings.png",
                current: "current.png",
                diff: "diff.png",
              },
            },
          },
        ),
      ]),
    ],
    cpuRate: 4,
    // Static completed history is enough to validate projection + lazy preview
    // routing; the current worktree's SSE harness is independently unable to
    // observe its mock-backend connection in this suite.
    waitForConnection: false,
  })

  const part = page.locator(`[data-timeline-part-id="${diffID}"]`)
  const trigger = part.locator('[data-slot="collapsible-trigger"]')
  const visual = part.locator('[data-component="tool-visual-media"]')
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await expect(visual).toBeVisible()
  await expect(visual.getByRole("tab", { name: "Diff" })).toHaveAttribute("aria-selected", "true")
  await expect(part).toContainText("Changed")

  // Web fixtures intentionally have no Electron bridge. Install only the
  // bounded preview capability after normal app bootstrap, then select a new
  // source so the card resolves through the exact same app-owned adapter used
  // by Desktop.
  await installVisualPreviewHost(page)
  await visual.getByRole("tab", { name: "Current" }).click()
  await expect(visual.locator("img")).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__snapeyePreviewCalls?.length ?? 0)).toBe(1)
  await visual.getByRole("tab", { name: "Diff" }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__snapeyePreviewCalls?.length ?? 0)).toBe(2)
  await visual.getByRole("tab", { name: "Baseline" }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__snapeyePreviewCalls?.length ?? 0)).toBe(3)

  const calls = await page.evaluate(() => (window as any).__snapeyePreviewCalls)
  expect(calls.map((call: any) => call.context)).toEqual([
    { sessionId: sessionID, directory },
    { sessionId: sessionID, directory },
    { sessionId: sessionID, directory },
  ])
  expect(calls.map((call: any) => call.input)).toEqual([
    { source: "run", runId: "run_snapeye_1", artifact: "current" },
    { source: "run", runId: "run_snapeye_1", artifact: "diff" },
    { source: "baseline", name: "settings" },
  ])
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
})

test("expands and collapses a long completed shell without overlap", async ({ page }, testInfo) => {
  const shellID = "prt_interaction_01_shell"
  const followingID = "prt_interaction_02_following"
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([shell(shellID, "completed", lines(50)), textPart(followingID, "Following shell expansion")]),
    ],
    settings: { shellToolPartsExpanded: false },
    cpuRate: 4,
    seedHistory: true,
  })
  const trigger = page.locator(`[data-timeline-part-id="${shellID}"] [data-slot="collapsible-trigger"]`)
  await waitForVisualSettle(page, [`[data-timeline-part-id="${shellID}"]`, `[data-timeline-part-id="${followingID}"]`])
  const regions = defineVisualRegions({
    shell: { selector: `[data-timeline-part-id="${shellID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  const plan = visualPlan(regions, [
    { type: "required", regions: ["shell", "following"] },
    { type: "unique", regions: ["shell", "following"] },
    { type: "stable", regions: ["shell", "following"] },
    { type: "opacity", regions: "all" },
    { type: "continuity", regions: "all" },
    { type: "motion", regions: "all", maxPositionReversals: 0 },
    { type: "label-stability", regions: "all" },
    { type: "preserve-bottom-anchor" },
    { type: "flow", regions: ["shell", "following"] },
  ])
  await startVisualProbe(page, regions)
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await page.waitForTimeout(500)
  const expanded = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(testInfo, "shell-expand", expanded, plan)

  await startVisualProbe(page, regions)
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await page.waitForTimeout(500)
  const collapsed = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(testInfo, "shell-collapse", collapsed, plan)
})

test("expands and collapses a completed context group without overlap", async ({ page }, testInfo) => {
  const ids = [
    "prt_interaction_01_read",
    "prt_interaction_02_glob",
    "prt_interaction_03_grep",
    "prt_interaction_04_list",
  ]
  const group = `[data-timeline-part-ids="${ids.join(",")}"]`
  const followingID = "prt_interaction_context_following"
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(ids[0]!, "read", "completed", { filePath: "src/a.ts" }),
        toolPart(ids[1]!, "glob", "completed", { path: ".", pattern: "**/*.ts" }),
        toolPart(ids[2]!, "grep", "completed", { path: ".", pattern: "stable" }),
        toolPart(ids[3]!, "list", "completed", { path: "src" }),
        textPart(followingID, "Following context expansion"),
      ]),
    ],
    cpuRate: 4,
    seedHistory: true,
  })
  const trigger = page.locator(`${group} [data-slot="collapsible-trigger"]`)
  await waitForVisualSettle(page, [group, `[data-timeline-part-id="${followingID}"]`])
  for (const [name, expanded] of [
    ["context-expand", true],
    ["context-collapse", false],
    ["context-reexpand", true],
  ] as const) {
    const regions = defineVisualRegions({
      context: { selector: group, closest: '[data-timeline-row="AssistantPart"]' },
      following: {
        selector: `[data-timeline-part-id="${followingID}"]`,
        closest: '[data-timeline-row="AssistantPart"]',
      },
    })
    await startVisualProbe(page, regions)
    await trigger.click()
    await expect(trigger).toHaveAttribute("aria-expanded", String(expanded))
    await page.waitForTimeout(500)
    const trace = await stopVisualProbe<keyof typeof regions>(page)
    await reportVisualStability(
      testInfo,
      name,
      trace,
      visualPlan(regions, [
        { type: "required", regions: ["context", "following"] },
        { type: "unique", regions: ["context", "following"] },
        { type: "stable", regions: ["context", "following"] },
        { type: "opacity", regions: "all" },
        { type: "continuity", regions: "all" },
        { type: "motion", regions: "all", maxPositionReversals: 0 },
        { type: "label-stability", regions: "all" },
        { type: "preserve-bottom-anchor" },
        { type: "flow", regions: ["context", "following"] },
      ]),
    )
  }
})

test("expands and collapses an edit diff without moving twice", async ({ page }, testInfo) => {
  const editID = "prt_interaction_edit"
  const followingID = "prt_interaction_edit_following"
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          editID,
          "edit",
          "completed",
          { filePath: "src/edit.ts" },
          {
            metadata: {
              filediff: {
                file: "src/edit.ts",
                additions: 40,
                deletions: 40,
                before: source(40, false),
                after: source(40, true),
              },
            },
          },
        ),
        textPart(followingID, "Following edit expansion"),
      ]),
    ],
    settings: { editToolPartsExpanded: false },
    cpuRate: 4,
    seedHistory: true,
  })
  const trigger = page.locator(`[data-timeline-part-id="${editID}"] [data-slot="collapsible-trigger"]`).first()
  await waitForVisualSettle(page, [`[data-timeline-part-id="${editID}"]`, `[data-timeline-part-id="${followingID}"]`])
  const regions = defineVisualRegions({
    edit: { selector: `[data-timeline-part-id="${editID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await startVisualProbe(page, regions)
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await page.waitForTimeout(900)
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(
    testInfo,
    "edit-expand",
    trace,
    visualPlan(regions, [
      { type: "required", regions: ["edit", "following"] },
      { type: "unique", regions: ["edit", "following"] },
      { type: "stable", regions: ["edit", "following"] },
      { type: "opacity", regions: "all" },
      { type: "continuity", regions: "all" },
      { type: "motion", regions: "all", maxPositionReversals: 0, maxReversals: 1 },
      { type: "label-stability", regions: "all" },
      { type: "preserve-bottom-anchor" },
      { type: "flow", regions: ["edit", "following"] },
    ]),
  )
})

test("shows all and expands historical diff summary without overlap", async ({ page }, testInfo) => {
  const firstUser = userMessage(undefined, {
    summary: {
      diffs: Array.from({ length: 12 }, (_, index) => ({
        file: `src/diff-${index}.ts`,
        additions: 1,
        deletions: 1,
        patch: `@@ -1 +1 @@\n-export const value = ${index}\n+export const value = ${index + 1}`,
      })),
    },
  })
  const nextUserID = "msg_2000_diff_interaction_user"
  await setupTimeline(page, {
    messages: [
      firstUser,
      assistantMessage(),
      userMessage(undefined, { id: nextUserID, created: 1700000010000 }),
      assistantMessage([], {
        id: "msg_2001_diff_interaction_assistant",
        parentID: nextUserID,
        created: 1700000011000,
      }),
    ],
    cpuRate: 4,
  })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  await scroller.evaluate((element) => (element.scrollTop = 0))
  const diff = page.locator('[data-timeline-row="DiffSummary"]')
  const following = page.locator(`[data-message-id="${nextUserID}"]`).first()
  await expect(diff).toBeVisible()
  const regions = defineVisualRegions({
    diff: { selector: '[data-timeline-row="DiffSummary"]' },
    following: { selector: `[data-message-id="${nextUserID}"]` },
  })
  await startVisualProbe(page, regions)
  await page.getByText(/show all/i).click()
  await page.waitForTimeout(500)
  await diff.locator('[data-slot="session-turn-diff-trigger"]').first().click()
  await page.waitForTimeout(900)
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(
    testInfo,
    "diff-summary-expand",
    trace,
    visualPlan(regions, [
      { type: "required", regions: ["diff", "following"] },
      { type: "unique", regions: ["diff", "following"] },
      { type: "stable", regions: ["diff", "following"] },
      { type: "opacity", regions: "all" },
      { type: "continuity", regions: "all" },
      { type: "motion", regions: "all", maxPositionReversals: 1, maxReversals: 2 },
      { type: "label-stability", regions: "all" },
      { type: "flow", regions: ["diff", "following"] },
    ]),
  )
})

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")
}

function source(count: number, changed: boolean) {
  return Array.from(
    { length: count },
    (_, index) => `export const value${index} = ${changed ? index + 1 : index}\n`,
  ).join("")
}
