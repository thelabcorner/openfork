import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createServerSession } from "./server-session"
import { applySessionActivityRepair, shouldApplyTelemetrySnapshot } from "./session-activity-repair"

describe("applySessionActivityRepair", () => {
  test("clears stale busy and paused state when the authoritative snapshot is inactive", () => {
    const session = createServerSession({} as OpencodeClient)
    session.set("session_status", "ses_stale", { type: "busy" })
    session.set("paused", "ses_stale", true)

    applySessionActivityRepair(session, {}, ["ses_stale"], new Set())

    expect(session.data.session_working("ses_stale")).toBe(false)
    expect(session.data.session_paused("ses_stale")).toBe(false)
    expect(session.data.session_status.ses_stale).toBeUndefined()
  })

  test("projects running and paused active sessions without hydrating session info", () => {
    const session = createServerSession({} as OpencodeClient)

    applySessionActivityRepair(
      session,
      {
        ses_running: { type: "running" },
        ses_paused: { type: "paused" },
      },
      [],
      new Set(),
    )

    expect(session.data.session_working("ses_running")).toBe(true)
    expect(session.data.session_paused("ses_running")).toBe(false)
    expect(session.data.session_working("ses_paused")).toBe(false)
    expect(session.data.session_paused("ses_paused")).toBe(true)
  })

  test("never rolls a session back after a newer stream activity event", () => {
    const session = createServerSession({} as OpencodeClient)
    session.set("session_status", "ses_fresh", {
      type: "retry",
      attempt: 3,
      message: "retrying",
      next: 9_000,
    })

    applySessionActivityRepair(session, {}, ["ses_fresh"], new Set(["ses_fresh"]))

    expect(session.data.session_status.ses_fresh).toEqual({
      type: "retry",
      attempt: 3,
      message: "retrying",
      next: 9_000,
    })
  })
})

describe("shouldApplyTelemetrySnapshot", () => {
  const telemetry = (updatedAt: number, sampledAt?: number) => ({
    sessionID: "ses_test" as const,
    phase: "generating" as const,
    updatedAt,
    ...(sampledAt === undefined ? {} : { sampledAt }),
    generatedMs: 0,
    toolMs: 0,
  })

  test("accepts the first snapshot and a strictly newer snapshot", () => {
    expect(shouldApplyTelemetrySnapshot(undefined, telemetry(10))).toBe(true)
    expect(shouldApplyTelemetrySnapshot(telemetry(10), telemetry(11))).toBe(true)
  })

  test("rejects equal or older snapshots so HTTP cannot roll back SSE state", () => {
    expect(shouldApplyTelemetrySnapshot(telemetry(10), telemetry(10))).toBe(false)
    expect(shouldApplyTelemetrySnapshot(telemetry(11), telemetry(10))).toBe(false)
  })

  test("uses projection sample time to order same-millisecond semantic watermarks", () => {
    expect(shouldApplyTelemetrySnapshot(telemetry(10, 100), telemetry(10, 101))).toBe(true)
    expect(shouldApplyTelemetrySnapshot(telemetry(10, 101), telemetry(10, 100))).toBe(false)
    expect(shouldApplyTelemetrySnapshot(telemetry(10), telemetry(10, 101))).toBe(true)
    expect(shouldApplyTelemetrySnapshot(telemetry(10, 101), telemetry(10))).toBe(false)
  })
})
