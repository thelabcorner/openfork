import { expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createSessionGroupRequestGenerations } from "./session-group-request-generation"

test("server-specific group detail snapshots never borrow matching IDs from another server", () => {
  createRoot((dispose) => {
    type Detail = { group: { id: string }; sessions: { id: string }[] }
    const [details, setDetails] = createStore<Record<string, Record<string, Detail>>>({})
    const local = "session-groups:local"
    const remote = "session-groups:remote"
    let owner = local
    const scoped = createMemo(() => details[owner]?.same?.sessions ?? [])
    try {
      setDetails(local, reconcile({ same: { group: { id: "same" }, sessions: [{ id: "local-session" }] } }))
      setDetails(remote, reconcile({ same: { group: { id: "same" }, sessions: [{ id: "remote-session" }] } }))
      expect(scoped().map((member) => member.id)).toEqual(["local-session"])
      // Source-scoped access gives the right answer even after switching
      // selected server; it does not rely on group ID global uniqueness.
      owner = remote
      expect(details[owner]?.same?.sessions.map((member) => member.id)).toEqual(["remote-session"])
      setDetails(local, reconcile({ same: { group: { id: "same" }, sessions: [{ id: "new-local-session" }] } }))
      expect(details[remote]?.same?.sessions.map((member) => member.id)).toEqual(["remote-session"])
      expect(details[local]?.same?.sessions.map((member) => member.id)).toEqual(["new-local-session"])
    } finally {
      dispose()
    }
  })
})

test("newer server-local refresh invalidates old responses without blocking other servers", () => {
  const requests = createSessionGroupRequestGenerations()
  const local = "session-groups:local"
  const remote = "session-groups:remote"
  const firstLocal = requests.advance(local)
  const firstRemote = requests.advance(remote)
  const duplicateKey = requests.dedupeKey(local, "same", firstLocal)
  expect(duplicateKey).not.toBe(requests.dedupeKey(remote, "same", firstRemote))
  expect(requests.valid(local, firstLocal)).toBe(true)
  const secondLocal = requests.advance(local)
  expect(requests.valid(local, firstLocal)).toBe(false)
  expect(requests.valid(local, secondLocal)).toBe(true)
  expect(requests.valid(remote, firstRemote)).toBe(true)
  expect(requests.dedupeKey(local, "same", firstLocal)).not.toBe(
    requests.dedupeKey(local, "same", secondLocal),
  )
})

test("out-of-order batch and fallback responses apply only to their initiating server and generation", async () => {
  const requests = createSessionGroupRequestGenerations()
  const current = new Map<string, string>()
  const slots = new Map<string, (value: string) => void>()
  const schedule = (scope: string, name: string) => {
    const generation = requests.advance(scope)
    const pending = new Promise<string>((resolve) => slots.set(name, resolve))
    return pending.then((value) => {
      if (!requests.valid(scope, generation)) return
      current.set(scope, value)
    })
  }
  const oldLocal = schedule("local", "oldLocal")
  const remote = schedule("remote", "remote")
  const freshLocal = schedule("local", "freshLocal")
  slots.get("freshLocal")?.("fresh")
  slots.get("remote")?.("remote-only")
  slots.get("oldLocal")?.("stale")
  await Promise.all([oldLocal, remote, freshLocal])
  expect(current.get("local")).toBe("fresh")
  expect(current.get("remote")).toBe("remote-only")
})

test("disconnected generation state is releasable without accepting a late response on same-key reconnection", () => {
  const requests = createSessionGroupRequestGenerations()
  const scope = "session-groups:sidecar"
  const old = requests.current(scope)
  expect(requests.valid(scope, old)).toBe(true)
  requests.forget(scope)
  expect(requests.valid(scope, old)).toBe(false)
  const fresh = requests.current(scope)
  expect(fresh).not.toBe(old)
  expect(requests.valid(scope, old)).toBe(false)
  expect(requests.valid(scope, fresh)).toBe(true)
  for (let i = 0; i < 10_000; i++) {
    const transient = `session-groups:temporary-${i}`
    const version = requests.current(transient)
    requests.forget(transient)
    expect(requests.valid(transient, version)).toBe(false)
  }
  expect(requests.valid(scope, fresh)).toBe(true)
})