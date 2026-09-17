import { describe, expect, test } from "bun:test"
import { resolveWorkBuddyIdentity, workBuddyClientHeaders, workBuddyUserAgent } from "@/plugin/workbuddy-identity"
import {
  upstreamConversationHeaders,
  upstreamGetHeaders,
  upstreamHeaders,
  upstreamTraceHeaders,
} from "@/plugin/workbuddy"
import type { Credential } from "@/plugin/workbuddy-accounts"

function cred(overrides: Partial<Credential> = {}): Credential {
  return {
    path: "/tmp/workbuddy-test.json",
    accessToken: "TOKEN",
    refreshToken: "REFRESH",
    domain: "www.workbuddy.ai",
    uid: "uid-1",
    enterpriseId: "",
    expiresAt: 0,
    nickname: "test",
    ...overrides,
  }
}

describe("WorkBuddy first-party identity", () => {
  test("UA matches the official composition and never self-brands", () => {
    const ua = workBuddyUserAgent()
    expect(/^WorkBuddy\/\d+\.\d+\.\d+ WorkBuddy AI\/\d+\.\d+\.\d+ CLI\/\d+\.\d+\.\d+$/.test(ua)).toBe(true)
    expect(ua).not.toContain("codebuddy2openai")
  })

  test("static client headers reproduce the official application identity", () => {
    const identity = resolveWorkBuddyIdentity()
    const headers = workBuddyClientHeaders()
    expect(headers["X-Product"]).toBe("SaaS")
    expect(headers["X-IDE-Type"]).toBe(identity.platform)
    expect(headers["X-IDE-Name"]).toBe(identity.platform)
    expect(headers["X-IDE-Version"]).toBe(identity.appVersion)
  })

  test("upstream headers omit empty identity values and carry the official UA", () => {
    const headers = upstreamHeaders(cred())
    expect(headers.Authorization).toBe("Bearer TOKEN")
    expect(headers["X-User-Id"]).toBe("uid-1")
    // Negative invariant: empty enterprise/tenant headers were a gratuitous
    // anomaly the official client never sends.
    expect("X-Enterprise-Id" in headers).toBe(false)
    expect("X-Tenant-Id" in headers).toBe(false)
    expect(headers["User-Agent"]).not.toContain("codebuddy2openai")
    expect(headers["X-Product"]).toBe("SaaS")
    expect(headers["X-Domain"]).toBe("www.workbuddy.ai")
  })

  test("GET headers carry no Content-Type", () => {
    expect("Content-Type" in upstreamGetHeaders(cred())).toBe(false)
  })

  test("conversation headers are uuid-shaped and stable per session", () => {
    const first = upstreamConversationHeaders("wb-a", "ses_1")
    const second = upstreamConversationHeaders("wb-a", "ses_1")
    expect(first["X-Conversation-ID"]).toBe(second["X-Conversation-ID"])
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(first["X-Conversation-ID"]!)).toBe(true)
    expect(/^[0-9a-f]{32}$/.test(first["X-Conversation-Message-ID"]!)).toBe(true)
    expect(first["X-Conversation-Message-ID"]).toBe(first["X-Request-ID"])
    expect(first["X-Agent-Intent"]).toBe("craft")
    expect(first["X-Agent-Type"]).toBe("main")
    expect(upstreamConversationHeaders("wb-b", "ses_1")["X-Conversation-ID"]).not.toBe(first["X-Conversation-ID"])
  })

  test("only the always-sent request id is stamped, never a fabricated trace id", () => {
    const trace = upstreamTraceHeaders()
    expect(/^[0-9a-f]{32}$/.test(trace["X-Request-ID"]!)).toBe(true)
    expect("X-Trace-ID" in trace).toBe(false)
  })

  test("gateway hosts bypass environment proxies like the official client", () => {
    const noProxy = `${process.env.no_proxy ?? ""},${process.env.NO_PROXY ?? ""}`
    expect(noProxy).toContain("www.workbuddy.ai")
    expect(noProxy).toContain("copilot.tencent.com")
  })
})
