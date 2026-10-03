import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { Config, OpencodeClient, Project } from "@opencode-ai/sdk/v2/client"
import type { AgentApi, CatalogApi, CommandApi, ReferenceApi } from "@opencode-ai/client/promise"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import {
  bootstrapDirectory,
  loadAgentsQuery,
  loadCommands,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
  loadReferencesQuery,
} from "./bootstrap"
import type { State, VcsCache } from "./types"
import { ServerScope } from "@/utils/server-scope"
import type { ServerApi } from "@/utils/server"

type ProjectApi = ServerApi["project"]

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse
const api = {
  agent: { list: async () => ({ location: {}, data: [] }) },
  provider: { list: async () => ({ location: {}, data: [] }) },
  model: {
    list: async () => ({ location: {}, data: [] }),
    default: async () => ({ location: {}, data: null }),
  },
  permission: { request: { list: async () => ({ location: {}, data: [] }) } },
  project: {
    list: async () => [],
    current: async () => ({ id: "project", directory: "/project" }),
  },
  question: { request: { list: async () => ({ location: {}, data: [] }) } },
  reference: { list: async () => ({ location: {}, data: [] }) },
  vcs: { get: async () => ({ location: {}, data: {} }) },
} as unknown as ServerApi

function directoryState() {
  return createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    reference: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider,
    config: {},
    path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
    session: [],
    session_children: () => new Map(),
    sessionTotal: 0,
    session_status: {},
    session_working(id: string) {
      return this.session_status[id]?.type !== "idle"
    },
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: true,
    mcp: {},
    mcp_resource: {},
    lsp_ready: true,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    session_message: {},
    part: {},
    part_text_accum_delta: {},
  })
}

describe("bootstrapDirectory", () => {
  test("critical session hydration completes before auxiliary bootstrap admission", async () => {
    const [store, setStore] = directoryState()
    let releaseBackground!: () => void
    const backgroundBarrier = new Promise<void>((resolve) => (releaseBackground = resolve))
    const calls: string[] = []
    let admitted = false

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {} as OpencodeClient,
      serverSDK: {} as OpencodeClient,
      api,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions: async () => {
        calls.push("sessions")
      },
      translate: (key) => key,
      queryClient: new QueryClient(),
      protocol: Promise.resolve("v2"),
      runBackgroundBootstrap: async (work) => {
        admitted = true
        await backgroundBarrier
        return work()
      },
    })

    // bootstrapDirectory intentionally launches its staged work in the
    // background. Give the critical paint gate + test fallback delay time to
    // elapse while keeping auxiliary admission blocked.
    await new Promise((resolve) => setTimeout(resolve, 70))
    expect(calls).toEqual(["sessions"])
    expect(store.status).toBe("complete")
    expect(admitted).toBe(true)

    releaseBackground()
    await new Promise((resolve) => setTimeout(resolve, 40))
  })

  test("uses legacy MCP endpoints while refreshing a v1 directory", async () => {
    const legacyConfigReads: string[] = []
    const mcpReads: string[] = []
    const [store, setStore] = directoryState()

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: true,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: {
          get: async () => {
            legacyConfigReads.push("directory")
            return { data: {} }
          },
        },
        session: { status: async () => ({ data: {} }) },
        vcs: { get: async () => ({ data: undefined }) },
        command: {
          list: async () => {
            mcpReads.push("command")
            return { data: [] }
          },
        },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
        v2: { reference: { list: async () => ({ data: { data: [] } }) } },
        mcp: {
          status: async () => {
            mcpReads.push("status")
            return { data: {} }
          },
        },
        experimental: {
          resource: {
            list: async () => {
              mcpReads.push("resource")
              return { data: {} }
            },
          },
        },
        provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      } as unknown as OpencodeClient,
      serverSDK: {} as OpencodeClient,
      api,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      protocol: Promise.resolve("v1"),
    })

    expect(store.status).toBe("partial")

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
    expect(legacyConfigReads).toEqual(["directory"])
    expect(mcpReads.sort()).toEqual(["command", "resource", "status"])
  })

  test("skips legacy config while refreshing a v2 directory", async () => {
    const [store, setStore] = directoryState()

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        config: {
          get: async () => {
            throw new Error("legacy directory config should not be called")
          },
        },
      } as unknown as OpencodeClient,
      serverSDK: {} as OpencodeClient,
      api,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      protocol: Promise.resolve("v2"),
    })

    expect(store.status).toBe("partial")

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
  })
})

