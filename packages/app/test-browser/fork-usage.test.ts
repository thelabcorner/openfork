import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { ForkServer } from "@/utils/fork-client"

const server: ForkServer = { url: "http://localhost:4096" }

let listCalls = 0
let usageCalls = 0
let listener:
  | ((e: { name: string; details: { type: string; properties?: { status?: { type: string } } } }) => void)
  | undefined

mock.module("@/utils/fork-client", () => ({
  ForkClient: {
    list: async () => {
      listCalls++
      return [{ id: "cred_1", label: "Work", active: true, timeCreated: 1 }]
    },
    usage: async () => {
      usageCalls++
      return {
        aggregate: [],
        byCredential: [{ credentialID: "cred_1", windows: [] }],
      }
    },
  },
}))

mock.module("@/context/server-sdk", () => ({
  useServerSDK: () => () => ({
    server: { http: server },
    event: {
      listen: (fn: typeof listener) => {
        listener = fn
        return () => {
          listener = undefined
        }
      },
    },
  }),
}))

// The real createSimpleContext provider renders JSX internally; bun test
// doesn't run the Solid JSX runtime, so mirror the provider semantics with a
// plain function that runs init inside a live root (matches comments.test.ts).
let controller: ReturnType<typeof useForkUsage> | undefined
let disposeRoot: (() => void) | undefined
mock.module("@opencode-ai/ui/context", () => ({
  createSimpleContext: (input: { init: (props: { heartbeatMs?: number }) => unknown }) => ({
    use: () => controller,
    provider: (props: { children?: unknown; heartbeatMs?: number }) => {
      createRoot((dispose) => {
        disposeRoot = dispose
        controller = input.init({ heartbeatMs: props.heartbeatMs }) as ReturnType<typeof useForkUsage>
      })
      return props.children
    },
  }),
}))

const { useForkUsage, ForkUsageProvider } = await import("@/context/fork-usage")

function mount(heartbeatMs = 60_000) {
  ForkUsageProvider({ heartbeatMs })
  return controller!
}

describe("ForkUsage controller", () => {
  beforeEach(() => {
    listCalls = 0
    usageCalls = 0
    listener = undefined
    controller = undefined
    disposeRoot = undefined
  })

  afterEach(() => {
    listener = undefined
    disposeRoot?.()
    controller = undefined
    disposeRoot = undefined
  })

  test("mounts one resource pair and exposes credentials, usage, and the active credential", async () => {
    const usage = mount()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(usage.activeCredentialID()).toBe("cred_1")
    expect(listCalls).toBe(1)
    expect(usageCalls).toBe(1)
  })

  test("refetches usage (debounced) when a session step finishes (status idle)", async () => {
    mount()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const before = usageCalls
    // step-finish emits session.status idle
    listener?.({ name: "/repo", details: { type: "session.status", properties: { status: { type: "idle" } } } })

    await new Promise((resolve) => setTimeout(resolve, 3_500))
    expect(usageCalls).toBe(before + 1)
    expect(listCalls).toBe(1)
  })

  test("refreshes credentials and usage on server reconnect", async () => {
    mount()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const listBefore = listCalls
    const usageBefore = usageCalls
    listener?.({ name: "global", details: { type: "server.connected" } })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(listCalls).toBe(listBefore + 1)
    expect(usageCalls).toBeGreaterThanOrEqual(usageBefore + 1)
  })

  test("refreshAll refetches credentials and usage", async () => {
    const usage = mount()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const listBefore = listCalls
    const usageBefore = usageCalls
    usage.refreshAll()

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(listCalls).toBe(listBefore + 1)
    expect(usageCalls).toBeGreaterThanOrEqual(usageBefore + 1)
  })

  test("heartbeat ticks while visible and is skipped while hidden", async () => {
    mount(500)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const before = usageCalls

    // Visible: the heartbeat fires a refetch.
    const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden")
    Object.defineProperty(document, "hidden", { configurable: true, value: false })
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(usageCalls).toBeGreaterThanOrEqual(before + 1)

    // Hidden: no heartbeat refetches occur.
    Object.defineProperty(document, "hidden", { configurable: true, value: true })
    const hiddenBefore = usageCalls
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(usageCalls).toBe(hiddenBefore)

    if (originalHidden) Object.defineProperty(document, "hidden", originalHidden)
  })
})
