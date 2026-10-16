import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot, getOwner, onCleanup, type ParentProps } from "solid-js"
import { createTabMemory } from "./tab-memory"
import { nextTabAfterClose, pushClosedTab, removeClosedTabs, takeClosedTab, type ClosedTab } from "./closed-tabs"
import type { SessionTab, Tab } from "./tabs"
import type { useTabs } from "./tabs"
import { migrateTabs } from "./tab-migration"
import type { ServerConnection } from "./server"
import { appTabKey, appTabPageFromPathname, normalizeAppTabHref, oxpActivityIDFromPathname } from "./app-tabs"
import { isAbsoluteWorkspaceDirectory } from "@/utils/path-key"

const server = "local\nhttp://localhost:4096" as ServerConnection.Key

function sessionTab(sessionId: string): SessionTab {
  return { type: "session", server, sessionId }
}

describe("tab migration", () => {
  test("drops null and malformed persisted tabs", () => {
    expect(
      migrateTabs([null, sessionTab("a"), { type: "session", server }, { type: "unknown", server }, "invalid"], server),
    ).toEqual([sessionTab("a")])
  })

  test("adds the fallback server to valid legacy tabs", () => {
    expect(migrateTabs([{ type: "session", sessionId: "a", dirBase64: "legacy" }], server)).toEqual([sessionTab("a")])
  })

  test("replaces invalid top-level persisted data", () => {
    expect(migrateTabs(null, server)).toEqual([])
    expect(migrateTabs({}, server)).toEqual([])
  })

  test("drops drafts without an explicit absolute workspace location", () => {
    expect(
      migrateTabs(
        [
          { type: "draft", draftID: "global", server, directory: "global" },
          { type: "draft", draftID: "relative", server, directory: "workspace" },
          { type: "draft", draftID: "empty", server, directory: "" },
          { type: "draft", draftID: "win", server, directory: "C:\\work\\repo" },
          { type: "draft", draftID: "unc", server, directory: "\\\\host\\share\\repo" },
          { type: "draft", draftID: "posix", server, directory: "/work/repo" },
        ],
        server,
      ),
    ).toEqual([
      { type: "draft", draftID: "win", server, directory: "C:\\work\\repo" },
      { type: "draft", draftID: "unc", server, directory: "\\\\host\\share\\repo" },
      { type: "draft", draftID: "posix", server, directory: "/work/repo" },
    ])
  })

  test("recognizes absolute workspace paths and rejects transport sentinels", () => {
    expect(isAbsoluteWorkspaceDirectory("global")).toBe(false)
    expect(isAbsoluteWorkspaceDirectory("")).toBe(false)
    expect(isAbsoluteWorkspaceDirectory("relative/repo")).toBe(false)
    expect(isAbsoluteWorkspaceDirectory("C:\\work\\repo")).toBe(true)
    expect(isAbsoluteWorkspaceDirectory("\\\\host\\share\\repo")).toBe(true)
    expect(isAbsoluteWorkspaceDirectory("/work/repo")).toBe(true)
  })

  test("restores application tabs without coupling them to a server", () => {
    expect(
      migrateTabs(
        [
          { type: "app", page: "settings", href: "/settings?tab=models" },
          { type: "app", page: "usage", href: "/usage" },
          { type: "app", page: "agents", href: "/agents" },
          { type: "app", page: "oxp", href: "/oxp/activity/oxpa_example" },
          { type: "app", page: "unknown", href: "/unknown" },
        ],
        server,
      ),
    ).toEqual([
      { type: "app", page: "settings", href: "/settings?tab=models" },
      { type: "app", page: "usage", href: "/usage" },
      { type: "app", page: "agents", href: "/agents" },
      { type: "app", page: "oxp", href: "/oxp/activity/oxpa_example" },
    ])
  })

  test("restores independently persisted OXP activities without merging their tab identities", () => {
    const result = migrateTabs([
      { type: "app", page: "oxp", href: "/oxp/activity/oxpa_first" },
      { type: "app", page: "oxp", href: "/oxp/activity/oxpa_second" },
      { type: "app", page: "settings", href: "/settings" },
    ], server)
    expect(result).toHaveLength(3)
    expect(result.flatMap((tab) => tab.type === "app" ? [appTabKey(tab.page, tab.href)] : [])).toEqual([
      "app:oxp:oxpa_first", "app:oxp:oxpa_second", "app:settings",
    ])
  })

  test("keys OXP activity tabs by durable activity ID, not their app page", () => {
    expect(appTabKey("oxp", "/oxp/activity/oxpa_a")).toBe("app:oxp:oxpa_a")
    expect(appTabKey("oxp", "/oxp/activity/oxpa_b")).toBe("app:oxp:oxpa_b")
    expect(appTabKey("oxp", "/oxp/activity/oxpa_a?view=context#tool")).toBe("app:oxp:oxpa_a")
    expect(appTabKey("oxp", "/oxp")).toBe("app:oxp")
    expect(appTabKey("oxp", "/settings")).toBe("app:oxp")
    expect(appTabKey("settings", "/settings?tab=a")).toBe("app:settings")
    expect(appTabKey("settings", "/settings?tab=b")).toBe("app:settings")
    expect(appTabKey("usage", "/usage")).toBe("app:usage")
    expect(oxpActivityIDFromPathname("/oxp/activity/a%20b")).toBe("a b")
    expect(appTabKey("oxp", "/oxp/activity/a%20b")).toBe("app:oxp:a%20b")
    expect(oxpActivityIDFromPathname("/oxp/activity/%")).toBeUndefined()
    expect(oxpActivityIDFromPathname("/oxp/activity")).toBeUndefined()
  })
})

