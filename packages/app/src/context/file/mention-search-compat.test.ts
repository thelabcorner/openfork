import { describe, expect, test } from "bun:test"
import { mentionSearchEndpointUnavailable } from "./mention-search-compat"

describe("mentionSearchEndpointUnavailable", () => {
  test("recognizes compatibility responses across SDK error shapes", () => {
    expect(mentionSearchEndpointUnavailable({ status: 404 })).toBe(true)
    expect(mentionSearchEndpointUnavailable({ response: { status: 405 } })).toBe(true)
    expect(mentionSearchEndpointUnavailable(new Error("missing", { cause: { status: 404 } }))).toBe(true)
  })

  test("does not permanently downgrade on transient failures", () => {
    expect(mentionSearchEndpointUnavailable({ status: 500 })).toBe(false)
    expect(mentionSearchEndpointUnavailable({ response: { status: 503 } })).toBe(false)
    expect(mentionSearchEndpointUnavailable(new Error("network"))).toBe(false)
    expect(mentionSearchEndpointUnavailable(undefined)).toBe(false)
  })
})
