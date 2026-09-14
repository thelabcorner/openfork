import { describe, expect, test } from "bun:test"
import { compareInstance, openEvents, selectLaunchServer } from "./api"

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

describe("openEvents", () => {
  test("opens only the selected native feed and forwards replay cursor state", async () => {
    let seenOptions: any
    const events: unknown[] = []
    const cursors: string[] = []
    const client = {
      v2: {
        event: {
          subscribe: async (options: any) => {
            seenOptions = options
            options.onSseEvent?.({ id: "epoch:42" })
            return {
              stream: (async function* () {
                yield { type: "server.connected", data: {} }
                yield { type: "session.updated", data: { sessionID: "s1" } }
              })(),
            }
          },
        },
      },
      global: {
        event: async () => {
          throw new Error("compatibility feed must not open")
        },
      },
    } as any

    await openEvents(client, new AbortController().signal, "current", (event) => events.push(event), {
      lastEventId: "epoch:41",
      onCursor: (id) => cursors.push(id),
    })

    expect(seenOptions.headers).toEqual({ "Last-Event-ID": "epoch:41" })
    expect(seenOptions.sseDefaultRetryDelay).toBe(500)
    expect(seenOptions.sseMaxRetryDelay).toBe(10_000)
    expect(seenOptions.sseMaxRetryAttempts).toBeUndefined()
    expect(cursors).toEqual(["epoch:42"])
    expect(events).toHaveLength(2)
  })

  test("opens only compatibility feed and unwraps its global envelope", async () => {
    const events: unknown[] = []
    let currentOpened = false
    const client = {
      v2: {
        event: {
          subscribe: async () => {
            currentOpened = true
            return { stream: (async function* () {})() }
          },
        },
      },
      global: {
        event: async () => ({
          stream: (async function* () {
            yield { directory: "/repo", payload: { type: "session.updated", properties: { sessionID: "s1" } } }
          })(),
        }),
      },
    } as any

    await openEvents(client, new AbortController().signal, "compatibility", (event) => events.push(event))
    expect(currentOpened).toBe(false)
    expect(events).toEqual([{ type: "session.updated", properties: { sessionID: "s1" } }])
  })
})
