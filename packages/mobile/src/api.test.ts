import { describe, expect, test } from "bun:test"
import { selectLaunchServer } from "./api"

describe("selectLaunchServer", () => {
  test("keeps a stored device token bound to its stored server", () => {
    expect(
      selectLaunchServer({
        requested: "https://attacker.example",
        storedToken: "token",
        storedServer: "https://api.example",
      }),
    ).toBe("https://api.example")
  })

  test("allows a pairing launch to select a new server without sending the old token", () => {
    expect(
      selectLaunchServer({
        requested: "https://new-api.example",
        pairCode: "ABC234",
        storedToken: "old-token",
        storedServer: "https://old-api.example",
      }),
    ).toBe("https://new-api.example")
  })
})
