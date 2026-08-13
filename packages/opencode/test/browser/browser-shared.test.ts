import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { BrowserError } from "@opencode-ai/core/browser/host-broker"
import { ERROR_MESSAGE, FAMILY, OperationInput, permissionPattern, toBrowserError } from "../../src/browser/shared"

const decode = <A>(schema: Schema.Schema<A>, input: unknown): A => {
  const option = Schema.decodeUnknownOption(schema as unknown as Schema.Decoder<unknown>)(input)
  if (Option.isNone(option)) throw new Error(`decode failed for ${String(input)}`)
  return option.value as A
}

import { Option } from "effect"

describe("BrowserShared permission families", () => {
  it("maps every operation to the design §5 + premium families", () => {
    expect(FAMILY.status).toBe("browser.read")
    expect(FAMILY.snapshot).toBe("browser.read")
    expect(FAMILY.query).toBe("browser.read")
    expect(FAMILY.profiler_start).toBe("browser.read")
    expect(FAMILY.profiler_stop).toBe("browser.read")
    expect(FAMILY.open).toBe("browser.navigate")
    expect(FAMILY.navigate).toBe("browser.navigate")
    expect(FAMILY.close).toBe("browser.navigate")
    expect(FAMILY.click).toBe("browser.interact")
    expect(FAMILY.type).toBe("browser.interact")
    expect(FAMILY.press).toBe("browser.interact")
    expect(FAMILY.scroll).toBe("browser.interact")
    expect(FAMILY.wait_for).toBe("browser.interact")
    expect(FAMILY.highlight).toBe("browser.interact")
    expect(FAMILY.evaluate).toBe("browser.evaluate")
    expect(FAMILY.recording_start).toBe("browser.record")
    expect(FAMILY.recording_stop).toBe("browser.record")
  })
})

describe("BrowserShared permissionPattern", () => {
  it("uses the target origin for navigate/open", () => {
    expect(permissionPattern("navigate", "https://example.com/path")).toBe("https://example.com")
    expect(permissionPattern("open", "https://example.com")).toBe("https://example.com")
  })

  it("falls back to '*' for non-navigate ops and unparseable URLs", () => {
    expect(permissionPattern("click")).toBe("*")
    expect(permissionPattern("snapshot")).toBe("*")
    expect(permissionPattern("navigate", "not a url")).toBe("*")
  })
})

describe("BrowserShared ERROR_MESSAGE", () => {
  it("covers the base taxonomy and premium tags", () => {
    expect(ERROR_MESSAGE.BrowserHostUnavailable).toBeTruthy()
    expect(ERROR_MESSAGE.BrowserStaleRefError).toBeTruthy()
    expect(ERROR_MESSAGE.BrowserNotAReactAppError).toBeTruthy()
    expect(ERROR_MESSAGE.BrowserControlInterrupted).toContain("interrupted")
  })
})

describe("BrowserShared toBrowserError", () => {
  it("maps a payload tag onto the typed class (payload message wins)", () => {
    const error = toBrowserError({ tag: "BrowserHostUnavailable", message: "x", retryable: true })
    expect(error._tag).toBe("BrowserHostUnavailable")
    expect(error.retryable).toBe(true)
    expect(error.message).toBe("x")
  })

  it("builds an error without an override using the default prose", () => {
    const error = BrowserError.make("BrowserStaleRefError")
    expect(error._tag).toBe("BrowserStaleRefError")
    expect(error.message).toContain("Re-snapshot")
  })
})

describe("BrowserShared per-operation input schemas (premium targeting)", () => {
  it("click accepts a versioned ref", () => {
    const decoded = decode(OperationInput.click, { target: { ref: "e7", snapshotVersion: 4 }, button: "left" })
    expect(decoded.target).toEqual({ ref: "e7", snapshotVersion: 4 })
  })

  it("type accepts a ref target and defaults", () => {
    const decoded = decode(OperationInput.type, { text: "hello", target: { ref: "e2", snapshotVersion: 1 } })
    expect(decoded.text).toBe("hello")
    expect(decoded.clear).toBeUndefined()
  })

  it("query requires a locator target", () => {
    const decoded = decode(OperationInput.query, { target: { type: "css", value: "button" } })
    expect(decoded.target.value).toBe("button")
  })

  it("wait_for accepts a selector condition", () => {
    const decoded = decode(OperationInput.wait_for, {
      condition: { type: "selector", selector: { type: "css", value: "#go" } },
    })
    expect(decoded.condition?.type).toBe("selector")
  })

  it("rejects click without any target", () => {
    expect(() => decode(OperationInput.click, {})).toThrow()
  })
})
