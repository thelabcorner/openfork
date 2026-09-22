import { describe, expect, test } from "bun:test"
import { formatPairingCode, listDevices, revokeDevice } from "./pairing"

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

describe("device lifecycle seam", () => {
  test("revoke targets the device registry by id", async () => {
    const calls: unknown[] = []
    const sdk = {
      client: {
        device: {
          remove: async (input: unknown) => {
            calls.push(input)
            return { data: true }
          },
        },
      },
    }
    await revokeDevice(sdk as never, "device-1")
    expect(calls).toEqual([{ deviceID: "device-1" }])
  })

  test("device listing filters soft-revoked rows", async () => {
    const sdk = {
      client: {
        device: {
          list: async () => ({
            data: [
              { id: "a", name: "Phone", createdAt: "2026-01-01T00:00:00.000Z", tokenPrefix: "abc" },
              {
                id: "b",
                name: "Old phone",
                createdAt: "2026-01-01T00:00:00.000Z",
                revokedAt: "2026-01-02T00:00:00.000Z",
                tokenPrefix: "def",
              },
            ],
          }),
        },
      },
    }
    const devices = await listDevices(sdk as never)
    expect(devices.map((device) => device.id)).toEqual(["a"])
    expect(devices[0]).toMatchObject({ name: "Phone", prefix: "abc" })
  })
})
