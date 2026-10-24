import { expect, test } from "bun:test"
import { OxpDiagnostics } from "@/oxp/diagnostics"

class SqlError extends Error {
  reason?: unknown
  constructor(reason?: unknown) {
    super("private database error context must not leak")
    this.reason = reason
  }
}

class EffectDrizzleQueryError extends Error {
  reason?: unknown
  constructor(reason?: unknown) {
    super("sensitive Drizzle statement and parameter payload")
    this.reason = reason
  }
}

test("SQLite incident classifier unwraps adapter errors and bounded Effect reasons without exposing SQL", () => {
  const examples = [
    [new EffectDrizzleQueryError({ cause: { code: "SQLITE_BUSY", message: "secret parameter" } }), "SQLITE_BUSY"],
    [new EffectDrizzleQueryError({ reasons: [{ cause: { code: "SQLITE_CONSTRAINT_FOREIGNKEY" } }] }), "SQLITE_CONSTRAINT_FOREIGNKEY"],
    [new EffectDrizzleQueryError({ reasons: [{ reason: { errno: 517 } }] }), "SQLITE_BUSY_SNAPSHOT"],
    [new EffectDrizzleQueryError(), "SQLITE_UNCLASSIFIED"],
  ] as const
  for (const [cause, expected] of examples) {
    const result = OxpDiagnostics.record({ cause, phase: "activity_recording", activityOperation: "link" })
    expect(result.errorName).toBe("EffectDrizzleQueryError")
    expect(result.errorCode).toBe(expected)
    expect(JSON.stringify(result)).not.toContain("sensitive Drizzle")
    expect(JSON.stringify(result)).not.toContain("secret parameter")
  }
  const unrelated = OxpDiagnostics.record({
    cause: Object.assign(new Error("SQLITE_BUSY"), { reason: { code: "SQLITE_BUSY" } }),
    phase: "tool_boundary",
  })
  expect(unrelated.errorCode).toBeUndefined()
})

test("OXP SQL incidents preserve safe native codes across Effect's reason/cause wrapping", () => {
  for (const [cause, expected] of [
    [new SqlError({ cause: { code: "SQLITE_BUSY_SNAPSHOT", errno: 517, message: "secret parameter" } }), "SQLITE_BUSY_SNAPSHOT"],
    [new SqlError({ reason: { cause: { code: "SQLITE_CONSTRAINT_UNIQUE", errno: 2067 } } }), "SQLITE_CONSTRAINT_UNIQUE"],
    [new SqlError({ cause: { errno: 5 } }), "SQLITE_BUSY"],
    [new SqlError({ message: "Failed to execute statement class=INSERT sqlite=SQLITE_SCHEMA" }), "SQLITE_SCHEMA"],
    [new SqlError(), "SQLITE_UNCLASSIFIED"],
  ] as const) {
    const result = OxpDiagnostics.record({ cause, phase: "activity_recording", tool: "read" })
    expect(result.errorName).toBe("SqlError")
    expect(result.errorCode).toBe(expected)
    expect(JSON.stringify(result)).not.toContain("secret")
    expect(JSON.stringify(result)).not.toContain("private database error context")
  }
})

test("diagnostics never interpret user exception messages or custom fields as native SQL failures", () => {
  const result = OxpDiagnostics.record({
    cause: Object.assign(new Error("User mentioned SQLITE_BUSY and private query"), {
      reason: { code: "SQLITE_BUSY", privateQuery: "SELECT sensitive_fields FROM private_table" },
    }),
    phase: "tool_boundary",
  })
  expect(result.errorCode).toBeUndefined()
  expect(result.errorName).toBe("Error")
  expect(JSON.stringify(result)).not.toContain("private")
  expect(JSON.stringify(result)).not.toContain("SQLITE_BUSY")
})

test("unexpected error objects remain safely bounded and cyclic SqlError wrappers terminate", () => {
  const cycle: { cause?: unknown } = {}
  cycle.cause = cycle
  const error = new SqlError(cycle)
  const result = OxpDiagnostics.record({ cause: error, phase: "activity_recording", tool: "process" })
  expect(result.errorCode).toBe("SQLITE_UNCLASSIFIED")
  expect(JSON.stringify(result).length).toBeLessThan(2000)
})

test("activity SQLite incidents identify a fixed operation without disclosing SQL", () => {
  const result = OxpDiagnostics.record({
    cause: new SqlError({ code: "SQLITE_BUSY" }),
    phase: "activity_recording",
    activityOperation: "link",
  })
  expect(result.activityOperation).toBe("link")
  expect(result.errorCode).toBe("SQLITE_BUSY")
  expect(JSON.stringify(result)).not.toContain("private database error")
  expect(JSON.stringify(result)).not.toContain("SELECT")
})

test("activity-operation telemetry discards unexpected runtime values and unrelated phases", () => {
  const injected = OxpDiagnostics.record({
    cause: new Error("private"),
    phase: "activity_recording",
    activityOperation: "SELECT secrets" as "begin",
  })
  const unrelated = OxpDiagnostics.record({
    cause: new Error("private"),
    phase: "tool_boundary",
    activityOperation: "begin",
  })
  expect(injected.activityOperation).toBeUndefined()
  expect(unrelated.activityOperation).toBeUndefined()
  expect(JSON.stringify([injected, unrelated])).not.toContain("SELECT secrets")
})
