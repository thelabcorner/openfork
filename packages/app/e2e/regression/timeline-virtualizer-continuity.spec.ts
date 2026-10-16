import { expect, test } from "@playwright/test"
import { assistantMessage, partUpdated, setupTimeline, shell, toolPart, userMessage } from "../performance/timeline-stability/fixture"

test("Shell command is present synchronously when the completed tool body mounts", async ({ page }) => {
  const command = "Get-ChildItem -Recurse | Select-String 'virtualizer'"
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart("prt_shell_command_continuity", "shell", "completed", { command }, {
          title: command,
          output: "Found matching files",
          metadata: { command },
        }),
      ]),
    ],
    settings: { shellToolPartsExpanded: true },
    waitForConnection: false,
    reducedMotion: true,
  })
  const commandCode = page.locator('[data-slot="bash-command-code"] pre code')
  await expect(commandCode).toHaveText(command)
  await expect(page.locator('[data-slot="bash-pre"]')).toContainText("Found matching files")
})

test("streaming topology changes never empty the virtual transcript or jump a manually scrolled window", async ({ page }) => {
  const partID = "prt_streaming_shell_continuity"
  const command = "Get-ChildItem -Recurse"
  const fixture = await setupTimeline(page, {
    seedHistory: true,
    messages: [userMessage(), assistantMessage([shell(partID, "running", "initial output", command)], { completed: false })],
    settings: { shellToolPartsExpanded: true },
    reducedMotion: true,
  })
  const viewport = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-key]") })
  await viewport.hover()
  await page.mouse.wheel(0, -1800)
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  const stateBefore = await viewport.evaluate((root) => {
    const rect = root.getBoundingClientRect()
    const first = [...root.querySelectorAll<HTMLElement>("[data-timeline-key]")].find((row) => {
      const box = row.getBoundingClientRect()
      return box.bottom > rect.top + 30 && box.top < rect.bottom - 30
    })
    return { key: first?.dataset.timelineKey, top: first?.getBoundingClientRect().top, scrollTop: root.scrollTop }
  })
  expect(stateBefore.key).toBeTruthy()
  const samples = page.evaluate(async () => {
    let blanks = 0
    let frames = 0
    for (let index = 0; index < 100; index++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      frames++
      const root = document.querySelector<HTMLElement>(".scroll-view__viewport [data-timeline-virtual-content]") ??
        document.querySelector<HTMLElement>("[data-timeline-virtual-content]")
      if (root && !root.querySelector("[data-timeline-key]")) blanks++
    }
    return { blanks, frames }
  })
  await fixture.send(partUpdated({
    ...shell(partID, "completed", "final output", command),
    sessionID: "ses_timeline_stability",
    messageID: "msg_1001_timeline_assistant",
  }))
  const observed = await samples
  expect(observed.frames).toBe(100)
  expect(observed.blanks).toBe(0)
  const stateAfter = await viewport.evaluate((root, key) => {
    const row = [...root.querySelectorAll<HTMLElement>("[data-timeline-key]")].find((item) => item.dataset.timelineKey === key)
    return { top: row?.getBoundingClientRect().top, scrollTop: root.scrollTop }
  }, stateBefore.key)
  expect(stateAfter.top).toBeDefined()
  expect(Math.abs((stateAfter.top ?? 0) - (stateBefore.top ?? 0))).toBeLessThan(32)
})

test("timeline never paints an empty row window while a Shell card resizes", async ({ page }) => {
  const command = "Get-ChildItem | Select-String 'snapshot'"
  await setupTimeline(page, {
    seedHistory: true,
    messages: [
      userMessage(),
      assistantMessage([
        toolPart("prt_shell_window_continuity", "shell", "completed", { command }, {
          title: command,
          output: Array.from({ length: 150 }, (_, index) => `stdout line ${index}`).join("\n"),
          metadata: { command },
        }),
      ]),
    ],
    settings: { shellToolPartsExpanded: false },
    waitForConnection: false,
    reducedMotion: true,
  })
  const card = page.locator('[data-timeline-part-id="prt_shell_window_continuity"]')
  const trigger = card.locator('[data-slot="collapsible-trigger"]')
  await expect(trigger).toBeVisible()
  const frames = page.evaluate(async () => {
    let blank = 0
    for (let i = 0; i < 70; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const content = document.querySelector("[data-timeline-virtual-content]")
      if (content && !content.querySelector("[data-timeline-key]")) blank++
    }
    return blank
  })
  await trigger.click()
  await expect(card.locator('[data-slot="bash-command-code"] pre code')).toHaveText(command)
  await page.setViewportSize({ width: 1100, height: 850 })
  expect(await frames).toBe(0)
})
