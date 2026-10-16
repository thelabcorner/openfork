import { expect, test } from "bun:test"
import { sqliteQueryShape } from "../../src/database/sqlite-query-shape"

test("SQLite shape diagnostics expose only whitelisted internal relations", () => {
  const query = "SELECT * FROM `session` s JOIN `part` p ON p.session_id=s.id WHERE s.id = ? ORDER BY p.id"
  expect(sqliteQueryShape(query)).toBe("tables=session,part joins=1 predicates=0 json=0 order=1 group=0")
})

test("SQLite shape diagnostics never log literal SQL values or external identifiers", () => {
  const sensitive = "SELECT 'secret_email@example.com' AS private FROM `customer_secret` WHERE token = 'private123' OR note='user123' GROUP BY private"
  const result = sqliteQueryShape(sensitive)
  expect(result).toBe("tables=other joins=0 predicates=1 json=0 order=0 group=1")
  expect(result).not.toContain("secret_email")
  expect(result).not.toContain("customer_secret")
  expect(result).not.toContain("private123")
  expect(result).not.toContain("user123")
})

test("SQLite shape diagnostics cap variable query complexity", () => {
  const query = "SELECT 1 FROM event " + "AND 1=1 ".repeat(120) + "JOIN part ON 1=1 ".repeat(120)
  const result = sqliteQueryShape(query)
  expect(result).toContain("tables=event,part")
  expect(result).toContain("predicates=99")
  expect(result).toContain("joins=99")
  expect(result.length).toBeLessThan(125)
})
