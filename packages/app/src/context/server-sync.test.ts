import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type {
  McpListInput,
  McpResourceCatalogInput,
  SessionApi,
  SessionInfo,
  SessionListInput,
} from "@opencode-ai/client/promise"
import { QueryClient } from "@tanstack/solid-query"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./global-sync/eviction"
import {
  estimateRootSessionTotal,
  loadRootSessions,
  loadRootSessionsFast,
  rootSessionFastPathUnavailable,
} from "./global-sync/session-load"
import {
  createActiveSessionInfoWarmup,
  createDirectoryBootstrapGate,
  loadActiveSessionsQuery,
  loadMcpQuery,
  loadMcpResourcesQuery,
  seedActiveSessionStatuses,
} from "./server-sync"
import { ServerScope } from "@/utils/server-scope"
import { createServerSession } from "./server-session"
import type { ServerApi } from "@/utils/server"

type McpApi = ServerApi["mcp"]

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

describe("directory bootstrap gate", () => {
  test("serializes directory waves and releases the next wave after completion", async () => {
    const gate = createDirectoryBootstrapGate()
    const hold = deferred<void>()
    const order: string[] = []

    const first = gate.run(async () => {
      order.push("a:start")
      await hold.promise
      order.push("a:end")
    })
    const second = gate.run(async () => {
      order.push("b:start")
      order.push("b:end")
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(["a:start"])
    expect(gate.snapshot()).toEqual({ active: 1, queued: 1, maxActive: 1 })

    hold.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"])
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0, maxActive: 1 })
  })

  test("a failed wave cannot poison later directory bootstrap work", async () => {
    const gate = createDirectoryBootstrapGate()
    const first = gate.run(async () => {
      throw new Error("expected")
    })
    const second = gate.run(async () => "next")

    await expect(first).rejects.toThrow("expected")
    await expect(second).resolves.toBe("next")
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0, maxActive: 1 })
  })
})

describe("MCP queries", () => {
  test("loads current servers for the requested location", async () => {
    const calls: unknown[] = []
    const queryClient = new QueryClient()
    const result = await queryClient.fetchQuery(
      loadMcpQuery(ServerScope.local, "/project", {
        list: async (input: McpListInput = {}) => {
          calls.push(input)
          return {
            location: { directory: "/project", project: { id: "project", directory: "/project" } },
            data: [
              { name: "docs", status: { status: "connected" } },
              { name: "search", status: { status: "pending" } },
            ],
          }
        },
      } as unknown as McpApi),
    )

    expect(calls).toEqual([{ location: { directory: "/project" } }])
    expect(result).toEqual({ docs: { status: "connected" }, search: { status: "pending" } })
  })

  test("loads and keys the current resource catalog", async () => {
    const calls: unknown[] = []
    const queryClient = new QueryClient()
    const result = await queryClient.fetchQuery(
      loadMcpResourcesQuery(ServerScope.local, "/project", {
        resource: {
          catalog: async (input: McpResourceCatalogInput = {}) => {
            calls.push(input)
            return {
              location: { directory: "/project", project: { id: "project", directory: "/project" } },
              data: {
                resources: [{ server: "docs", name: "Guide", uri: "docs://guide" }],
                templates: [],
              },
            }
          },
        },
      } as unknown as McpApi),
    )

    expect(calls).toEqual([{ location: { directory: "/project" } }])
    expect(result).toEqual({ "docs:docs://guide": { server: "docs", name: "Guide", uri: "docs://guide" } })
  })
})

describe("active session query", () => {
  test("serializes background active-session info hydration", async () => {
    const first = deferred<void>()
    const calls: string[] = []
    const warmup = createActiveSessionInfoWarmup(async (sessionID) => {
      calls.push(`${sessionID}:start`)
      if (sessionID === "a") await first.promise
      calls.push(`${sessionID}:end`)
    })

    const done = warmup.push(["a", "b", "a"])

    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(["a:start"])
    expect(warmup.pending()).toBe(2)

    first.resolve()
    await done

    expect(calls).toEqual(["a:start", "a:end", "b:start", "b:end"])
    expect(warmup.pending()).toBe(0)
  })

  test("continues active-session info hydration after an error", async () => {
    const calls: string[] = []
    const warmup = createActiveSessionInfoWarmup(async (sessionID) => {
      calls.push(sessionID)
      if (sessionID === "a") throw new Error("expected")
    })

    await warmup.push(["a", "b"])

    expect(calls).toEqual(["a", "b"])
    expect(warmup.pending()).toBe(0)
  })

  test("loads active sessions immediately and once per server cache", async () => {
    let calls = 0
    const queryClient = new QueryClient()
    const options = loadActiveSessionsQuery(ServerScope.local, {
      active: async () => {
        calls++
        return { ses_running: { type: "running" } }
      },
    })

    expect(await queryClient.fetchQuery(options)).toEqual({ ses_running: { type: "running" } })
    expect(await queryClient.fetchQuery(options)).toEqual({ ses_running: { type: "running" } })
    expect(calls).toBe(1)
    expect(options.enabled).toBe(true)
    expect([...options.queryKey]).toEqual([ServerScope.local, "activeSessions"])
  })

  test("does not overwrite statuses already written by events", () => {
    const session = createServerSession({} as OpencodeClient)
    session.set("session_status", "ses_retry", { type: "retry", attempt: 2, message: "retrying", next: 10 })

    seedActiveSessionStatuses(session, {
      ses_running: { type: "running" },
      ses_retry: { type: "running" },
    })

    expect(session.data.session_status.ses_running).toEqual({ type: "busy" })
    expect(session.data.session_status.ses_retry).toEqual({
      type: "retry",
      attempt: 2,
      message: "retrying",
      next: 10,
    })
  })
})

