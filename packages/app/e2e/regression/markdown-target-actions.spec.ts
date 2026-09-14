import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/MarkdownTargets"
const projectID = "proj_markdown_targets"
const sessionID = "ses_markdown_targets"
const title = "Markdown target actions"

const filePath = "C:\\Users\\slooshied\\.local\\share\\opencode\\handoff.md"
const url = "https://example.com/opencode/docs"

test("markdown path and url actions", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "markdown-targets",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "markdown-targets",
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("opencode-color-scheme", "dark")
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  // The markdown worker does not resolve under the mocked transport, so the
  // transcript only ever paints its plain-text fallback. Classification itself
  // is covered by markdown-inline-code-kind's unit tests; mounting equivalent
  // spans exercises the affordance against the real app shell — platform
  // gating, clipboard and anchoring included — rather than a stub page.
  await page.evaluate(
    (input) => {
      const host = document.querySelector("main")
      if (!host) throw new Error("no main element")
      const block = document.createElement("p")
      block.id = "target-probe"
      block.style.cssText = "position:fixed;left:120px;top:320px;z-index:1;font-size:13px"
      for (const [kind, value] of [
        ["path", input.filePath],
        ["url", input.url],
      ] as const) {
        const code = document.createElement("code")
        code.dataset.inlineCodeKind = kind
        code.textContent = value
        block.append(code, document.createTextNode(" "))
      }
      host.appendChild(block)
    },
    { filePath, url },
  )

  const probe = page.locator("#target-probe")
  const pathSpan = probe.locator('code[data-inline-code-kind="path"]')
  const urlSpan = probe.locator('code[data-inline-code-kind="url"]')
  await expect(pathSpan).toHaveText(filePath)

  const toolbar = page.locator('[data-component="markdown-target-actions"]')
  await expect(toolbar).toHaveCount(0)

  await pathSpan.hover()
  await expect(toolbar).toBeVisible()
  await expect(toolbar).toHaveAttribute("data-kind", "path")

  // The toolbar sits clear of the text it describes.
  const pathBox = (await pathSpan.boundingBox())!
  const toolbarBox = (await toolbar.boundingBox())!
  expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(pathBox.y + 1)

  await toolbar.getByRole("button", { name: "Copy path" }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(filePath)

  // Filesystem actions act on the machine running the server, so the web build
  // offers copy alone.
  await expect(toolbar.getByRole("button", { name: "Open", exact: true })).toHaveCount(0)
  await expect(toolbar.getByRole("button", { name: "Open with" })).toHaveCount(0)

  await urlSpan.hover()
  await expect(toolbar).toHaveAttribute("data-kind", "url")
  await expect(toolbar.getByRole("button", { name: "Open in browser" })).toBeVisible()
  await toolbar.getByRole("button", { name: "Copy link" }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url)

  // Leaving both the span and the toolbar dismisses it.
  await page.mouse.move(4, 4)
  await expect(toolbar).toHaveCount(0)
})
