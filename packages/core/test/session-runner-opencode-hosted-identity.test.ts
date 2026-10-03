import { describe, expect, test } from "bun:test"
import { providerRequestHeaders } from "../src/session/runner/llm"
import { OpenCodeHostedUserAgent } from "../src/installation/version"

describe("V2 SessionRunner OpenCode hosted identity", () => {
  test("uses hosted OpenCode identity for opencode providers", () => {
    const headers = providerRequestHeaders({
      providerID: "opencode",
      projectID: "prj_test",
      sessionID: "ses_test",
      requestID: "msg_test",
      parentSessionID: "ses_parent",
      client: "desktop",
    })

    expect(headers).toEqual({
      "x-opencode-project": "prj_test",
      "x-opencode-session": "ses_test",
      "x-opencode-request": "msg_test",
      "x-opencode-client": "desktop",
      "User-Agent": OpenCodeHostedUserAgent(),
      "x-parent-session-id": "ses_parent",
    })
    expect(headers).not.toHaveProperty("x-session-affinity")
    expect(headers).not.toHaveProperty("X-Session-Id")
  })

  test("covers opencode provider variants such as opencode-go", () => {
    const headers = providerRequestHeaders({
      providerID: "opencode-go",
      projectID: "prj_test",
      sessionID: "ses_test",
      requestID: "msg_test",
      client: "cli",
    })

    expect(headers["User-Agent"]).toBe(OpenCodeHostedUserAgent())
    expect(headers["x-opencode-session"]).toBe("ses_test")
  })

  test("preserves generic affinity identity for non-OpenCode providers", () => {
    const headers = providerRequestHeaders({
      providerID: "anthropic",
      projectID: "prj_test",
      sessionID: "ses_test",
      requestID: "msg_test",
      parentSessionID: "ses_parent",
      client: "desktop",
    })

    expect(headers).toEqual({
      "x-session-affinity": "ses_test",
      "X-Session-Id": "ses_test",
      "x-parent-session-id": "ses_parent",
    })
    expect(headers).not.toHaveProperty("User-Agent")
    expect(headers).not.toHaveProperty("x-opencode-project")
  })
})
