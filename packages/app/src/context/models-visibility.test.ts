import { describe, expect, test } from "bun:test"
import { DateTime } from "luxon"
import { isRecentModelRelease, RECENT_MODEL_WINDOW_MONTHS } from "@/utils/model-recency"

/**
 * Default-visibility regression tests: newly-added models must AUTO-ENABLE
 * (the Ox Alpha Free (Unlimited) bug — released today, no `family`, so it
 * lost the single-"latest"-per-family lottery and defaulted to off in both
 * the model selector and the Manage models dialog).
 */
describe("isRecentModelRelease (new-model auto-enable default)", () => {
  test("released today -> on", () => {
    expect(isRecentModelRelease(DateTime.now())).toBe(true)
  })

  test("future-dated stealth release -> on", () => {
    expect(isRecentModelRelease(DateTime.now().plus({ days: 3 }))).toBe(true)
  })

  test("released inside the recent window -> on", () => {
    expect(isRecentModelRelease(DateTime.now().minus({ months: RECENT_MODEL_WINDOW_MONTHS - 1 }))).toBe(true)
  })

  test("release aged out of the window -> off (opt-in via Manage models)", () => {
    expect(isRecentModelRelease(DateTime.now().minus({ months: RECENT_MODEL_WINDOW_MONTHS + 1 }))).toBe(false)
    expect(isRecentModelRelease(DateTime.fromISO("2024-01-01"))).toBe(false)
  })

  test("missing or unparseable release date -> on (never hide what we cannot date)", () => {
    expect(isRecentModelRelease(undefined)).toBe(true)
    expect(isRecentModelRelease(DateTime.invalid("no date"))).toBe(true)
  })
})
