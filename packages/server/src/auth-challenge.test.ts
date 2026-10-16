import { describe, expect, test } from "bun:test"
import { authChallenge, isApiRequestPath, isDocumentNavigation } from "./auth-challenge"

const basic = 'Basic realm="Secure Area"'
const bearer = 'Bearer realm="OpenFork"'

describe("authChallenge", () => {
  test("never selects Basic for API requests, independent of Origin", () => {
    expect(authChallenge({ apiRequest: true })).toBe(bearer)
    expect(authChallenge({ apiRequest: true, documentNavigation: true })).toBe(bearer)
  })

  test("reserves Basic for explicit document navigation outside API routes", () => {
    const navigation = isDocumentNavigation({
      method: "GET",
      destination: "document",
      mode: "navigate",
      accept: "text/html,application/xhtml+xml",
    })

    expect(navigation).toBe(true)
    expect(authChallenge({ apiRequest: false, documentNavigation: navigation })).toBe(basic)
    expect(authChallenge({ apiRequest: true, documentNavigation: navigation })).toBe(bearer)
  })

  test("fetches and preflights are not document navigations", () => {
    expect(isDocumentNavigation({ method: "GET", accept: "application/json" })).toBe(false)
    expect(isDocumentNavigation({ method: "GET", destination: "empty", mode: "cors", accept: "*/*" })).toBe(false)
    expect(
      isDocumentNavigation({
        method: "OPTIONS",
        destination: "document",
        mode: "navigate",
        accept: "text/html",
      }),
    ).toBe(false)
    expect(authChallenge({ apiRequest: false })).toBe(bearer)
  })

  test("recognizes V1 and V2 API paths in the raw fallback router", () => {
    for (const path of ["/api/probe", "/session", "/global/health", "/pair/begin", "/config/providers"]) {
      expect(isApiRequestPath(path)).toBe(true)
    }
    expect(isApiRequestPath("/")).toBe(false)
    expect(isApiRequestPath("/settings")).toBe(false)
    expect(isApiRequestPath("/assets/app.js")).toBe(false)
  })
})
