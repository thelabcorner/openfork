import { expect, test } from "@playwright/test"
import {
  defineVisualRegions,
  reportVisualStability,
  startVisualProbe,
  stopVisualProbe,
  visualPlan,
} from "../../utils/visual-stability"
import {
  assistantMessage,
  historyMessages,
  partUpdated,
  shell,
  session,
  sessionID,
  setupTimeline,
  textPart,
  toolPart,
  userMessage,
} from "./fixture"

test("adds a task child-session link without replacing the task row", async ({ page }, testInfo) => {
  const taskID = "prt_task_link"
  const childID = "ses_task_child"
  const input = { description: "Inspect child", subagent_type: "explore" }
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([toolPart(taskID, "task", "running", input)], { completed: false })],
    sessions: [session(), session({ id: childID, parentID: sessionID, title: "Inspect child" })],
    cpuRate: 4,
  })
  const regions = defineVisualRegions({
    task: { selector: `[data-timeline-part-id="${taskID}"] [data-slot="collapsible-trigger"]` },
  })
  await startVisualProbe(page, regions)
  await timeline.send(
    partUpdated(toolPart(taskID, "task", "completed", input, { metadata: { sessionId: childID } })),
    500,
  )
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(
    testInfo,
    "task-link",
    trace,
    visualPlan(regions, [
      { type: "required", regions: ["task"] },
      { type: "unique", regions: ["task"] },
      { type: "stable", regions: ["task"] },
      { type: "opacity", regions: "all" },
      { type: "continuity", regions: "all" },
      { type: "motion", regions: "all", maxPositionReversals: 0 },
      { type: "label-stability", regions: "all" },
    ]),
  )
  await expect(
    // Task is now a dense BasicTool row, not the retired task-tool-card.
    // Assert the actual navigable task trigger, scoped to this part.
    page.locator(`[data-timeline-part-id="${taskID}"] a[data-slot="collapsible-trigger"][href$="/session/${childID}"]`),
  ).toBeVisible()
})

test("changes generic tool arguments without replacing the row", async ({ page }, testInfo) => {
  const toolID = "prt_generic_mutation"
  const followingID = "prt_generic_mutation_following"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage(
        [
          toolPart(toolID, "mcp_probe", "running", { target: "one", count: 1 }),
          textPart(followingID, "Following generic tool"),
        ],
        { completed: false },
      ),
    ],
    cpuRate: 4,
  })
  const regions = defineVisualRegions({
    tool: { selector: `[data-timeline-part-id="${toolID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await startVisualProbe(page, regions)
  await timeline.send(
    partUpdated(toolPart(toolID, "mcp_probe", "running", { target: "two", count: 2, mode: "deep" })),
    200,
  )
  await timeline.send(
    partUpdated(toolPart(toolID, "mcp_probe", "completed", { target: "two", count: 2, mode: "deep" })),
    400,
  )
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(
    testInfo,
    "generic-mutation",
    trace,
    visualPlan(
      regions,
      [
        { type: "required", regions: ["tool", "following"] },
        { type: "unique", regions: ["tool", "following"] },
        { type: "stable", regions: ["tool", "following"] },
        { type: "opacity", regions: "all" },
        { type: "continuity", regions: "all" },
        { type: "motion", regions: "all", maxPositionReversals: 0 },
        { type: "label-stability", regions: "all" },
        { type: "flow", regions: ["tool", "following"] },
      ],
      { perMarker: true },
    ),
  )
})

test("generic MCP output mounts lazily and preserves controlled expansion across virtualization", async ({ page }) => {
  const toolID = "prt_generic_lazy_virtual"
  const output = Array.from({ length: 1500 }, (_, index) => `trace line ${index}: useful tool output`).join("\n")
  await setupTimeline(page, {
    messages: [
      ...historyMessages(38),
      userMessage(),
      assistantMessage([toolPart(toolID, "mcp_performance_probe", "completed", { target: "source.ts" }, { output })]),
    ],
    waitForConnection: false,
    reducedMotion: true,
  })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  const wrapper = page.locator(`[data-timeline-part-id="${toolID}"]`)
  const trigger = wrapper.locator('[data-slot="collapsible-trigger"]')
  await expect(trigger).toBeVisible()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await expect(wrapper.locator('[data-component="tool-text"]')).toHaveCount(0)
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await expect(wrapper.locator('[data-component="tool-text"]')).toBeVisible()
  await scroller.evaluate((element) => (element.scrollTop = 0))
  await expect(wrapper).toHaveCount(0)
  await scroller.evaluate((element) => (element.scrollTop = element.scrollHeight))
  await expect(trigger).toBeVisible()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await expect(wrapper.locator('[data-component="tool-text"]')).toBeVisible()
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await expect(wrapper.locator('[data-component="tool-text"]')).toHaveCount(0)
})

test("expanded ANSI shell output reuses existing DOM spans as stream content grows", async ({ page }) => {
  const id = "prt_ansi_live_dom"
  const first = "\u001b[31mRED\u001b[0m baseline"
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([shell(id, "running", first)], { completed: false })],
    settings: { shellToolPartsExpanded: true },
    reducedMotion: true,
  })
  const output = page.locator(`[data-timeline-part-id="${id}"]`)
  const firstSegment = output.locator('[data-slot="shell-output-segment"]').first()
  await expect(firstSegment).toHaveText("RED")
  await firstSegment.evaluate((element) => {
    ;(window as any).__stableShellSegment = element
  })
  for (let index = 1; index <= 4; index++) {
    await timeline.send(partUpdated(shell(id, "running", first + ` appended-${index}`)), 140)
    await expect(output.locator('[data-slot="shell-output-segment"]').last()).toContainText(`appended-${index}`)
    const reused = await firstSegment.evaluate((element) => element === (window as any).__stableShellSegment)
    expect(reused, "Earlier ANSI segments must not remount when later output changes").toBe(true)
  }
})
