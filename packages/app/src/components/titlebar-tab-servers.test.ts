import { expect, test } from "bun:test"
import type { Tab } from "@/context/tabs"
import type { ServerConnection } from "@/context/server"
import { indexTabServerContexts } from "./titlebar-tab-servers"

test("server contexts are resolved once per referenced server, ignoring drafts, apps and absent connections", () => {
  const main = "main" as ServerConnection.Key
  const remote = "remote" as ServerConnection.Key
  const draftOnly = "draft-only" as ServerConnection.Key
  const offline = "offline" as ServerConnection.Key
  const tabs: Tab[] = [
    { type: "session", sessionId: "a", server: main },
    { type: "session", sessionId: "b", server: main },
    { type: "group", groupId: "c", server: remote },
    { type: "draft", draftID: "d", directory: "/tmp", server: draftOnly },
    { type: "app", page: "settings", href: "/settings" },
    { type: "session", sessionId: "missing", server: offline },
  ]
  const connections = new Map<ServerConnection.Key, { url: string }>([[main, { url: "one" }], [remote, { url: "two" }], [draftOnly, { url: "three" }]])
  let calls = 0
  const ensure = (connection: { url: string }) => {
    calls++
    return { ...connection, runtime: true }
  }
  const result = indexTabServerContexts(tabs, connections, ensure)
  expect(calls).toBe(2)
  expect([...result.keys()]).toEqual([main, remote])
  expect(result.get(main)?.url).toBe("one")
  expect(result.has(offline)).toBe(false)

  // Replacing a live connection is handled by the next reactive projection;
  // the old context cannot be accidentally reused solely by key.
  const changed = new Map(connections)
  changed.set(main, { url: "updated" })
  const next = indexTabServerContexts(tabs, changed, ensure)
  expect(calls).toBe(4)
  expect(next.get(main)?.url).toBe("updated")
})