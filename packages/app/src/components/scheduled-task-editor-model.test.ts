import { describe, expect, test } from "bun:test"
import {
  scheduledTaskModelRef,
  scheduledTaskPromptRevisionPatch,
  scheduledTaskRevisionFingerprint,
  scheduledTaskScheduleFromDraft,
} from "./scheduled-task-editor-model"

describe("scheduled task editor model", () => {
  test("D29: daily multi-time schedules round-trip every configured time", () => {
    const times = [
      { hour: 8, minute: 5 },
      { hour: 13, minute: 30 },
      { hour: 22, minute: 45 },
    ]
    expect(
      scheduledTaskScheduleFromDraft({
        inputMode: "recurring",
        recurringMode: "daily",
        relativeValue: "1",
        relativeUnit: "hours",
        times,
        weekdays: [],
        cron: "",
        onceAt: "",
      }),
    ).toEqual({ kind: "recurring", schedule: { kind: "daily", times } })
  })

  test("D29: weekly multi-time schedules preserve times while canonicalizing weekday order", () => {
    const times = [
      { hour: 7, minute: 0 },
      { hour: 19, minute: 15 },
    ]
    expect(
      scheduledTaskScheduleFromDraft({
        inputMode: "recurring",
        recurringMode: "weekly",
        relativeValue: "1",
        relativeUnit: "hours",
        times,
        weekdays: [5, 1, 3],
        cron: "",
        onceAt: "",
      }),
    ).toEqual({ kind: "recurring", schedule: { kind: "weekly", weekdays: [1, 3, 5], times } })
  })

  test("relative input converts user units to a one-shot delay without choosing an absolute instant client-side", () => {
    expect(
      scheduledTaskScheduleFromDraft({
        inputMode: "relative",
        recurringMode: "daily",
        relativeValue: "1.5",
        relativeUnit: "hours",
        times: [],
        weekdays: [],
        cron: "",
        onceAt: "",
      }),
    ).toEqual({ kind: "relative", delayMs: 5_400_000 })
  })

  test("timestamp input emits the explicit absolute-input wrapper", () => {
    const onceAt = "2026-09-20T12:30"
    expect(
      scheduledTaskScheduleFromDraft({
        inputMode: "timestamp",
        recurringMode: "daily",
        relativeValue: "1",
        relativeUnit: "hours",
        times: [],
        weekdays: [],
        cron: "",
        onceAt,
      }),
    ).toEqual({ kind: "timestamp", at: Date.parse(onceAt) })
  })

  test("D28: revisor application is a prompt-only patch and any context mutation changes the stale fence", () => {
    const before = {
      name: "Nightly audit",
      targetDirectory: "/repo",
      sessionMode: "auto",
      schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
      model: { providerID: "p", id: "m" },
      permission: "deny",
      prompt: "Audit dependencies",
    }
    const patch = scheduledTaskPromptRevisionPatch("Audit dependencies and report regressions")
    expect(Object.keys(patch)).toEqual(["prompt"])
    expect(patch.prompt).toContain("report regressions")
    expect(scheduledTaskRevisionFingerprint(before)).not.toBe(
      scheduledTaskRevisionFingerprint({ ...before, sessionMode: "new" }),
    )
    expect(scheduledTaskRevisionFingerprint(before)).not.toBe(
      scheduledTaskRevisionFingerprint({ ...before, permission: "pause" }),
    )
  })

  test("D27: account-qualified picker identity lowers to first-class account + variant", () => {
    const ref = scheduledTaskModelRef("opencode-go", "gpt-5.6@zen-account-42", "high")
    expect(ref).toEqual({
      providerID: "opencode-go",
      id: "gpt-5.6",
      accountID: "zen-account-42",
      variant: "high",
    })
  })
})

