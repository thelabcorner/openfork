import { describe, expect, test } from "bun:test"
import { readToolPlayableMedia } from "./read-tool-playable-model"

describe("Read media presentation", () => {
  for (const [mime, kind] of [
    ["video/mp4", "video"], ["video/webm", "video"], ["video/quicktime", "video"],
    ["audio/wav", "audio"], ["audio/mpeg", "audio"], ["audio/mp4", "audio"],
  ] as const) {
    test(`detects ${mime} and reuses the existing data URL without decoding`, () => {
      const url = `data:${mime};base64,AAECAw==`
      const result = readToolPlayableMedia({ filePath: "C:\\Videos\\capture.mp4" }, [
        { type: "file", mime, url },
      ])
      expect(result).toEqual({ kind, mime, url, name: "capture.mp4" })
      expect(result?.url).toBe(url)
    })
  }

  test("rejects remote links, HTML, MIME mismatch, and oversized embedded data", () => {
    const input = { filePath: "capture.mp4" }
    expect(readToolPlayableMedia(input, [{ type: "file", mime: "video/mp4", url: "https://remote/video.mp4" }])).toBeUndefined()
    expect(readToolPlayableMedia(input, [{ type: "file", mime: "video/mp4", url: "data:text/html;base64,AAEC" }])).toBeUndefined()
    expect(readToolPlayableMedia(input, [{ type: "file", mime: "image/svg+xml", url: "data:image/svg+xml;base64,AAEC" }])).toBeUndefined()
    expect(readToolPlayableMedia(input, [{ type: "file", mime: "video/mp4", url: "data:video/mp4;base64," }])).toBeUndefined()
    expect(readToolPlayableMedia(input, [{ type: "file", mime: "video/mp4", url: "data:video/mp4;base64," + "A".repeat(28 * 1024 * 1024) }])).toBeUndefined()
  })
})
