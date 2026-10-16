import { expect, test } from "@playwright/test"
import { assistantMessage, messageUpdated, partDelta, partUpdated, setupTimeline, textPart, userMessage } from "./fixture"

test("provider bursts hydrate one stable Markdown DOM without blank frames or duplicated text", async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as any).__streamBlockTrace = []
    ;(window as any).__opencodeMarkdownTraceEnabled = () => true
    ;(window as any).__opencodeMarkdownTrace = (entry: { phase: string; action?: string; mode?: string }) => {
      if (entry.phase === "block" && entry.mode === "live") (window as any).__streamBlockTrace.push(entry.action)
    }
  })
  const id = "prt_paced_hydration_01"
  const initial = "Warm start."
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart(id, initial)], { completed: false })],
    reducedMotion: true,
    cpuRate: 4,
  })
  const wrapper = page.locator(`[data-timeline-part-id="${id}"]`)
  const markdown = wrapper.locator('[data-component="markdown"]')
  await expect(markdown).toContainText(initial)
  await markdown.evaluate((element) => {
    ;(window as any).__opencodeMarkdownTraceEnabled = () => true
    ;(window as any).__opencodeMarkdownTrace = (entry: { phase: string; action?: string; mode?: string }) => {
      if (entry.phase === "block") (window as any).__streamBlockTrace.push(`${entry.mode}:${entry.action}`)
    }
    ;(window as any).__streamSamples = [element.textContent]
    ;(window as any).__streamRoot = element
    const observer = new MutationObserver(() => {
      const samples = (window as any).__streamSamples as string[]
      const value = element.textContent ?? ""
      if (samples.at(-1) !== value) samples.push(value)
    })
    observer.observe(element, { childList: true, characterData: true, subtree: true })
    ;(window as any).__streamObserver = observer
  })
  const body = initial + " " + Array.from({ length: 260 }, (_, index) => `word${index}`).join(" ")
  for (const limit of [32, 80, 160, 260]) {
    const next = initial + " " + Array.from({ length: limit }, (_, index) => `word${index}`).join(" ")
    await timeline.send(partUpdated(textPart(id, next)), 44)
  }
  await expect(markdown).toContainText("word259", { timeout: 15_000 })
  const result = await markdown.evaluate((element) => {
    ;(window as any).__streamObserver?.disconnect()
    return {
      sameNode: (window as any).__streamRoot === element,
      samples: (window as any).__streamSamples as string[],
      final: element.textContent,
    }
  })
  expect(result.sameNode).toBe(true)
  // The Markdown paragraph boundary contributes one terminal DOM newline;
  // strip that presentation separator, not a source character.
  const logical = (value: string | null) => (value ?? "").replace(/\n$/, "")
  expect(logical(result.final)).toBe(body)
  expect(result.samples.every((value) => typeof value === "string" && body.startsWith(logical(value)) && logical(value).length >= initial.length)).toBe(true)
  // Coalescing must avoid producing one complete Markdown commit per SSE token.
  expect(result.samples.length).toBeLessThan(80)
  const actions = await page.evaluate(() => (window as any).__streamBlockTrace as string[])
  expect(actions, "Plain text streaming should bypass DOM morph on proven literal appends").toContain("live:plain-paragraph-append")
})

test("a multi-kilobyte provider burst catches up without a long fake typewriter animation", async ({ page }) => {
  const id = "prt_paced_hydration_bulk"
  const initial = "Streaming"
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart(id, initial)], { completed: false })],
    reducedMotion: true,
  })
  const root = page.locator(`[data-timeline-part-id="${id}"] [data-component="markdown"]`)
  await expect(root).toContainText(initial)
  const bulk = initial + " " + "burst-content ".repeat(400)
  const started = Date.now()
  await timeline.send(partUpdated(textPart(id, bulk)))
  await expect(root).toContainText("burst-content", { timeout: 15_000 })
  await expect.poll(async () => (await root.textContent())?.replace(/\n$/, "").length ?? 0, { timeout: 15_000 }).toBe(bulk.length)
  const elapsedMs = Date.now() - started
  expect(elapsedMs).toBeLessThan(8_000)
})

test("streamed prose switches to structural Markdown when an inline link completes", async ({ page }) => {
  const id = "prt_paced_structural"
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart(id, "Read ")], { completed: false })],
    reducedMotion: true,
  })
  const root = page.locator(`[data-timeline-part-id="${id}"] [data-component="markdown"]`)
  await expect(root).toContainText("Read")
  for (const source of ["Read [", "Read [docs", "Read [docs](https://example.org)", "Read [docs](https://example.org) now"])
    await timeline.send(partUpdated(textPart(id, source)), 75)
  await expect(root.locator('a[href="https://example.org"]')).toHaveText("docs")
  await expect(root).toContainText("now")
  expect(await root.locator("a").count()).toBe(1)
})

test("turn completion flushes unfinished pacing without replaying a stale suffix", async ({ page }) => {
  const id = "prt_paced_completion"
  const assistant = assistantMessage([textPart(id, "Begin")], { completed: false })
  const timeline = await setupTimeline(page, { messages: [userMessage(), assistant], reducedMotion: true })
  const root = page.locator(`[data-timeline-part-id="${id}"] [data-component="markdown"]`)
  await expect(root).toContainText("Begin")
  const finalText = "Begin " + "the final answer ".repeat(35) + "END"
  await timeline.send(partUpdated(textPart(id, finalText)))
  await timeline.send(messageUpdated({
    ...assistant.info,
    time: { ...assistant.info.time, completed: 1700000005000 },
  }))
  await expect(root).toContainText("END", { timeout: 15_000 })
  expect((await root.textContent())?.replace(/\n$/, "")).toBe(finalText)
})

test("real token-delta SSE appends preserve exact text without duplicate hydration", async ({ page }) => {
  const id = "prt_paced_sse_delta"
  const start = "Tokens:"
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart(id, start)], { completed: false })],
    reducedMotion: true,
  })
  const root = page.locator(`[data-timeline-part-id="${id}"] [data-component="markdown"]`)
  await expect(root).toContainText(start)
  await root.evaluate((node) => {
    node.setAttribute("data-stable-hydration", "1")
    const host = window as any
    host.__deltaSnapshots = [node.textContent ?? ""]
    host.__deltaObserver = new MutationObserver(() => {
      const content = node.textContent ?? ""
      if (host.__deltaSnapshots.at(-1) !== content) host.__deltaSnapshots.push(content)
    })
    host.__deltaObserver.observe(node, { characterData: true, childList: true, subtree: true })
  })
  const tokens = Array.from({ length: 64 }, (_, index) => ` t${index}`)
  for (const token of tokens) await timeline.send(partDelta(id, token), 4)
  const expected = start + tokens.join("")
  await expect.poll(async () => (await root.textContent())?.replace(/\n$/, ""), { timeout: 15_000 }).toBe(expected)
  await expect(root).toHaveAttribute("data-stable-hydration", "1")
  const snapshots = await root.evaluate(() => {
    const host = window as any
    host.__deltaObserver.disconnect()
    return host.__deltaSnapshots as string[]
  })
  expect(snapshots.every((value) => expected.startsWith(value.replace(/\n$/, "")))).toBe(true)
  expect(snapshots.length, "64 SSE tokens should cause fewer than 64 DOM publications").toBeLessThan(64)
})
