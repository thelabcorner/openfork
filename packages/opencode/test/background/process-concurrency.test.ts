import { describe, expect, test } from "bun:test"
import {
  BACKGROUND_PROCESS_ENV,
  configuredBackgroundProcessLimit,
  DEFAULT_BACKGROUND_PROCESSES,
  MAX_SAFE_BACKGROUND_PROCESSES,
  UNSAFE_DISABLE_BACKGROUND_PROCESS_ENV,
} from "../../src/background/process-concurrency"

describe("background process concurrency", () => {
  test("uses a conservative default", () => {
    expect(configuredBackgroundProcessLimit({})).toBe(DEFAULT_BACKGROUND_PROCESSES)
  })

  test("invalid or zero values cannot disable the guard", () => {
    expect(configuredBackgroundProcessLimit({ [BACKGROUND_PROCESS_ENV]: "0" })).toBe(DEFAULT_BACKGROUND_PROCESSES)
    expect(configuredBackgroundProcessLimit({ [BACKGROUND_PROCESS_ENV]: "nope" })).toBe(DEFAULT_BACKGROUND_PROCESSES)
  })

  test("large overrides are hard capped", () => {
    expect(configuredBackgroundProcessLimit({ [BACKGROUND_PROCESS_ENV]: "999" })).toBe(MAX_SAFE_BACKGROUND_PROCESSES)
  })

  test("disable requires the explicit unsafe switch", () => {
    expect(configuredBackgroundProcessLimit({ [UNSAFE_DISABLE_BACKGROUND_PROCESS_ENV]: "1" })).toBeUndefined()
  })
})
