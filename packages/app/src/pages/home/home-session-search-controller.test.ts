import { describe, expect, test } from "bun:test"
import { normalizeSessionSearchResponse } from "./home-session-search-response"

const result = {
  titleMatches: [],
  messageMatches: [
    {
      sessionID: "session-1",
      messageID: "message-1",
      sessionTitle: "Searchable session",
      directory: "/tmp/project",
      projectID: "project-1",
      time: { created: 1 },
      type: "text",
      snippet: "matching text",
      matchedTerms: ["matching"],
    },
  ],
}

describe("normalizeSessionSearchResponse", () => {
  test("accepts an already unwrapped search result", () => {
    expect(normalizeSessionSearchResponse(result)).toEqual(result)
  })

  test("accepts the app client response shape", () => {
    expect(normalizeSessionSearchResponse({ data: result })).toEqual(result)
  })

  test("accepts the protocol response shape", () => {
    expect(normalizeSessionSearchResponse({ data: { data: result } })).toEqual(result)
  })

  test("falls back to an empty result for malformed responses", () => {
    expect(normalizeSessionSearchResponse({ data: {} })).toEqual({ titleMatches: [], messageMatches: [] })
  })
})
