import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot, getOwner, onCleanup, type ParentProps } from "solid-js"
import { createTabMemory } from "./tab-memory"
import { nextTabAfterClose, pushClosedTab, removeClosedTabs, takeClosedTab, type ClosedTab } from "./closed-tabs"
import type { SessionTab, Tab } from "./tabs"
import type { useTabs } from "./tabs"
import { migrateTabs } from "./tab-migration"
import type { ServerConnection } from "./server"

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
    expect(stack[0]?.tab.sessionId).toBe("s5")
    expect(stack.at(-1)?.tab.sessionId).toBe("s29")
  })

  test("pops the most recently closed tab", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]
    const result = takeClosedTab(stack, [])

    expect(result.entry?.tab.sessionId).toBe("b")
    expect(result.stack).toEqual([{ tab: sessionTab("a"), index: 0 }])
  })

  test("skips entries whose tab is already open", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]
    const result = takeClosedTab(stack, [sessionTab("b")])

    expect(result.entry?.tab.sessionId).toBe("a")
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
    ;({ TabsProvider, useTabs: useTabsStore } = await import("@/context/tabs"))
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
})
