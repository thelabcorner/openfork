import type { ModelRef, ScheduledTaskScheduleInput } from "@opencode-ai/sdk/v2/client"
import { splitModelIDForProvider } from "@/utils/model-account-identity"

export type ScheduledTaskInputMode = "relative" | "timestamp" | "recurring"
export type ScheduledTaskRecurringMode = "daily" | "weekly" | "cron"
export type ScheduledTaskRelativeUnit = "seconds" | "minutes" | "hours" | "days" | "weeks"

export type ScheduledTaskScheduleDraft = {
  readonly inputMode: ScheduledTaskInputMode
  readonly recurringMode: ScheduledTaskRecurringMode
  readonly relativeValue: string
  readonly relativeUnit: ScheduledTaskRelativeUnit
  readonly times: ReadonlyArray<{ readonly hour: number; readonly minute: number }>
  readonly weekdays: ReadonlyArray<number>
  readonly cron: string
  readonly onceAt: string
}

const RELATIVE_UNIT_MS: Readonly<Record<ScheduledTaskRelativeUnit, number>> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
}

export function scheduledTaskScheduleFromDraft(input: ScheduledTaskScheduleDraft): ScheduledTaskScheduleInput | undefined {
  if (input.inputMode === "relative") {
    const amount = Number(input.relativeValue.trim())
    const delayMs = amount * RELATIVE_UNIT_MS[input.relativeUnit]
    return Number.isFinite(delayMs) && delayMs > 0 ? { kind: "relative", delayMs } : undefined
  }
  if (input.inputMode === "timestamp") {
    const at = Date.parse(input.onceAt)
    return Number.isFinite(at) ? { kind: "timestamp", at } : undefined
  }
  if (input.recurringMode === "cron") {
    const expression = input.cron.trim()
    return expression ? { kind: "recurring", schedule: { kind: "cron", expression } } : undefined
  }

  const times = input.times.map((time) => ({ hour: time.hour, minute: time.minute }))
  if (input.recurringMode === "weekly") {
    if (input.weekdays.length === 0) return undefined
    return {
      kind: "recurring",
      schedule: { kind: "weekly", weekdays: [...input.weekdays].sort((a, b) => a - b), times },
    }
  }
  return { kind: "recurring", schedule: { kind: "daily", times } }
}

export function scheduledTaskModelRef(
  providerIDInput: string,
  qualifiedModelIDInput: string,
  variantInput: string,
): ModelRef | undefined {
  const providerID = providerIDInput.trim()
  const qualifiedID = qualifiedModelIDInput.trim()
  if (!providerID || !qualifiedID) return undefined
  const split = splitModelIDForProvider(qualifiedID, providerID)
  const variant = variantInput.trim()
  return {
    providerID,
    id: split.baseModelID,
    ...(split.accountID ? { accountID: split.accountID } : {}),
    ...(variant ? { variant } : {}),
  }
}

/** Stable client-side stale-result fence for the complete Scheduled Task editor context. */
export function scheduledTaskRevisionFingerprint(value: unknown) {
  return JSON.stringify(value)
}

/** D28 contract: a Scheduled Prompt Revisor result can mutate exactly one field. */
export function scheduledTaskPromptRevisionPatch(prompt: string) {
  return { prompt } as const
}

