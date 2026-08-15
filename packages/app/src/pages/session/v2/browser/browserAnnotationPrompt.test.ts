import { describe, expect, test } from "bun:test"
import { buildBrowserAnnotationPrompt } from "./browserAnnotationPrompt"
import type { BrowserAnnotationResult } from "./browserHostClient"

function annotation(overrides: Partial<BrowserAnnotationResult> = {}): BrowserAnnotationResult {
  return {
    id: "annotation-1",
    pageUrl: "https://example.com",
    pageTitle: "Example",
    comment: "",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    submission: "attach",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("buildBrowserAnnotationPrompt", () => {
  test("wraps content in a browser_annotation block with page + targets summary", () => {
    const prompt = buildBrowserAnnotationPrompt(annotation())
    expect(prompt).toContain("<browser_annotation>")
    expect(prompt).toContain("Page: https://example.com (Example)")
    expect(prompt).toContain("Targets: no targets selected.")
    expect(prompt).toContain("</browser_annotation>")
  })

  test("includes the comment when present", () => {
    const prompt = buildBrowserAnnotationPrompt(annotation({ comment: "make this bigger" }))
    expect(prompt).toContain("Comment: make this bigger")
  })

  test("summarizes elements, regions, and strokes", () => {
    const prompt = buildBrowserAnnotationPrompt(
      annotation({
        elements: [
          {
            id: "el-1",
            tagName: "button",
            selector: "#save",
            htmlPreview: "<button id=\"save\">Save</button>",
            componentName: null,
            source: null,
            styles: "color: red",
            rect: { x: 0, y: 0, width: 10, height: 10 },
          },
        ],
        regions: [{ id: "r-1", rect: { x: 0, y: 0, width: 10, height: 10 } }],
        strokes: [{ id: "s-1", color: "#f97316", width: 3, points: [], bounds: { x: 0, y: 0, width: 10, height: 10 } }],
      }),
    )
    expect(prompt).toContain("Targets: 1 selected element, 1 marked region, 1 drawing.")
    expect(prompt).toContain("<element_context>")
    expect(prompt).toContain("<button>")
    expect(prompt).toContain("selector: #save")
    expect(prompt).toContain("styles:")
    expect(prompt).toContain("</element_context>")
  })

  test("prefers componentName and source location over tagName/selector when available", () => {
    const prompt = buildBrowserAnnotationPrompt(
      annotation({
        elements: [
          {
            id: "el-1",
            tagName: "button",
            selector: "#save",
            htmlPreview: "<button>Save</button>",
            componentName: "SaveButton",
            source: { file: "src/SaveButton.tsx", line: 12, column: 3 },
            styles: "",
            rect: { x: 0, y: 0, width: 10, height: 10 },
          },
        ],
      }),
    )
    expect(prompt).toContain("<SaveButton> (src/SaveButton.tsx:12)")
    expect(prompt).toContain("source: src/SaveButton.tsx:12:3")
  })

  test("lists requested style changes as before -> after", () => {
    const prompt = buildBrowserAnnotationPrompt(
      annotation({
        styleChanges: [{ targetId: "el-1", selector: "#save", property: "border-radius", previousValue: "4px", value: "12px" }],
      }),
    )
    expect(prompt).toContain("Requested visual changes:")
    expect(prompt).toContain("- border-radius: 4px → 12px")
  })

  test("notes the attached screenshot only when one exists", () => {
    const withShot = buildBrowserAnnotationPrompt(
      annotation({ screenshot: { mime: "image/png", dataUrl: "data:image/png;base64,", width: 10, height: 10 } }),
    )
    expect(withShot).toContain("The attached screenshot is the annotated preview crop.")

    const withoutShot = buildBrowserAnnotationPrompt(annotation())
    expect(withoutShot).not.toContain("attached screenshot")
  })

  test("omits <element_context> entirely when no elements were selected", () => {
    const prompt = buildBrowserAnnotationPrompt(annotation({ regions: [{ id: "r-1", rect: { x: 0, y: 0, width: 10, height: 10 } }] }))
    expect(prompt).not.toContain("<element_context>")
  })
})
