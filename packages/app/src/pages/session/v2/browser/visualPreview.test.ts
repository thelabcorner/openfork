import { describe, expect, test } from "bun:test"
import { VisualPreviewCache, decodeVisualJson } from "./visualPreview"
import type { VisualArtifactPreview } from "./browserHostClient"

const preview = (mime = "image/png", bytes = new Uint8Array([1, 2, 3])): VisualArtifactPreview => ({
  descriptor: { kind: "current", path: ".snapeye/runs/run1/current.png", mime, byteLength: bytes.byteLength },
  bytes,
  sha256: "a".repeat(64),
})

describe("VisualPreviewCache", () => {
  test("replacement and teardown revoke every renderer blob URL exactly once", () => {
    const created: string[] = []
    const revoked: string[] = []
    const cache = new VisualPreviewCache({
      create: () => {
        const url = `blob:visual-${created.length + 1}`
        created.push(url)
        return url
      },
      revoke: (url) => revoked.push(url),
    })

    expect(cache.replace("current", preview())).toBe("blob:visual-1")
    expect(cache.replace("current", preview())).toBe("blob:visual-2")
    expect(revoked).toEqual(["blob:visual-1"])
    expect(cache.replace("diff", preview("video/webm"))).toBeNull()
    expect(cache.size).toBe(1)

    cache.clearAll()
    expect(revoked).toEqual(["blob:visual-1", "blob:visual-2"])
    expect(cache.size).toBe(0)
    cache.clearAll()
    expect(revoked).toHaveLength(2)
  })

  test("JSON decoding is bounded to JSON previews and fails closed", () => {
    const bytes = new TextEncoder().encode('{"changed":true}')
    expect(decodeVisualJson(preview("application/json", bytes))).toEqual({ changed: true })
    expect(decodeVisualJson(preview("application/json", new TextEncoder().encode("{")))).toBeNull()
    expect(decodeVisualJson(preview("image/png", bytes))).toBeNull()
  })
})
