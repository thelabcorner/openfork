import { describe, expect, test } from "bun:test"
import { compareInstance, selectLaunchServer } from "./api"

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

describe("compareInstance", () => {
  test("adopts an instance the first time one is seen", () => {
    expect(compareInstance({ observed: "instance-a" })).toEqual({ state: "adopted", instanceID: "instance-a" })
  })

  test("recognises the instance it is already pinned to", () => {
    expect(compareInstance({ pinned: "instance-a", observed: "instance-a" })).toEqual({
      state: "same",
      instanceID: "instance-a",
    })
  })

  test("flags a different process answering at the same address", () => {
    // Not an error — restarting the desktop mints a new instance — but cached
    // sessions belong to the old one and must not survive the switch.
    expect(compareInstance({ pinned: "instance-a", observed: "instance-b" })).toEqual({
      state: "changed",
      instanceID: "instance-b",
      previous: "instance-a",
    })
  })

  test("stays silent against a server too old to identify itself", () => {
    expect(compareInstance({ pinned: "instance-a" })).toEqual({ state: "unknown" })
  })
})
