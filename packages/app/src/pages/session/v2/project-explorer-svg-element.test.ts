import { describe, expect, test } from "bun:test"
import { projectExplorerSvgElement } from "./project-explorer-svg-viewer"

describe("projectExplorerSvgElement", () => {
  test("keeps valid SVG content and presentation attributes", () => {
    const root = projectExplorerSvgElement(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
      <rect x="1" y="1" width="8" height="8" fill="#ff0000" stroke="blue" stroke-width="0.5" />
    </svg>`)
    expect(root.tagName).toBe("svg")
    expect(root.querySelector("rect")?.getAttribute("fill")).toBe("#ff0000")
    expect(root.querySelector("rect")?.getAttribute("stroke")).toBe("blue")
  })

  test("keeps embedded <style> (inert CSS) but strips <script>", () => {
    const root = projectExplorerSvgElement(
      `<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:red}</style><script>alert(1)</script><rect width="10" height="10"/></svg>`,
    )
    expect(root.querySelector("script")).toBeNull()
    expect(root.querySelector("style")).not.toBeNull()
    expect(root.querySelector("rect")).not.toBeNull()
  })

  test("strips event handler attributes", () => {
    const root = projectExplorerSvgElement(
      `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10" onclick="evil()"/></svg>`,
    )
    expect(root.getAttribute("onload")).toBeNull()
    expect(root.querySelector("rect")?.getAttribute("onclick")).toBeNull()
  })

  test("strips javascript: URLs but keeps http links", () => {
    const root = projectExplorerSvgElement(
      `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"/><a href="https://example.com"/></svg>`,
    )
    expect(root.querySelector("a[href]")?.getAttribute("href")).toBe("https://example.com")
  })

  test("strips data: URLs on links but keeps them on image resources", () => {
    const root = projectExplorerSvgElement(
      `<svg xmlns="http://www.w3.org/2000/svg"><a href="data:text/html,&lt;script&gt;x&lt;/script&gt;"/><image href="data:image/png;base64,AAAA"/></svg>`,
    )
    expect(root.querySelector("a")?.getAttribute("href")).toBeNull()
    expect(root.querySelector("image")?.getAttribute("href")).toBe("data:image/png;base64,AAAA")
  })

  test("removes foreignObject (potential HTML/script container)", () => {
    const root = projectExplorerSvgElement(
      `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe></foreignObject><rect width="10" height="10"/></svg>`,
    )
    expect(root.querySelector("foreignObject")).toBeNull()
    expect(root.querySelector("iframe")).toBeNull()
    expect(root.querySelector("rect")).not.toBeNull()
  })

  test("synthesizes a viewBox from numeric width/height and fills the container", () => {
    const root = projectExplorerSvgElement(
      `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600"/></svg>`,
    )
    expect(root.getAttribute("viewBox")).toBe("0 0 800 600")
    expect(root.getAttribute("style")).toContain("100%")
  })

  test("falls back to 300x150 viewBox when the root has no size", () => {
    const root = projectExplorerSvgElement(
      `<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="4"/></svg>`,
    )
    expect(root.getAttribute("viewBox")).toBe("0 0 300 150")
  })

  test("falls back to an escaped <pre> for non-SVG or empty input", () => {
    const root = projectExplorerSvgElement("not svg at all")
    expect(root.tagName).toBe("PRE")
    expect(root.textContent).toBe("not svg at all")
  })

  test("falls back to an escaped <pre> for empty content", () => {
    const root = projectExplorerSvgElement("")
    expect(root.tagName).toBe("PRE")
  })
})
