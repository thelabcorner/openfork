import { expect, test } from "bun:test"
import type { ServerConnection } from "./server"
import type { Tab } from "./tabs"
import { appendSessionTabs, missingSessionTabs } from "./tab-session-batch"

const local = "local" as ServerConnection.Key
const remote = "remote" as ServerConnection.Key

test("bulk session tabs retain insertion order, ignore duplicates, and distinguish servers", () => {
  const tabs: Tab[] = [
    { type: "session", server: local, sessionId: "existing" },
    { type: "session", server: remote, sessionId: "same" },
    { type: "group", server: local, groupId: "workers" },
    { type: "app", page: "usage", href: "/usage" },
    { type: "draft", draftID: "draft", server: local, directory: "/repo" },
  ]
  const before = JSON.stringify(tabs)
  expect(missingSessionTabs(tabs, local, ["existing", "same", "new", "same", "new", "second"]))
    .toEqual([
      { type: "session", server: local, sessionId: "same" },
      { type: "session", server: local, sessionId: "new" },
      { type: "session", server: local, sessionId: "second" },
    ])
  expect(missingSessionTabs(tabs, local, ["existing", "existing"])).toEqual([])
  expect(JSON.stringify(tabs)).toBe(before)
})

test("a very large bulk append remains below the engine's argument limit", () => {
  const additions = missingSessionTabs([], local, Array.from({ length: 100_000 }, (_, index) => `ses_${index}`))
  const tabs: Tab[] = [{ type: "session", server: local, sessionId: "existing" }]
  appendSessionTabs(tabs, additions)
  expect(tabs).toHaveLength(100_001)
  expect(tabs[0]).toEqual({ type: "session", server: local, sessionId: "existing" })
  expect(tabs.at(-1)).toEqual({ type: "session", server: local, sessionId: "ses_99999" })
  expect(new Set(tabs.filter((tab) => tab.type === "session").map((tab) => tab.sessionId)).size).toBe(100_001)
})

test("bulk append is equivalent to sequential insertion for deterministic mixes", () => {
  let seed = 0xabcdef98
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
  for (let size = 0; size <= 200; size++) {
    const current: Tab[] = Array.from({ length: size }, (_, i) => ({
      type: "session" as const, server: i % 3 ? local : remote, sessionId: `ses_${i % 100}`,
    }))
    const incoming = Array.from({ length: size * 2 + 3 }, () => `ses_${random() % 300}`)
    const legacy = [...current]
    for (const sessionId of incoming) {
      if (legacy.some((tab) => tab.type === "session" && tab.server === local && tab.sessionId === sessionId)) continue
      legacy.push({ type: "session", server: local, sessionId })
    }
    const batched = [...current, ...missingSessionTabs(current, local, incoming)]
    expect(batched).toEqual(legacy)
  }
})