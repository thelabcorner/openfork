import { describe, expect, test } from "bun:test"
import { isSidecarControlFetch, sidecarControlLane } from "./sidecar-control-request"

describe("isSidecarControlFetch", () => {
  test("keeps runtime admission out of the urgent control pool", () => {
    for (const path of ["/api/session", "/session/ses_1/prompt_async", "/api/session/ses_1/prompt", "/session/ses_1/goal/dispatch"])
      expect(sidecarControlLane(`http://127.0.0.1:4096${path}`, { method: "POST" })).toBe("admission")
    for (const path of ["/session", "/global/event/interest", "/session/ses_1/abort", "/permission/per_1/reply", "/question/que_1/reply"])
      expect(sidecarControlLane(`http://127.0.0.1:4096${path}`, { method: "POST" })).toBe("urgent")
    expect(sidecarControlLane("http://127.0.0.1:4096/provider")).toBeUndefined()
  })
  test("classifies only the finite session-control POST routes", () => {
    for (const path of [
      "/global/event/interest",
      "/permission/per_1/reply",
      "/question/que_1/reply",
      "/question/que_1/reject",
      "/session",
      "/session/ses_1/prompt_async",
      "/session/ses_1/abort",
      "/session/ses_1/pause",
      "/session/ses_1/resume",
      "/session/ses_1/goal/prepare",
      "/session/ses_1/goal/dispatch",
      "/api/session/ses_1/prompt",
      "/api/session/ses_1/interrupt",
      "/api/session/ses_1/permission/per_1/reply",
      "/api/session/ses_1/question/que_1/reject",
    ])
      expect(isSidecarControlFetch(`http://127.0.0.1:4096${path}`, { method: "POST" })).toBe(true)
    expect(isSidecarControlFetch("http://127.0.0.1:4096/session/ses_1/goal", { method: "PUT" })).toBe(true)
    expect(isSidecarControlFetch("http://127.0.0.1:4096/session/ses_1/goal", { method: "DELETE" })).toBe(true)
    expect(isSidecarControlFetch("http://127.0.0.1:4096/session/ses_1/goal", { method: "POST" })).toBe(false)
  })

  test("does not classify reads, catalog traffic, lookalike paths, or other methods", () => {
    for (const [path, method] of [
      ["/session/ses_1/message", "GET"],
      ["/session/ses_1/message", "POST"],
      ["/session/ses_1/command", "POST"],
      ["/session/ses_1/children", "POST"],
      ["/global/event/interest-extra", "POST"],
      ["/provider", "POST"],
      ["/permission/per_1/reply-extra", "POST"],
      ["/question/que_1/reply", "GET"],
      ["/api/session/ses_1/history", "POST"],
    ])
      expect(isSidecarControlFetch(`http://127.0.0.1:4096${path}`, { method })).toBe(false)
  })
})