describe("pickDirectoriesToEvict", () => {
  test("keeps pinned stores and evicts idle stores", () => {
    const now = 5_000
    const picks = pickDirectoriesToEvict({
      stores: ["a", "b", "c", "d"],
      state: new Map([
        ["a", { lastAccessAt: 1_000 }],
        ["b", { lastAccessAt: 4_900 }],
        ["c", { lastAccessAt: 4_800 }],
        ["d", { lastAccessAt: 3_000 }],
      ]),
      pins: new Set(["a"]),
      max: 2,
      ttl: 1_500,
      now,
    })

    expect(picks).toEqual(["d", "c"])
  })
})

describe("loadRootSessions", () => {
  test("loads and normalizes a limited page of root sessions", async () => {
    const calls: SessionListInput[] = []

    const result = await loadRootSessions({
      api: {
        list: async (query = {}) => {
          calls.push(query)
          return { data: [sessionInfo("session-1")], cursor: {} }
        },
      } satisfies Pick<SessionApi, "list">,
      directory: "dir",
      limit: 10,
    })

    expect(result.data).toEqual([
      expect.objectContaining({ id: "session-1", directory: "dir", slug: "session-1", version: "" }),
    ])
    expect(result.limited).toBe(true)
    expect(calls).toEqual([{ directory: "dir", parentID: null, limit: 10, order: "desc" }])
  })

  test("propagates list failures", () => {
    expect(
      loadRootSessions({
        api: {
          list: async () => {
            throw new Error("failed")
          },
        } satisfies Pick<SessionApi, "list">,
        directory: "dir",
        limit: 25,
      }),
    ).rejects.toThrow("failed")
  })

  test("uses the global bootstrap-free root-session surface", async () => {
    const calls: unknown[] = []
    const result = await loadRootSessionsFast({
      client: {
        global: {
          sessionRoots: async (query: unknown) => {
            calls.push(query)
            return { data: [sessionInfo("session-fast")] }
          },
        },
      } as unknown as OpencodeClient,
      directory: "dir",
      limit: 50,
    })

    expect(calls).toEqual([{ directory: "dir", limit: "50" }])
    expect(result.data).toEqual([expect.objectContaining({ id: "session-fast", directory: "dir" })])
    expect(result.limited).toBe(true)
  })

  test("only treats missing-method responses as fast-path compatibility misses", () => {
    expect(rootSessionFastPathUnavailable({ status: 404 })).toBe(true)
    expect(rootSessionFastPathUnavailable({ response: { status: 405 } })).toBe(true)
    expect(rootSessionFastPathUnavailable(new Error("missing", { cause: { status: 404 } }))).toBe(true)
    expect(rootSessionFastPathUnavailable({ status: 500 })).toBe(false)
    expect(rootSessionFastPathUnavailable(new Error("network"))).toBe(false)
  })
})

function sessionInfo(id: string) {
  return {
    id,
    projectID: "project-1",
    agent: "build",
    model: { id: "model-1", providerID: "provider-1" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    title: id,
    location: { directory: "dir" },
  } as SessionInfo
}

describe("estimateRootSessionTotal", () => {
  test("keeps exact total for full fetches", () => {
    expect(estimateRootSessionTotal({ count: 42, limit: 10, limited: false })).toBe(42)
  })

  test("marks has-more for full-limit limited fetches", () => {
    expect(estimateRootSessionTotal({ count: 10, limit: 10, limited: true })).toBe(11)
  })

  test("keeps exact total when limited fetch is under limit", () => {
    expect(estimateRootSessionTotal({ count: 9, limit: 10, limited: true })).toBe(9)
  })
})

describe("canDisposeDirectory", () => {
  test("rejects pinned or inflight directories", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: true,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: true,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: true,
      }),
    ).toBe(false)
  })

  test("accepts idle unpinned directory store", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(true)
  })
})