describe("application tab routes", () => {
  test("recognizes first-class application routes, including distinct OXP activity routes", () => {
    expect(appTabPageFromPathname("/settings")).toBe("settings")
    expect(appTabPageFromPathname("/usage")).toBe("usage")
    expect(appTabPageFromPathname("/scheduled")).toBe("scheduled")
    expect(appTabPageFromPathname("/agents")).toBe("agents")
    expect(appTabPageFromPathname("/oxp")).toBe("oxp")
    expect(appTabPageFromPathname("/oxp/activity/abc")).toBe("oxp")
    expect(appTabPageFromPathname("/oxp/activity")).toBeUndefined()
  })

  test("pins persisted hrefs to their own internal surface", () => {
    expect(normalizeAppTabHref("settings", "/settings?tab=providers#local")).toBe("/settings?tab=providers#local")
    expect(normalizeAppTabHref("settings", "/usage")).toBe("/settings")
    expect(normalizeAppTabHref("usage", "https://example.com/usage")).toBe("/usage")
    expect(normalizeAppTabHref("agents", "/agents?selected=review")).toBe("/agents?selected=review")
    expect(normalizeAppTabHref("oxp", "/oxp/activity/oxpa_example")).toBe("/oxp/activity/oxpa_example")
    expect(normalizeAppTabHref("oxp", "/settings")).toBe("/oxp")
  })
})

describe("tab memory", () => {
  test("keeps state until its tab is removed", () => {
    createRoot((dispose) => {
      const memory = createTabMemory(getOwner())
      let disposed = 0
      const first = memory.ensure("tab", "prompt", () => {
        onCleanup(() => disposed++)
        return { value: "prompt" }
      })

      expect(memory.ensure("tab", "prompt", () => ({ value: "other" }))).toBe(first)
      expect(memory.get<typeof first>("tab", "prompt")).toBe(first)
      expect(memory.get("missing", "prompt")).toBeUndefined()
      expect(memory.ensure("other", "prompt", () => ({ value: "other" }))).not.toBe(first)

      memory.remove("tab")
      expect(disposed).toBe(1)
      expect(memory.ensure("tab", "prompt", () => ({ value: "new" }))).not.toBe(first)
      dispose()
    })
  })
})

