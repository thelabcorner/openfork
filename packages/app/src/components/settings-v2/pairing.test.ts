import { describe, expect, test } from "bun:test"
import { formatPairingCode } from "./pairing"

describe("formatPairingCode", () => {
  test("groups a 6-char code into two triplets", () => {
    expect(formatPairingCode("K7M2XQ")).toBe("K7M-2XQ")
  })

  test("passes through codes of unexpected length unchanged", () => {
    expect(formatPairingCode("K7M2X")).toBe("K7M2X")
    expect(formatPairingCode("K7M2XQQ")).toBe("K7M2XQQ")
    expect(formatPairingCode("")).toBe("")
  })
})