describe("config queries", () => {
  test("skips legacy global config for v2 servers", async () => {
    const sdk = {
      global: {
        config: {
          get: async () => {
            throw new Error("legacy global config should not be called")
          },
        },
      },
    } as unknown as OpencodeClient

    const result = await new QueryClient().fetchQuery(
      loadGlobalConfigQuery(ServerScope.local, sdk, Promise.resolve("v2")),
    )

    expect(result).toEqual({})
  })

  test("loads legacy global config for v1 servers", async () => {
    const calls: string[] = []
    const config = { shell: "zsh" } satisfies Config
    const sdk = {
      global: {
        config: {
          get: async () => {
            calls.push("global")
            return { data: config }
          },
        },
      },
    } as unknown as OpencodeClient

    const result = await new QueryClient().fetchQuery(
      loadGlobalConfigQuery(ServerScope.local, sdk, Promise.resolve("v1")),
    )

    expect(result).toEqual(config)
    expect(calls).toEqual(["global"])
  })
})

describe("global path ownership", () => {
  const path = { home: "/home", state: "/state", config: "/config", worktree: "", directory: "" }

  test("reads global metadata without requesting an instance path", async () => {
    let instanceReads = 0
    const sdk = {
      global: { health: async () => ({ data: { healthy: true, path } }) },
      path: { get: async () => { instanceReads++; return { data: path } } },
    } as unknown as OpencodeClient
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    expect(await query.fetchQuery(loadPathQuery(ServerScope.local, null, sdk, Promise.resolve("v1")))).toEqual(path)
    expect(instanceReads).toBe(0)
  })

  test.each([404, 405, 503])("health failure %s cannot bootstrap a default workspace", async (status) => {
    let instanceReads = 0
    const error = Object.assign(new Error(`health status ${status}`), { status })
    const sdk = {
      global: { health: async () => { throw error } },
      path: { get: async () => { instanceReads++; return { data: path } } },
    } as unknown as OpencodeClient
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await expect(query.fetchQuery(loadPathQuery(ServerScope.local, null, sdk, Promise.resolve("v1")))).rejects.toBe(error)
    expect(instanceReads).toBe(0)
  })

  test("missing health metadata cannot fall through to a directory-less path read", async () => {
    let instanceReads = 0
    const sdk = {
      global: { health: async () => ({ data: { healthy: true } }) },
      path: { get: async () => { instanceReads++; return { data: path } } },
    } as unknown as OpencodeClient
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await expect(query.fetchQuery(loadPathQuery(ServerScope.local, null, sdk, Promise.resolve("v1")))).rejects.toThrow(
      "global path metadata",
    )
    expect(instanceReads).toBe(0)
  })

  test("location path reads retain their explicit directory", async () => {
    const locations: unknown[] = []
    const sdk = {
      global: { health: async () => { throw new Error("global health is not required for an explicit location") } },
      path: { get: async (input: unknown) => { locations.push(input); return { data: { ...path, directory: "/repo" } } } },
    } as unknown as OpencodeClient
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    expect((await query.fetchQuery(loadPathQuery(ServerScope.local, "/repo", sdk, Promise.resolve("v1")))).directory).toBe("/repo")
    expect(locations).toEqual([{ directory: "/repo" }])
  })
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const client = {} as Parameters<typeof loadPathQuery>[2]
    const api = {} as CatalogApi
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadPathQuery(ServerScope.local, "/repo", client).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", client).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    expect([...loadProvidersQuery(remote, null, api).queryKey]).toEqual(["https://debian.example", null, "providers"])
  })

  test("canonicalizes Windows directory spellings in directory-scoped query keys", () => {
    const client = {} as Parameters<typeof loadPathQuery>[2]
    const catalog = {} as CatalogApi
    const agents = {} as AgentApi
    const references = {} as ReferenceApi
    const windows = "C:\\Users\\demo\\repo\\"
    const canonical = "C:/Users/demo/repo"

    expect([...loadPathQuery(ServerScope.local, windows, client).queryKey]).toEqual([
      ServerScope.local,
      canonical,
      "path",
    ])
    expect([...loadProvidersQuery(ServerScope.local, windows, catalog).queryKey]).toEqual([
      ServerScope.local,
      canonical,
      "providers",
    ])
    expect([...loadAgentsQuery(ServerScope.local, windows, agents).queryKey]).toEqual([
      ServerScope.local,
      canonical,
      "agents",
    ])
    expect([...loadReferencesQuery(ServerScope.local, windows, references).queryKey]).toEqual([
      ServerScope.local,
      canonical,
      "references",
    ])
  })

  test("the fork V1 catalog preserves explicit location and progressive status", async () => {
    const calls: unknown[] = []
    const legacy = { provider: { list: async (input: unknown) => {
      calls.push(input)
      return { data: { all: [], connected: [], default: {}, catalog: { status: "partial", revision: 3 } } }
    } } } as unknown as OpencodeClient
    const queryClient = new QueryClient()
    const result = await queryClient.fetchQuery(loadProvidersQuery(ServerScope.local, "/repo", {} as CatalogApi, legacy, Promise.resolve("v1")))
    expect(calls).toEqual([{ directory: "/repo" }])
    expect(result.catalog).toEqual({ status: "partial", revision: 3 })
    await queryClient.fetchQuery(loadProvidersQuery(ServerScope.local, null, {} as CatalogApi, legacy, Promise.resolve("v1")))
    expect(calls).toEqual([{ directory: "/repo" }, undefined])
  })

  test("loads the current provider and model catalog", async () => {
    const calls: unknown[] = []
    const api = {
      providers: {
        list: async (input: unknown) => {
          calls.push(["provider", input])
          return { location: {}, data: [{ id: "openai", name: "OpenAI", package: "@ai-sdk/openai" }] }
        },
      },
      models: {
        list: async (input: unknown) => {
          calls.push(["model", input])
          return { location: {}, data: [] }
        },
        default: async (input: unknown) => {
          calls.push(["default", input])
          return { location: {}, data: null }
        },
      },
    } as unknown as CatalogApi

    const result = await new QueryClient().fetchQuery(loadProvidersQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([
      ["provider", { location: { directory: "/repo" } }],
      ["model", { location: { directory: "/repo" } }],
      ["default", { location: { directory: "/repo" } }],
    ])
    expect(result.connected).toEqual(["openai"])
  })

  test("loads agents from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return {
          location: {},
          data: [
            {
              id: "explore",
              request: { headers: {}, body: {} },
              system: "resolved runtime prompt",
              description: "Explore files",
              mode: "subagent",
              hidden: false,
              permissions: [],
            },
          ],
        }
      },
    } as unknown as AgentApi

    const result = await new QueryClient().fetchQuery(loadAgentsQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toHaveLength(1)
    expect(result[0]?.name).toBe("explore")
    expect(result[0]?.prompt).toBe("resolved runtime prompt")
  })

  test("uses the fork V1 agent catalog on a server classified as v1", async () => {
    const currentCalls: unknown[] = []
    const legacyCalls: unknown[] = []
    const current = {
      list: async (input: unknown) => {
        currentCalls.push(input)
        return {
          location: {},
          data: [
            {
              id: "build",
              request: { headers: {}, body: {} },
              system: "resolved build system",
              mode: "primary",
              hidden: false,
              permissions: [],
            },
          ],
        }
      },
    } as unknown as AgentApi
    const legacy = {
      app: {
        agents: async (input: unknown) => {
          legacyCalls.push(input)
          return {
            data: [
              {
                name: "build",
                prompt: "resolved build system",
                mode: "primary",
                permission: [],
                options: {},
              },
            ],
          }
        },
      },
    } as unknown as OpencodeClient

    const result = await new QueryClient().fetchQuery(
      loadAgentsQuery(ServerScope.local, "/repo", current, legacy, Promise.resolve("v1")),
    )

    expect(currentCalls).toEqual([])
    expect(legacyCalls).toEqual([{ directory: "/repo" }])
    expect(result[0]?.name).toBe("build")
    expect(result[0]?.prompt).toBe("resolved build system")
  })

  test("does not schedule the current catalog behind a V1 agent read", async () => {
    let currentCalls = 0
    const legacyCalls: unknown[] = []
    const current = {
      list: async () => {
        currentCalls++
        throw { status: 404 }
      },
    } as unknown as AgentApi
    const legacy = {
      app: {
        agents: async (input: unknown) => {
          legacyCalls.push(input)
          return {
            data: [
              {
                name: "explore",
                prompt: "legacy prompt",
                mode: "subagent",
                permission: [],
                options: {},
              },
            ],
          }
        },
      },
    } as unknown as OpencodeClient

    const result = await new QueryClient().fetchQuery(
      loadAgentsQuery(ServerScope.local, "/repo", current, legacy, Promise.resolve("v1")),
    )

    expect(currentCalls).toBe(0)
    expect(legacyCalls).toEqual([{ directory: "/repo" }])
    expect(result[0]?.prompt).toBe("legacy prompt")
  })

  test("loads commands from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return {
          location: {},
          data: [{ name: "shell", template: "Run a shell command" /* source: "command" as const */ }],
        }
      },
    } as unknown as CommandApi

    const result = await loadCommands("/repo", api)

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toEqual([{ name: "shell", template: "Run a shell command" /* source: "command" */ }])
  })

  test("loads projects from the current endpoint", async () => {
    const api = {
      list: async () => [
        { id: "b", worktree: "/b", time: { created: 1, updated: 1 }, sandboxes: [] },
        { id: "a", worktree: "/a", time: { created: 1, updated: 1 }, sandboxes: [] },
      ],
    } as unknown as ProjectApi

    const result = await new QueryClient().fetchQuery(loadProjectsQuery(ServerScope.local, api))

    expect(result.map((project) => project.id)).toEqual(["a", "b"])
  })

  test("prefers the bootstrap-free global project catalog when available", async () => {
    let instanceCalls = 0
    let globalCalls = 0
    const projectApi = {
      list: async () => {
        instanceCalls++
        return [{ id: "instance", worktree: "/instance", time: { created: 1, updated: 1 }, sandboxes: [] }]
      },
    } as unknown as ProjectApi
    const globalClient = {
      global: {
        projects: async () => {
          globalCalls++
          return {
            data: [{ id: "global", worktree: "/global", time: { created: 1, updated: 1 }, sandboxes: [] }],
          }
        },
      },
    } as unknown as OpencodeClient

    const result = await new QueryClient().fetchQuery(
      loadProjectsQuery(ServerScope.local, projectApi, undefined, "critical", globalClient),
    )

    expect(result.map((project) => project.id)).toEqual(["global"])
    expect(globalCalls).toBe(1)
    expect(instanceCalls).toBe(0)
  })

  test.each([404, 405, 503])("global project failure %s cannot acquire an implicit workspace", async (status) => {
    let instanceCalls = 0
    const projectApi = {
      list: async () => {
        instanceCalls++
        return [{ id: "fallback", worktree: "/fallback", time: { created: 1, updated: 1 }, sandboxes: [] }]
      },
    } as unknown as ProjectApi
    const globalClient = {
      global: {
        projects: async () => {
          throw { status }
        },
      },
    } as unknown as OpencodeClient

    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await expect(query.fetchQuery(
      loadProjectsQuery(ServerScope.local, projectApi, undefined, "critical", globalClient),
    )).rejects.toEqual({ status })
    expect(instanceCalls).toBe(0)
  })

  test("loads references from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return { location: {}, data: [{ name: "AGENTS.md", path: "/repo/AGENTS.md", source: "instructions" }] }
      },
    } as unknown as ReferenceApi

    const result = await new QueryClient().fetchQuery(loadReferencesQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toHaveLength(1)
  })
})
