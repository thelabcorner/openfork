import { describe, expect, test } from "bun:test"
import { readToolVisualPresentation } from "./read-tool-visual-model"

describe("readToolVisualPresentation", () => {
  test.each(["image/png", "image/jpeg", "image/gif", "image/webp"])("projects %s attachment as visual", (mime) => {
    const url = `data:${mime};base64,AAECAw==`
    const result = readToolVisualPresentation(
      { filePath: "C:\\frames\\frame_001.jpg" },
      { preview: "Image read successfully" },
      [{ type: "file", mime, url }],
    )
    expect(result).toMatchObject({
      kind: "read",
      origin: "file",
      name: "frame_001.jpg",
      sources: [{ inline: { mime, url } }],
    })
  })

  test("rejects unrelated attachments, remote URLs, and mismatched MIME headers", () => {
    const input = { filePath: "secret.png" }
    expect(
      readToolVisualPresentation(input, {}, [{ type: "file", mime: "image/png", url: "https://remote/image.png" }]),
    ).toBeUndefined()
    expect(
      readToolVisualPresentation(input, {}, [{ type: "file", mime: "image/png", url: "data:text/html;base64,AAAA" }]),
    ).toBeUndefined()
    expect(
      readToolVisualPresentation(input, {}, [
        { type: "file", mime: "application/pdf", url: "data:application/pdf;base64,AAAA" },
      ]),
    ).toBeUndefined()
    expect(
      readToolVisualPresentation(input, {}, [
        { type: "file", mime: "image/svg+xml", url: "data:image/svg+xml;base64,AAAA" },
      ]),
    ).toBeUndefined()
  })

  test("renders a complete SVG read without altering the source text", () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><text>∆ Ω &amp; test</text></svg>'
    const display = {
      type: "file",
      path: "icons/logo.svg",
      text: source,
      lineStart: 1,
      lineEnd: 1,
      totalLines: 1,
      truncated: false,
    }
    const result = readToolVisualPresentation({}, { display, action: "read" }, [])
    expect(result?.kind).toBe("read")
    expect(result?.sources[0]?.inline?.url).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`)
    expect(display.text).toBe(source)
  })

  test("accepts minimal and UTF-8 SVG documents while keeping source previews inert", () => {
    const display = {
      type: "file",
      path: "C:\\icons\\shape.SVG",
      text: "<svg/>",
      lineStart: 1,
      lineEnd: 1,
      totalLines: 1,
      truncated: false,
    }
    expect(readToolVisualPresentation({}, { action: "read", display }, [])?.sources[0]?.inline?.url).toBe(
      "data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E",
    )
  })

  test("reuses frame data URL rather than copying or decoding bytes on projection", () => {
    const payload = "A".repeat(2_000_000)
    const url = `data:image/png;base64,${payload}`
    const result = readToolVisualPresentation({ filePath: "frame_030.png" }, {}, [
      { type: "file", mime: "image/png", url },
    ])
    expect(result?.sources[0]?.inline?.url).toBe(url)
  })

  test("never previews a partial SVG or non-read window", () => {
    const display = {
      type: "file",
      path: "logo.SVG",
      text: "<svg/>",
      lineStart: 1,
      lineEnd: 1,
      totalLines: 2,
      truncated: false,
    }
    expect(readToolVisualPresentation({}, { display, action: "read" }, [])).toBeUndefined()
    expect(
      readToolVisualPresentation({}, { display: { ...display, lineEnd: 2, truncated: true }, action: "read" }, []),
    ).toBeUndefined()
    expect(
      readToolVisualPresentation({}, { display: { ...display, lineStart: 2, lineEnd: 2 }, action: "tail" }, []),
    ).toBeUndefined()
    expect(
      readToolVisualPresentation({}, { display: { ...display, lineEnd: 2 }, action: "around" }, []),
    ).toBeUndefined()
  })
})
