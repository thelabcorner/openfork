import { expect, test } from "@playwright/test"
import { assistantMessage, partUpdated, setupTimeline, textPart, userMessage } from "./fixture"

test("streamed TypeScript syntax highlighting preserves code and the enclosing timeline row", async ({ page }) => {
  const id = "prt_markdown_syntax_stream"
  const initial = "```ts\nconst alpha: number = 1;\n"
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart(id, initial)], { completed: false })],
    reducedMotion: true,
  })
  const row = page.locator(`[data-timeline-part-id="${id}"]`)
  const code = row.locator('[data-component="markdown-code"] code').first()
  await expect(code).toContainText("alpha")
  await row.evaluate((element) => { element.dataset.syntaxStableRow = "true" })

  const updates = [
    initial + "const beta = alpha + 2;\n",
    initial + "const beta = alpha + 2;\nconsole.log(beta);\n",
    initial + "const beta = alpha + 2;\nconsole.log(beta);\n```",
  ]
  for (const text of updates) {
    await timeline.send(partUpdated(textPart(id, text)), 150)
  }
  await expect(code).toContainText("console.log(beta)")
  await expect(row).toHaveAttribute("data-syntax-stable-row", "true")
  await expect.poll(async () => code.locator("span").count()).toBeGreaterThan(0)
  const content = await code.textContent()
  expect(content).toContain("const alpha: number = 1;")
  expect(content).toContain("const beta = alpha + 2;")
  expect(content).toContain("console.log(beta);")
  expect(content).not.toContain("```")
})

test("completed Markdown code preserves its parser-normalized Shiki content in the DOM", async ({ page }) => {
  const id = "prt_markdown_crlf_fidelity"
  const source = "const a: string = '🍒';\r\n\r\nconsole.log(a);\nconst b = 42;\r\n"
  const body = "```typescript\r\n" + source + "```"
  await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart(id, body)])],
    reducedMotion: true,
  })
  const code = page.locator(`[data-timeline-part-id="${id}"] [data-component="markdown-code"] code`).first()
  await expect(code).toContainText("const b = 42")
  await expect.poll(async () => code.locator("span").count()).toBeGreaterThan(0)
  // Marked lexes fenced Markdown with normalized LF and strips the terminal
  // code-fence separator before Shiki ever sees the text. Shiki itself retains
  // exact input CRLF (tested separately); this DOM check must respect Marked's
  // documented parser boundary rather than incorrectly asserting raw source.
  expect(await code.textContent()).toBe(source.replace(/\r\n/g, "\n").replace(/\n$/, ""))
})

test("Shiki completion retains unchanged code token DOM spans", async ({ page }) => {
  const id = "prt_shiki_completion_spans"
  const initial = "```typescript\nconst stable = 1;\nconst mutable = stable + 2;"
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart(id, initial)], { completed: false })],
    reducedMotion: true,
  })
  const block = page.locator(`[data-timeline-part-id="${id}"] [data-markdown-block]`).first()
  const code = block.locator("code").first()
  const first = code.locator("span").first()
  await expect(first).toContainText("const")
  await first.evaluate((node) => { ;(window as any).__initialShikiSpan = node })
  await timeline.send(partUpdated(textPart(id, initial + "\n```")), 180)
  await expect(block).toHaveAttribute("data-markdown-complete", "true")
  await expect(code).toContainText("const mutable = stable + 2;")
  expect(await first.evaluate((node) => node === (window as any).__initialShikiSpan)).toBe(true)
})
