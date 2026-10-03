import { describe, expect, test } from "bun:test"
import { ServerConnection } from "./server"
import { legacySessionHref, sessionHref } from "@/utils/session-route"
import { currentRoute } from "./layout-route"

describe("currentRoute", () => {
  test("resolves single-segment app tabs", () => {
    expect(currentRoute("/settings", "")).toEqual({ type: "settings" })
    expect(currentRoute("/usage", "")).toEqual({ type: "usage" })
    expect(currentRoute("/scheduled", "")).toEqual({ type: "scheduled" })
    expect(currentRoute("/agents", "")).toEqual({ type: "agents" })
    expect(currentRoute("/oxp", "")).toEqual({ type: "oxp" })
  })

  // Regression: `/oxp/activity/:id` used to fall through to the directory
  // branch, fail to base64-decode "oxp", and report "home" — which left the
  // titlebar highlighting Home while the OXP tab was the open tab.
  test("resolves a selected OXP activity to the OXP tab", () => {
    expect(currentRoute("/oxp/activity/oxpa_example", "")).toEqual({ type: "oxp" })
  })

  test("leaves malformed app-tab paths on home", () => {
    expect(currentRoute("/oxp/activity", "")).toEqual({ type: "home" })
    expect(currentRoute("/", "")).toEqual({ type: "home" })
  })

  test("still resolves session routes", () => {
    expect(currentRoute(sessionHref(ServerConnection.Key.make("local"), "ses_1"), "")).toMatchObject({
      type: "session",
      sessionId: "ses_1",
    })
  })

  test("still resolves legacy directory routes", () => {
    const route = currentRoute(legacySessionHref("/tmp/project", "ses_2"), "")
    expect(route).toMatchObject({ type: "session", sessionId: "ses_2" })
  })
})
