import { describe, expect, test } from "bun:test"
import type { ServerCtx } from "@/context/global"
import { tabSessionState } from "./titlebar-tab-state"

const ctx = (type: "busy" | "retry" | "interrupted" | "idle" | undefined, paused = false) =>
  ({
    sync: {
      session: {
        data: {
          session_status: type ? { s: { type } } : {},
          session_working: (id: string) => id === "s" && (type === "busy" || type === "retry"),
          session_paused: () => paused,
        },
      },
    },
  }) as unknown as ServerCtx

describe("tab Stop and recovery evidence", () => {
  test("requires proof before showing the working/Stop state", () => {
    expect(tabSessionState(ctx("busy"), "s")).toBe("working")
    expect(tabSessionState(ctx("retry"), "s")).toBe("working")
    expect(tabSessionState(ctx(undefined), "s")).toBe("idle")
    expect(tabSessionState(ctx("idle"), "s")).toBe("idle")
  })

  test("prioritizes a fenced interrupted generation over stale paused and busy presentation", () => {
    expect(tabSessionState(ctx("interrupted"), "s")).toBe("interrupted")
    expect(tabSessionState(ctx("interrupted", true), "s")).toBe("interrupted")
    expect(tabSessionState(ctx("busy", true), "s")).toBe("paused")
  })

  test("does not infer active execution without the exact session key", () => {
    expect(tabSessionState(ctx("busy"), undefined)).toBe("idle")
    expect(tabSessionState(ctx("busy"), "other")).toBe("idle")
  })
})
