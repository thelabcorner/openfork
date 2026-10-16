import assert from "node:assert/strict"
import { resolve } from "node:path"
import { chromium } from "@playwright/test"

// Execute with: cd packages/app && bun scripts/verify-browser-annotation.ts
// Opt-in real-Chromium guest DOM regression: deliberately does not run in
// ordinary Bun unit suites that lack the Playwright browser installation.
const guestPath = resolve(import.meta.dir, "../../desktop/src/guest/annotation-overlay.ts")
const bundle = await Bun.build({
  entrypoints: [guestPath],
  target: "browser",
  format: "iife",
  minify: false,
  plugins: [{
    name: "mock-electron-ipc",
    setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "mock" }))
      build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
        contents: "export const ipcRenderer = globalThis.__annotationIpc;",
        loader: "js",
      }))
    },
  }],
})
assert.equal(bundle.success, true, bundle.logs.map(String).join("\n"))
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1050, height: 800 } })
  await page.setContent([
    '<!doctype html><html><head><style>',
    'body{margin:0;height:2000px;background:#fff}',
    '#site{position:absolute;top:190px;left:110px;width:240px;height:60px}',
    '#shadow-site{position:absolute;top:360px;left:110px}',
    '</style></head><body>',
    '<button id="site"><span id="decorative">Click me</span></button>',
    '<div id="shadow-site"></div>',
    '<a href="#changed" id="link" style="position:absolute;top:520px;left:110px">Do not navigate</a>',
    '</body></html>',
  ].join(""))
  await page.evaluate(() => {
    const w = window as any
    w.__siteClicks = 0
    w.__siteWheel = 0
    document.getElementById("site")!.addEventListener("click", () => w.__siteClicks++)
    const innerRoot = document.getElementById("shadow-site")!.attachShadow({ mode: "open" })
    innerRoot.innerHTML = '<button id="inner" style="width:240px;height:60px"><span>Shadow target</span></button>'
    innerRoot.getElementById("inner")!.addEventListener("click", () => w.__siteClicks++)
    document.addEventListener("wheel", () => w.__siteWheel++)

    // Test instrumentation only: retain a reference to the CLOSED annotation
    // root without changing its mode or exposing that root in production.
    const attach = Element.prototype.attachShadow
    Element.prototype.attachShadow = function (options) {
      const root = attach.call(this, options)
      if (this.hasAttribute("data-openfork-annotation-ui")) w.__annotationRoot = root
      return root
    }
    const handlers = new Map<string, Array<(...args: any[]) => void>>()
    w.__annotationPayload = null
    w.__annotationIpc = {
      on(name: string, fn: (...args: any[]) => void) {
        handlers.set(name, [...(handlers.get(name) ?? []), fn])
      },
      send(name: string, payload: any) {
        if (name === "preview:element-picked") w.__annotationPayload = payload
      },
    }
    w.__startAnnotation = () => {
      for (const fn of handlers.get("preview:start-pick") ?? []) fn({})
    }
    w.__setAnnotationTheme = (name: string) => {
      for (const fn of handlers.get("preview:annotation-theme") ?? []) fn({}, name)
    }
  })
  await page.addScriptTag({ content: await bundle.outputs[0]!.text() })
  await page.evaluate(() => (window as any).__startAnnotation())
  assert.equal(await page.evaluate(() => !!(window as any).__annotationRoot), true, "guest overlay mounted")

  async function click(selector: string) {
    const rect = await page.locator(selector).boundingBox()
    assert.ok(rect, "missing " + selector)
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2)
  }
  await click("#site")
  await page.waitForTimeout(70)
  assert.equal(await page.evaluate(() => (window as any).__siteClicks), 0, "no page click passthrough")
  assert.equal(await page.evaluate(() => (window as any).__annotationRoot.querySelectorAll(".box.selected").length), 1)

  const toolbar = await page.evaluate(() => {
    const node = (window as any).__annotationRoot.querySelector('button[data-tool="draw"]') as HTMLButtonElement
    const r = node.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await page.mouse.click(toolbar.x, toolbar.y)
  await page.waitForTimeout(20)
  assert.equal(await page.evaluate(() => (window as any).__annotationRoot.querySelector('button[data-tool="draw"]').getAttribute("aria-pressed")), "true")
  assert.equal(await page.evaluate(() => (window as any).__annotationRoot.querySelectorAll(".box.selected").length), 1, "cannot select own toolbar")

  // Reactivate select using the actual physical toolbar, then select a
  // component inside OPEN Shadow DOM. The payload must carry host boundaries.
  const select = await page.evaluate(() => {
    const r = (window as any).__annotationRoot.querySelector('button[data-tool="select"]').getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await page.mouse.click(select.x, select.y)
  await click("#shadow-site #inner").catch(async () => {
    const rect = await page.locator("#shadow-site").locator("#inner").boundingBox()
    assert.ok(rect)
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2)
  })
  assert.equal(await page.evaluate(() => (window as any).__siteClicks), 0, "no shadow target click passthrough")

  const attach = await page.evaluate(() => {
    const r = (window as any).__annotationRoot.querySelector(".comment-bar button:not(.primary)").getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await page.mouse.click(attach.x, attach.y)
  await page.waitForFunction(() => !!(window as any).__annotationPayload)
  const payload = await page.evaluate(() => (window as any).__annotationPayload)
  assert.ok(payload.elements.length > 0)
  assert.ok(payload.elements.some((entry: { selector: string }) => entry.selector.includes(">>> #inner")), "open-shadow selector maintains host boundary")
  assert.ok(payload.elements.every((entry: { selector: string }) => !entry.selector.includes("openfork-annotation-ui")), "never captures annotation chrome")

  const computed = await page.evaluate(() => {
    const toolbar = (window as any).__annotationRoot.querySelector(".toolbar")
    return getComputedStyle(toolbar).backgroundColor
  })
  assert.notEqual(computed, "rgb(249, 115, 22)", "zinc toolbar must not use orange")
  console.log("Annotation guest Chromium checks PASSED: shield, native toolbar, shadow DOM, payload isolation, zinc")
} finally {
  await browser.close()
}
