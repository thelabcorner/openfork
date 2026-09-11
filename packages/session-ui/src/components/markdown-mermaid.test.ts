import { describe, expect, test } from "bun:test"
import {
  isMermaidLanguage,
  pngExportDimensions,
  rebaseSvgIdList,
  rebaseSvgReferenceText,
  sanitizeCssUrls,
  viewBoxDimensions,
} from "./markdown-mermaid"

describe("markdown mermaid", () => {
  test("recognizes standard Mermaid fence names without catching unrelated languages", () => {
    expect(isMermaidLanguage("mermaid")).toBe(true)
    expect(isMermaidLanguage("Mermaid")).toBe(true)
    expect(isMermaidLanguage("mmd")).toBe(true)
    expect(isMermaidLanguage("mermaid title=architecture")).toBe(true)
    expect(isMermaidLanguage("markdown")).toBe(false)
    expect(isMermaidLanguage("mermaid-js")).toBe(false)
    expect(isMermaidLanguage(undefined)).toBe(false)
  })

  test("reads positive Mermaid SVG viewBox geometry", () => {
    expect(viewBoxDimensions("0 0 812.5 244")).toEqual({ width: 812.5, height: 244 })
    expect(viewBoxDimensions("0,0,320,180")).toEqual({ width: 320, height: 180 })
    expect(viewBoxDimensions("0 0 0 180")).toBeUndefined()
    expect(viewBoxDimensions("not a viewbox")).toBeUndefined()
  })

  test("sizes PNG exports at high density while bounding canvas memory", () => {
    expect(pngExportDimensions(800, 400, 1)).toEqual({ width: 1600, height: 800, scale: 2 })
    expect(pngExportDimensions(800, 400, 3)).toEqual({ width: 2400, height: 1200, scale: 3 })
    const huge = pngExportDimensions(10_000, 10_000, 3)
    expect(huge.width).toBeLessThanOrEqual(8192)
    expect(huge.height).toBeLessThanOrEqual(8192)
    expect(huge.width * huge.height).toBeLessThanOrEqual(24_000_000)
  })

  test("preserves local SVG fragment urls and strips external CSS fetches", () => {
    expect(sanitizeCssUrls("marker-end:url(#arrow); filter: url('#shadow')")).toBe(
      "marker-end:url(#arrow); filter: url(#shadow)",
    )
    expect(sanitizeCssUrls("fill:url(https://example.com/a.svg);stroke:red")).toBe("fill:none;stroke:red")
    expect(sanitizeCssUrls("@import url(https://example.com/x.css); color:red")).toBe(" color:red")
  })

  test("rebases Mermaid CSS selectors and local SVG references together", () => {
    const ids = new Map([
      ["oc-mermaid-7", "oc-mermaid-mounted-2-1"],
      ["arrowhead", "oc-mermaid-mounted-2-2"],
    ])
    expect(
      rebaseSvgReferenceText(
        "#oc-mermaid-7 .node{fill:#181818;marker-end:url(#arrowhead)} href=#arrowhead aria-labelledby=oc-mermaid-7",
        ids,
      ),
    ).toBe(
      "#oc-mermaid-mounted-2-1 .node{fill:#181818;marker-end:url(#oc-mermaid-mounted-2-2)} href=#oc-mermaid-mounted-2-2 aria-labelledby=oc-mermaid-7",
    )
    expect(rebaseSvgIdList("oc-mermaid-7 arrowhead untouched", ids)).toBe(
      "oc-mermaid-mounted-2-1 oc-mermaid-mounted-2-2 untouched",
    )
  })
})
