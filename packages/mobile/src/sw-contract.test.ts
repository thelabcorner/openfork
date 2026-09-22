import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("../public/sw.js", import.meta.url)).text()

describe("mobile service worker cache contract", () => {
  test("never intercepts cross-origin or credentialed requests", () => {
    expect(source).toContain("url.origin !== self.location.origin")
    expect(source).toContain('request.headers.has("authorization")')
  })

  test("only caches static shell destinations", () => {
    expect(source).toContain('["document", "script", "style", "font", "image", "manifest"]')
  })

  test("never caches no-store or private responses", () => {
    expect(source).toContain("no-store|private")
  })

  test("scopes notification navigation to the installed origin", () => {
    expect(source).toContain("candidate.origin === self.location.origin")
  })
})
