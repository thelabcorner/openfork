import { describe, expect, test } from "bun:test"
import { RuntimeHttpBackendOwner, type RuntimeHttpListener } from "./runtime-http-transition"
import type { RuntimeBackendModule } from "./runtime-refresh"

function module(name: string, events: string[], options: { listenError?: Error } = {}) {
  const value = {
    name,
    Server: {
      async listen() {
        events.push(`${name}:listen`)
        if (options.listenError) throw options.listenError
        return listener(name, events)
      },
    },
  }
  return value as unknown as RuntimeBackendModule
}

function listener(name: string, events: string[]): RuntimeHttpListener {
  return {
    url: new URL(`http://127.0.0.1:4096/${name}`),
    async stop(close) {
      events.push(`${name}:stop:${close === true}`)
    },
  }
}

const listenOptions = {
  port: 4096,
  hostname: "127.0.0.1",
  username: "opencode",
  password: "secret",
  cors: ["oc://renderer"],
} as const

describe("RuntimeHttpBackendOwner", () => {
  test("rebinds a real loopback listener on the same port without changing the public URL", async () => {
    const reserve = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("reserve"),
    })
    const port = reserve.port
    reserve.stop(true)

    const liveOptions = { ...listenOptions, port }
    const serverModule = (name: string) =>
      ({
        Server: {
          async listen(options: typeof liveOptions) {
            const server = Bun.serve({
              hostname: options.hostname,
              port: options.port,
              fetch: () => new Response(name),
            })
            return {
              url: server.url,
              stop: (close?: boolean) => server.stop(close),
            }
          },
        },
      }) as unknown as RuntimeBackendModule

    const previous = serverModule("previous")
    const candidate = serverModule("candidate")
    const previousListener = await (
      previous as RuntimeBackendModule & {
        Server: { listen(options: typeof liveOptions): Promise<RuntimeHttpListener> }
      }
    ).Server.listen(liveOptions)
    const originalUrl = previousListener.url.toString()
    const owner = new RuntimeHttpBackendOwner(previous, previousListener, liveOptions, async (next) => {
      const response = await fetch(next.url)
      if (!response.ok) throw new Error("listener health probe failed")
    })

    try {
      expect(await (await fetch(originalUrl)).text()).toBe("previous")
      await owner.transition(previous, candidate)
      expect(owner.current()).toBe(candidate)
      expect(await (await fetch(originalUrl)).text()).toBe("candidate")
      await owner.transition(candidate, previous)
      expect(owner.current()).toBe(previous)
      expect(await (await fetch(originalUrl)).text()).toBe("previous")
    } finally {
      await owner.stop(true)
    }
  })

  test("moves the listener to the candidate only after its health probe passes", async () => {
    const events: string[] = []
    const previous = module("previous", events)
    const candidate = module("candidate", events)
    const owner = new RuntimeHttpBackendOwner(previous, listener("previous", events), listenOptions, async (next) => {
      events.push(`probe:${next.url.pathname.slice(1)}`)
    })

    await owner.transition(previous, candidate)

    expect(owner.current()).toBe(candidate)
    expect(events).toEqual(["previous:stop:true", "candidate:listen", "probe:candidate"])
  })

  test("restores the previous listener when candidate probing fails", async () => {
    const events: string[] = []
    const previous = module("previous", events)
    const candidate = module("candidate", events)
    const owner = new RuntimeHttpBackendOwner(previous, listener("previous", events), listenOptions, async (next) => {
      const name = next.url.pathname.slice(1)
      events.push(`probe:${name}`)
      if (name === "candidate") throw new Error("candidate unhealthy")
    })

    await expect(owner.transition(previous, candidate)).rejects.toThrow("candidate unhealthy")
    expect(owner.current()).toBe(previous)
    expect(events).toEqual([
      "previous:stop:true",
      "candidate:listen",
      "probe:candidate",
      "candidate:stop:true",
      "previous:listen",
      "probe:previous",
    ])
  })

  test("reports no serving backend when activation and restoration both fail", async () => {
    const events: string[] = []
    const previous = module("previous", events, { listenError: new Error("previous restore failed") })
    const candidate = module("candidate", events, { listenError: new Error("candidate listen failed") })
    const owner = new RuntimeHttpBackendOwner(previous, listener("previous", events), listenOptions, async () => {})

    await expect(owner.transition(previous, candidate)).rejects.toBeInstanceOf(AggregateError)
    expect(owner.current()).toBeUndefined()
    expect(events).toEqual(["previous:stop:true", "candidate:listen", "previous:listen"])
  })
})
