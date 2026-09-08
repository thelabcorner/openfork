import { describe, expect, test } from "bun:test"
import {
  configuredLspStartupLimit,
  DEFAULT_LSP_STARTUPS,
  LSP_STARTUP_ENV,
  MAX_SAFE_LSP_STARTUPS,
  UNSAFE_DISABLE_LSP_STARTUP_ENV,
} from "../../src/lsp/startup-concurrency"

describe("lsp startup concurrency", () => {
  test("defaults to one machine-wide startup", () => {
    expect(configuredLspStartupLimit({})).toBe(DEFAULT_LSP_STARTUPS)
    expect(DEFAULT_LSP_STARTUPS).toBe(1)
  })

  test("invalid and zero values cannot disable the guard", () => {
    expect(configuredLspStartupLimit({ [LSP_STARTUP_ENV]: "0" })).toBe(DEFAULT_LSP_STARTUPS)
    expect(configuredLspStartupLimit({ [LSP_STARTUP_ENV]: "-8" })).toBe(DEFAULT_LSP_STARTUPS)
    expect(configuredLspStartupLimit({ [LSP_STARTUP_ENV]: "wat" })).toBe(DEFAULT_LSP_STARTUPS)
  })

  test("large overrides are hard capped", () => {
    expect(configuredLspStartupLimit({ [LSP_STARTUP_ENV]: "999" })).toBe(MAX_SAFE_LSP_STARTUPS)
  })

  test("disable requires the explicit unsafe switch", () => {
    expect(configuredLspStartupLimit({ [UNSAFE_DISABLE_LSP_STARTUP_ENV]: "1" })).toBeUndefined()
  })
})
