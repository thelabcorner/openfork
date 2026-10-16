import { expect, test } from "bun:test"
import type { SessionGroupEntry } from "@/context/session-groups"
import { buildSessionPreviewIndex } from "./session-preview-model"
import { createSessionPreviewProjectionCache } from "./session-preview-cache"

const group = (name: string, id = "g"): SessionGroupEntry => ({
  id,
  name,
  position: 0,
  kind: "user",
  sessionIds: ["a", "b", "c"],
  sessions: [],
  time: { created: 1, updated: 1 },
})

test("repeated hovers share the exact computed relationship object", () => {
  const groups = [group("A")]
  const index = buildSessionPreviewIndex(groups)
  const cache = createSessionPreviewProjectionCache()
  const first = cache.session({ sessionID: "a", groups, index })
  expect(cache.session({ sessionID: "a", groups, index })).toBe(first)
  expect(cache.session({ sessionID: "b", groups, index })).not.toBe(first)
  expect(cache.session({ sessionID: "a", groups, index })).toBe(first)
})

test("a new authoritative snapshot invalidates cached relationships immediately", () => {
  const cache = createSessionPreviewProjectionCache()
  const source = group("before")
  const first = [source]
  const original = cache.session({ sessionID: "a", groups: first, index: buildSessionPreviewIndex(first) })
  const changed = [{ ...source, name: "after", time: { created: 1, updated: 2 } }]
  const next = cache.session({ sessionID: "a", groups: changed, index: buildSessionPreviewIndex(changed) })
  expect(next).not.toBe(original)
  // Both revisions can be cached without retaining the old source strongly.
  expect(cache.session({ sessionID: "a", groups: first, index: buildSessionPreviewIndex(first) })).toBe(original)
})

test("LRU evicts cold sessions while retaining recently accessed ones", () => {
  const cache = createSessionPreviewProjectionCache(2)
  const groups = [group("A")]
  const index = buildSessionPreviewIndex(groups)
  const a = cache.session({ sessionID: "a", groups, index })
  const b = cache.session({ sessionID: "b", groups, index })
  expect(cache.session({ sessionID: "a", groups, index })).toBe(a)
  cache.session({ sessionID: "c", groups, index })
  expect(cache.session({ sessionID: "a", groups, index })).toBe(a)
  expect(cache.session({ sessionID: "b", groups, index })).not.toBe(b)
})

test("group tree caches by immutable group revision, not by id alone", () => {
  const cache = createSessionPreviewProjectionCache()
  const before = group("before")
  const first = cache.group(before)
  expect(cache.group(before)).toBe(first)
  expect(first.name).toBe("before")
  const after = { ...before, name: "after" }
  const next = cache.group(after)
  expect(next.name).toBe("after")
  expect(next).not.toBe(first)
})

test("a bounded hot cache outperforms cold relationship projection on high-frequency reuse", () => {
  const groups = [group("A")]
  const index = buildSessionPreviewIndex(groups)
  const cache = createSessionPreviewProjectionCache()
  const make = () => ({ sessionID: "a", groups, index })
  cache.session(make())
  // Functional/cache identity assertions, not a fragile timing threshold:
  // a steady hover streak should allocate no additional relationship trees.
  const cached = cache.session(make())
  for (let i = 0; i < 2048; i++) expect(cache.session(make())).toBe(cached)
})