describe("closed tab stack", () => {
  test("records session tabs with their index", () => {
    const stack = pushClosedTab([], sessionTab("a"), 2)

    expect(stack).toEqual([{ tab: sessionTab("a"), index: 2 }])
  })

  test("ignores draft tabs", () => {
    const draft: Tab = { type: "draft", draftID: "d1", server, directory: "/tmp" }

    expect(pushClosedTab([], draft, 0)).toEqual([])
  })

  test("caps the stack size", () => {
    const stack = Array.from({ length: 30 }, (_, i) => i).reduce<ClosedTab[]>(
      (acc, i) => pushClosedTab(acc, sessionTab(`s${i}`), i),
      [],
    )

    expect(stack).toHaveLength(25)
    expect(stack[0]?.tab).toEqual(sessionTab("s5"))
    expect(stack.at(-1)?.tab).toEqual(sessionTab("s29"))
  })

  test("pops the most recently closed tab", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]
    const result = takeClosedTab(stack, [])

    expect(result.entry?.tab).toEqual(sessionTab("b"))
    expect(result.stack).toEqual([{ tab: sessionTab("a"), index: 0 }])
  })

  test("skips entries whose tab is already open", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]
    const result = takeClosedTab(stack, [sessionTab("b")])

    expect(result.entry?.tab).toEqual(sessionTab("a"))
    expect(result.stack).toEqual([])
  })

  test("returns no entry when everything is open or empty", () => {
    expect(takeClosedTab([], []).entry).toBeUndefined()

    const result = takeClosedTab([{ tab: sessionTab("a"), index: 0 }], [sessionTab("a")])
    expect(result.entry).toBeUndefined()
    expect(result.stack).toEqual([])
  })

  test("purges removed sessions", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]

    expect(removeClosedTabs(stack, server, ["a"])).toEqual([{ tab: sessionTab("b"), index: 1 }])
  })

  test("records OXP activity tabs, skips singleton pages, and reopens by activity identity", () => {
    const first: Tab = { type: "app", page: "oxp", href: "/oxp/activity/oxpa_a" }
    const second: Tab = { type: "app", page: "oxp", href: "/oxp/activity/oxpa_b" }
    const stack = pushClosedTab(pushClosedTab([], first, 1), second, 2)
    expect(stack).toHaveLength(2)
    expect(pushClosedTab(stack, { type: "app", page: "settings", href: "/settings" }, 3)).toEqual(stack)
    expect(pushClosedTab(stack, { type: "app", page: "oxp", href: "/oxp" }, 3)).toEqual(stack)
    expect(takeClosedTab(stack, [second]).entry?.tab).toEqual(first)
    expect(takeClosedTab(stack, []).entry?.tab).toEqual(second)
    expect(removeClosedTabs(stack, server, ["irrelevant"])).toEqual(stack)
  })

  test("does not navigate when a background tab closes", () => {
    const tabs = [sessionTab("a"), sessionTab("b"), sessionTab("c")]

    expect(nextTabAfterClose(tabs, 1, false)).toBeUndefined()
    expect(nextTabAfterClose(tabs, 1, true)).toEqual(sessionTab("c"))
    expect(nextTabAfterClose([sessionTab("a")], 0, true)).toBeNull()
  })
})

type TabsStore = ReturnType<typeof useTabs>
type PersistModule = typeof import("@/utils/persist")

