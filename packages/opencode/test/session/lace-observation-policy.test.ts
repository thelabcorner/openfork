import { expect, test } from "bun:test"
import { laceObservePolicy, laceObserveScope } from "../../src/session/llm/lace-observation-policy"

test("LACE native observation is disabled unless explicitly enabled", () => {
  expect(laceObservePolicy("session", {})).toBe(false)
  expect(laceObservePolicy("session", { OPENFORK_LACE_OBSERVE_NATIVE: "0" })).toBe(false)
  expect(laceObservePolicy("", { OPENFORK_LACE_OBSERVE_NATIVE: "1" })).toBe(false)
  expect(laceObservePolicy("session", {
    OPENFORK_LACE_OBSERVE_NATIVE: "1", OPENFORK_LACE_OBSERVE_EVERY: "1",
  })).toBe(true)
})

test("invalid sampling configuration fails closed, with stable session-level selection", () => {
  for (const value of ["0", "-1", "foo", "1.2", "1025"]) {
    expect(laceObservePolicy("session", {
      OPENFORK_LACE_OBSERVE_NATIVE: "1", OPENFORK_LACE_OBSERVE_EVERY: value,
    })).toBe(false)
  }
  const environment = { OPENFORK_LACE_OBSERVE_NATIVE: "1", OPENFORK_LACE_OBSERVE_EVERY: "8" }
  for (let i = 0; i < 100; i++) {
    const key = "session-" + i
    expect(laceObservePolicy(key, environment)).toBe(laceObservePolicy(key, environment))
  }
  const samples = Array.from({ length: 100 }, (_, i) => laceObservePolicy("session-" + i, environment)).filter(Boolean)
  expect(samples.length).toBeGreaterThan(0)
  expect(samples.length).toBeLessThan(100)
})

test("account, workspace and isolated continuation produce separate observation scopes", () => {
  const base = {
    projectID: "project", directory: "/repo", worktree: "/repo",
    sessionID: "parent", routeKind: "account" as const, accountID: "one",
    continuity: "session" as const, requestID: "msg-1",
  }
  const primary = laceObserveScope(base)!
  expect(primary.session).toBe("parent")
  expect(laceObserveScope({ ...base, accountID: "two" })?.owner).not.toBe(primary.owner)
  expect(laceObserveScope({ ...base, projectID: "other" })?.owner).not.toBe(primary.owner)
  const isolated = laceObserveScope({ ...base, continuity: "isolated" })!
  expect(isolated.session).not.toBe(primary.session)
  expect(laceObserveScope({ ...base, continuity: "isolated", requestID: "msg-2" })?.session).not.toBe(isolated.session)
  expect(laceObserveScope({ ...base, accountID: "" })).toBeUndefined()
  expect(laceObserveScope({ ...base, requestID: "" })).toBeUndefined()
})
