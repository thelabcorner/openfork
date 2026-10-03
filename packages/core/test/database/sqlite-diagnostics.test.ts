import { expect, test } from "bun:test"
import {
  sqliteExecutionFailureMessage,
  sqliteFailureLogFields,
  sqliteNativeCode,
  sqliteStatementClass,
} from "../../src/database/sqlite-diagnostics"

test("structured SQLite diagnostics retain native cause details without SQL text or values", () => {
  const cause = Object.assign(new Error("near 'private-token-value': syntax error"), {
    code: "SQLITE_ERROR",
    errno: 1,
  })
  const statement = "/* write path */ INSERT INTO credentials (token) VALUES ('private-token-value')"
  const serialized = JSON.stringify(sqliteFailureLogFields(cause, statement))

  expect(sqliteStatementClass(statement)).toBe("INSERT")
  expect(serialized).toContain('"operation":"execute"')
  expect(serialized).toContain('"statementClass":"INSERT"')
  expect(serialized).toContain('"code":"SQLITE_ERROR"')
  expect(serialized).toContain('"errno":1')
  expect(serialized).toContain("syntax error")
  expect(serialized).toContain("[redacted]")
  expect(serialized).not.toContain("INSERT INTO")
  expect(serialized).not.toContain("private-token-value")
  expect(sqliteExecutionFailureMessage(cause, statement)).toBe("Failed to execute statement class=INSERT sqlite=SQLITE_ERROR")
})

test("SQLite statement classes cover DDL and transaction commands", () => {
  expect(sqliteStatementClass("CREATE TABLE sessions (id text)")).toBe("DDL")
  expect(sqliteStatementClass("-- transaction\nbegin immediate")).toBe("TRANSACTION")
  expect(sqliteStatementClass("WITH pending AS (SELECT 1) SELECT * FROM pending")).toBe("WITH")
})

test("SQLite native codes are bounded and reject unstructured text", () => {
  expect(sqliteNativeCode({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe("SQLITE_CONSTRAINT_UNIQUE")
  expect(sqliteNativeCode({ cause: { code: "SQLITE_BUSY" } })).toBe("SQLITE_BUSY")
  expect(sqliteNativeCode({ code: "SQLITE_BUSY injected text" })).toBeUndefined()
  expect(sqliteNativeCode({ errno: 5 })).toBe("ERRNO_5")
})