describe("tab batch close", () => {
  let tabs: TabsStore
  let tabKey: (tab: Tab) => string
  let TabsProvider: (typeof import("@/context/tabs"))["TabsProvider"]
  let useTabsStore: (typeof import("@/context/tabs"))["useTabs"]
  let Persist: PersistModule["Persist"]
  let draftPersistedKeys: PersistModule["draftPersistedKeys"]
  const navigateCalls: string[] = []
  let pathname = "/"

  // The tabs store is created through context providers. Bun's unit-test build
  // compiles TSX with the React runtime, so the JSX-bearing `@opencode-ai/ui/context`
  // provider helper cannot be imported — swap it for a JSX-free double of the same
  // createSimpleContext contract (init once, expose via use), and fake the router /
  // platform / server contexts the store reads. The store module is imported after
  // the mocks so they win; the batch-close semantics under test are the real ones.
  beforeAll(async () => {
    // Bun's unit-test build resolves `solid-js` to its SSR build, whose
    // `createResource` only works inside a hydration context - the tabs store
    // (via persist.ts) uses `createResource` for its readiness gate. Redirect
    // `solid-js` to the client build so the store runs as it does in the app.
    // @ts-expect-error - the client build ships no bundled declarations; the API
    // matches `solid-js` (same exports, client implementation).
    const clientSolid = (await import("solid-js/dist/solid.js")) as typeof import("solid-js")
    mock.module("solid-js", () => ({ ...clientSolid }))
    mock.module("@opencode-ai/ui/context", () => {
      const createSimpleContext = <T, Props extends Record<string, any>>(input: {
        name: string
        init: (props: Props) => T
      }) => {
        let current: T | undefined
        return {
          provider: (props: ParentProps<Props>) => {
            current = input.init(props)
            return props.children
          },
          use: () => {
            if (!current) throw new Error(`${input.name} context must be used within a context provider`)
            return current
          },
        }
      }
      return { createSimpleContext }
    })
    const fakeConnection = { type: "sidecar", variant: "base", http: { url: "http://localhost:4096" } } as const
    const serverModule = {
      useServer: () => ({
        key: server,
        list: [fakeConnection],
      }),
      ServerConnection: {
        key: () => server,
        Key: { make: (value: string) => value as ServerConnection.Key },
      },
    }
    mock.module("./server", () => serverModule)
    mock.module("./platform", () => ({
      usePlatform: () => ({}),
    }))
    mock.module("@solidjs/router", () => ({
      useNavigate: () => (href: string) => {
        navigateCalls.push(href)
        pathname = href
      },
      useParams: () => ({}),
      useLocation: () => ({ get pathname() { return pathname }, query: {} }),
    }))
    ;({ TabsProvider, useTabs: useTabsStore, tabKey } = await import("@/context/tabs"))
    ;({ Persist, draftPersistedKeys } = await import("@/utils/persist"))
  })

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  const mount = (seed: { tabs?: Tab[]; recent?: { key?: string }; closed?: ClosedTab[] }) => {
    localStorage.clear()
    navigateCalls.length = 0
    pathname = "/"
    if (seed.tabs) localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify(seed.tabs))
    if (seed.recent) localStorage.setItem("opencode.window.browser.dat:tabs.recent", JSON.stringify(seed.recent))
    if (seed.closed) localStorage.setItem("opencode.window.browser.dat:tabs.closed", JSON.stringify(seed.closed))
    createRoot(() => {
      TabsProvider({} as never)
      tabs = useTabsStore()
    })
  }

  const sessionIDs = () =>
    tabs.store.flatMap((tab) => (tab.type === "session" ? [tab.sessionId] : []))

  test("opens application surfaces as singleton tabs and refreshes their route", async () => {
    mount({ tabs: [sessionTab("a")] })

    tabs.openAppTab("settings", "/settings?tab=models")
    await flush()
    expect(tabs.store.filter((tab) => tab.type === "app")).toEqual([
      { type: "app", page: "settings", href: "/settings?tab=models" },
    ])
    expect(navigateCalls.at(-1)).toBe("/settings?tab=models")

    tabs.openAppTab("settings", "/settings?tab=providers")
    await flush()
    expect(tabs.store.filter((tab) => tab.type === "app")).toEqual([
      { type: "app", page: "settings", href: "/settings?tab=providers" },
    ])
    expect(navigateCalls.at(-1)).toBe("/settings?tab=providers")
  })

  test("keeps server-neutral application tabs during server pruning", async () => {
    mount({
      tabs: [
        { type: "app", page: "usage", href: "/usage" },
        sessionTab("a"),
      ],
    })
    await flush()

    expect(tabs.store.some((tab) => tab.type === "app" && tab.page === "usage")).toBe(true)
    expect(sessionIDs()).toEqual(["a"])
  })

  test("records each batch-closed session tab in the reopen stack with a sane index", async () => {
    mount({ tabs: [sessionTab("a"), sessionTab("b"), sessionTab("c"), sessionTab("d")] })
    tabs.select(sessionTab("c"))
    tabs.closeTabsLeftOf(3)
    await flush()

    expect(sessionIDs().join("")).toBe("d")

    // Reopening restores every closed tab at its original position, which
    // holds only if each entry recorded its own (shrinking-array) index.
    tabs.reopenClosedTab()
    await flush()
    tabs.reopenClosedTab()
    await flush()
    tabs.reopenClosedTab()
    await flush()
    expect(sessionIDs().join("")).toBe("abcd")
  })

  test("removes persisted draft state for batch-closed drafts", async () => {
    const draftID = "d1"
    const draft: Tab = { type: "draft", draftID, server, directory: "/tmp" }
    for (const key of draftPersistedKeys()) {
      const target = Persist.draft(draftID, key)
      localStorage.setItem(`${target.storage}:${target.key}`, JSON.stringify({ value: key }))
    }
    mount({ tabs: [draft, sessionTab("a"), sessionTab("b")] })
    tabs.select(sessionTab("b"))
    tabs.closeTabsLeftOf(1)
    await flush()

    expect(sessionIDs().join("")).toBe("ab")
    for (const key of draftPersistedKeys()) {
      const target = Persist.draft(draftID, key)
      expect(localStorage.getItem(`${target.storage}:${target.key}`)).toBeNull()
    }
    // Drafts are never recorded in the reopen stack.
    tabs.reopenClosedTab()
    await flush()
    expect(sessionIDs().join("")).toBe("ab")
  })

  test("close-left keeps an active tab to the right active and un-navigated", async () => {
    mount({ tabs: [sessionTab("a"), sessionTab("b"), sessionTab("c")] })
    const before = navigateCalls.length
    tabs.select(sessionTab("c"))
    tabs.closeTabsLeftOf(1)
    await flush()

    expect(sessionIDs().join("")).toBe("bc")
    expect(navigateCalls.length).toBe(before + 1) // only the explicit select
    // recentKey still points at the active tab c
    tabs.toggleHome({ home: true })
    expect(navigateCalls.at(-1)).not.toBe("/")
  })

  test("close-left navigates to the anchor when the active tab is in the closed range", async () => {
    mount({ tabs: [sessionTab("a"), sessionTab("b"), sessionTab("c")] })
    tabs.select(sessionTab("a"))
    tabs.closeTabsLeftOf(2)
    await flush()

    expect(sessionIDs().join("")).toBe("c")
    expect(navigateCalls.at(-1)).toMatch(/\/session\/c$/)
  })

  test("close-all empties the store, navigates home and clears recentKey", async () => {
    mount({ tabs: [sessionTab("a"), sessionTab("b"), sessionTab("c")] })
    tabs.select(sessionTab("b"))
    tabs.closeAllTabs()
    await flush()

    expect(tabs.store).toHaveLength(0)
    expect(navigateCalls.at(-1)).toBe("/")
    // recentKey cleared: toggling home finds no tab and does not navigate again
    const before = navigateCalls.length
    tabs.toggleHome({ home: true })
    expect(navigateCalls.length).toBe(before)
  })

  test("close-all with a large batch empties the store in a single update", async () => {
    const many = Array.from({ length: 60 }, (_, i) => sessionTab(String(i)))
    mount({ tabs: many })
    tabs.select(sessionTab("30"))
    const before = navigateCalls.length
    tabs.closeAllTabs()
    await flush()

    expect(tabs.store).toHaveLength(0)
    // exactly one navigation for the whole batch, not one per closed tab
    expect(navigateCalls.length).toBe(before + 1)
    expect(navigateCalls.at(-1)).toBe("/")
  })

  test("close-others with the anchor tab active keeps the anchor", async () => {
    mount({ tabs: [sessionTab("a"), sessionTab("b"), sessionTab("c")] })
    const before = navigateCalls.length
    tabs.select(sessionTab("b"))
    tabs.closeOtherTabs(1)
    await flush()

    expect(sessionIDs().join("")).toBe("b")
    expect(navigateCalls.length).toBe(before + 1) // only the explicit select
    // recentKey stays on the anchor
    tabs.toggleHome({ home: true })
    expect(navigateCalls.at(-1)).not.toBe("/")
  })

  test("close-right navigates to the anchor when the active tab is in the closed range", async () => {
    mount({ tabs: [sessionTab("a"), sessionTab("b"), sessionTab("c"), sessionTab("d")] })
    tabs.select(sessionTab("c"))
    tabs.closeTabsRightOf(1)
    await flush()

    expect(sessionIDs().join("")).toBe("ab")
    // active tab c was closed → fixup lands on the nearest survivor to the left
    expect(navigateCalls.at(-1)).toMatch(/\/session\/b$/)
  })

  test("close-all from home stays on home without spurious navigation", async () => {
    mount({ tabs: [sessionTab("a"), sessionTab("b"), sessionTab("c")] })
    const before = navigateCalls.length
    tabs.closeAllTabs()
    await flush()

    expect(tabs.store).toHaveLength(0)
    expect(navigateCalls.length).toBe(before) // no navigation at all
  })

  test("opens and selects independent OXP activities without replacing existing tabs", async () => {
    mount({ tabs: [sessionTab("a")] })
    tabs.openAppTab("oxp", "/oxp/activity/oxpa_first")
    tabs.openAppTab("oxp", "/oxp/activity/oxpa_second")
    await flush()
    expect(tabs.store.map(tabKey)).toEqual([
      tabKey(sessionTab("a")), "app:oxp:oxpa_first", "app:oxp:oxpa_second",
    ])
    expect(navigateCalls.at(-1)).toBe("/oxp/activity/oxpa_second")

    const first = tabs.store.find((tab) => tabKey(tab) === "app:oxp:oxpa_first")
    expect(first).toBeDefined()
    tabs.select(first!)
    expect(navigateCalls.at(-1)).toBe("/oxp/activity/oxpa_first")

    tabs.openAppTab("oxp", "/oxp/activity/oxpa_first?view=context")
    await flush()
    expect(tabs.store.filter((tab) => tab.type === "app")).toHaveLength(2)
    expect(tabKey(tabs.store.at(-1)!)).toBe("app:oxp:oxpa_second")
    expect(navigateCalls.at(-1)).toBe("/oxp/activity/oxpa_first?view=context")

    const index = tabs.store.findIndex((tab) => tabKey(tab) === "app:oxp:oxpa_first")
    tabs.closeTab(index)
    await flush()
    expect(tabs.store.map(tabKey)).toContain("app:oxp:oxpa_second")
    expect(tabs.store.map(tabKey)).not.toContain("app:oxp:oxpa_first")
    tabs.reopenClosedTab()
    await flush()
    expect(tabs.store.map(tabKey)).toContain("app:oxp:oxpa_first")
    expect(navigateCalls.at(-1)).toBe("/oxp/activity/oxpa_first?view=context")
  })

  test("purges a deleted OXP activity tab and its reopen history only", async () => {
    mount({ tabs: [
      { type: "app", page: "oxp", href: "/oxp/activity/oxpa_first" },
      { type: "app", page: "oxp", href: "/oxp/activity/oxpa_second" },
    ] })
    tabs.closeTab(0)
    await flush()
    tabs.removeOxpActivityTab("oxpa_first")
    tabs.reopenClosedTab()
    await flush()
    expect(tabs.store.map(tabKey)).toEqual(["app:oxp:oxpa_second"])
    tabs.removeOxpActivityTab("oxpa_second")
    await flush()
    expect(tabs.store).toHaveLength(0)
  })

  test("stores individual OXP display titles without changing tab identity", async () => {
    const first: Tab = { type: "app", page: "oxp", href: "/oxp/activity/oxpa_first" }
    const second: Tab = { type: "app", page: "oxp", href: "/oxp/activity/oxpa_second" }
    mount({ tabs: [first, second] })
    await flush()
    tabs.rememberAppTabTitle(first, "First ChatGPT Conversation")
    tabs.rememberAppTabTitle(second, "Second ChatGPT Conversation")
    tabs.rememberAppTabTitle(first, "Renamed Conversation")
    await flush()
    expect(tabs.info[tabKey(first)]?.title).toBe("Renamed Conversation")
    expect(tabs.info[tabKey(second)]?.title).toBe("Second ChatGPT Conversation")
    expect(tabs.store.map(tabKey)).toEqual(["app:oxp:oxpa_first", "app:oxp:oxpa_second"])
  })
})
