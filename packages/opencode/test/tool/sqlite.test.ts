import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "bun:sqlite"
import { Cause, Effect, Exit } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import type { Tool } from "../../src/tool/tool"
import { SqliteTool, SqliteCore } from "../../src/tool/sqlite"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(LayerNode.compile(LayerNode.group([ToolRegistry.node])))

const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    ctx: {
      ...baseCtx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    } satisfies Tool.Context,
  }
}

const toolByID = (registry: ToolRegistry.Interface, id: string) =>
  registry
    .tools({
      providerID: "opencode" as any,
      modelID: "gpt-5" as any,
      agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
    })
    .pipe(Effect.map((list) => list.find((t) => t.id === id)))

// Create a real sqlite db in the test directory with the given schema + rows.
const makeDb = (dir: string, name: string) => {
  const dbPath = path.join(dir, name)
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    INSERT INTO users (name, active) VALUES ('alice', 1), ('bob', 0), ('carol', 1);
    CREATE TABLE logs (id INTEGER PRIMARY KEY, msg TEXT, data BLOB);
    INSERT INTO logs (msg, data) VALUES ('hello', x'00FF10');
  `)
  db.close()
  return dbPath
}

const readText = (p: string) => Effect.promise(() => Bun.file(p).text())

const failMsg = Effect.fn("SqliteToolTest.failMsg")(function* <A>(eff: Effect.Effect<A>) {
  const exit = yield* eff.pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err.message : String(err)
  }
  throw new Error("expected sqlite tool call to fail")
})

describe("sqlite core helpers", () => {
  it.effect("isSqliteHeader detects the magic bytes", () =>
    Effect.gen(function* () {
      const good = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00])
      expect(SqliteCore.isSqliteHeader(good)).toBe(true)
      expect(SqliteCore.isSqliteHeader(new Uint8Array(16))).toBe(false)
      expect(SqliteCore.isSqliteHeader(new Uint8Array(4))).toBe(false)
      expect(SqliteCore.isSqliteHeader(new Uint8Array([0x53, 0x51, 0x4c, 0x69]))).toBe(false)
    }),
  )

  it.effect("detectDestructive flags DROP / DELETE / UPDATE without WHERE", () =>
    Effect.gen(function* () {
      expect(SqliteCore.detectDestructive("DROP TABLE users").isDestructive).toBe(true)
      expect(SqliteCore.detectDestructive("DELETE FROM users").isDestructive).toBe(true)
      expect(SqliteCore.detectDestructive("UPDATE users SET active = 0").isDestructive).toBe(true)
      expect(SqliteCore.detectDestructive("delete from users -- comment").isDestructive).toBe(true)
      expect(SqliteCore.detectDestructive("DELETE FROM users WHERE id = 1").isDestructive).toBe(false)
      expect(SqliteCore.detectDestructive("UPDATE users SET active = 0 WHERE id = 1").isDestructive).toBe(false)
      expect(SqliteCore.detectDestructive("INSERT INTO users (name) VALUES ('drop table -- sneaky')").isDestructive).toBe(false)
      expect(SqliteCore.detectDestructive("ALTER TABLE users DROP COLUMN name").isDestructive).toBe(true)
      expect(SqliteCore.detectDestructive("SELECT * FROM users").isDestructive).toBe(false)
    }),
  )

  it.effect("classifyStatement returns kinds", () =>
    Effect.gen(function* () {
      expect(SqliteCore.classifyStatement("SELECT 1").kind).toBe("select")
      expect(SqliteCore.classifyStatement("INSERT INTO t VALUES (1)").kind).toBe("insert")
      expect(SqliteCore.classifyStatement("UPDATE t SET x=1 WHERE id=1").kind).toBe("update")
      expect(SqliteCore.classifyStatement("DELETE FROM t WHERE id=1").kind).toBe("delete")
      expect(SqliteCore.classifyStatement("CREATE TABLE t (x)").kind).toBe("create")
      expect(SqliteCore.classifyStatement("DROP TABLE t").kind).toBe("drop")
      expect(SqliteCore.classifyStatement("ALTER TABLE t ADD COLUMN y").kind).toBe("alter")
      expect(SqliteCore.classifyStatement("PRAGMA table_info(t)").kind).toBe("pragma")
      expect(SqliteCore.classifyStatement("VACUUM").kind).toBe("other")
    }),
  )

  it.effect("renderTable aligns and right-aligns numerics", () =>
    Effect.gen(function* () {
      const out = SqliteCore.renderTable(
        ["id", "name", "active"],
        ["INTEGER", "TEXT", "INTEGER"],
        [[1, "alice", 1], [2, "bob", 0]],
        { elapsedMs: 1.5, truncated: false },
      )
      expect(out).toContain("id | name")
      expect(out).toContain("----+-------+--------")
      expect(out).toContain("(2 rows, 1.5 ms)")
      // numeric columns right-aligned: "  1" vs "  2" (padded)
      expect(out).toContain(" 1 | alice")
    }),
  )

  it.effect("renderTable truncates long cells and hex-preview blobs", () =>
    Effect.gen(function* () {
      const long = "x".repeat(100)
      const out = SqliteCore.renderTable(["a", "b"], ["TEXT", "BLOB"], [[long, new Uint8Array([0x00, 0xff, 0x10])]], {
        elapsedMs: 1,
        truncated: false,
      })
      expect(out).toContain("…")
      expect(out).toContain("(truncated)")
      expect(out).toContain("0x00ff10")
    }),
  )

  it.effect("renderTable footer reflects truncation with spill hint", () =>
    Effect.gen(function* () {
      const out = SqliteCore.renderTable(["n"], ["INTEGER"], [[1], [2], [3]], { elapsedMs: 1, truncated: true })
      expect(out).toContain("Showing 3 rows")
      expect(out).toContain("action:'export'")
    }),
  )

  it.effect("toCsv escapes and handles NULL/BLOB", () =>
    Effect.gen(function* () {
      const csv = SqliteCore.toCsv(["a", "b", "c"], [["x,y", 'say "hi"', null], [1, new Uint8Array([0xde, 0xad]), "multi\nline"]])
      expect(csv).toContain('"x,y"')
      expect(csv).toContain('"say ""hi"""')
      expect(csv).toContain('""') // null -> empty field between commas
      expect(csv).toContain("0xdead")
      expect(csv).toContain('"multi\nline"')
    }),
  )

  it.effect("toJson maps NULL to null and BLOB to 0x-hex", () =>
    Effect.gen(function* () {
      const json = SqliteCore.toJson(["a", "b"], [[null, new Uint8Array([0xbe, 0xef])]])
      const parsed = JSON.parse(json)
      expect(parsed[0].a).toBeNull()
      expect(parsed[0].b).toBe("0xbeef")
    }),
  )

  it.effect("attachAlias is collision-safe", () =>
    Effect.gen(function* () {
      expect(SqliteCore.attachAlias(0)).toBe("attach0")
      expect(SqliteCore.attachAlias(3)).toBe("attach3")
      expect(SqliteCore.attachAlias(0)).not.toBe("main")
      expect(SqliteCore.attachAlias(0)).not.toBe("temp")
    }),
  )
})

describe("tool.sqlite — paths and connections", () => {
  it.instance("missing db file errors on read actions", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")
      const msg = yield* failMsg(tool.execute({ action: "tables", db: "nope.db" }, asks().ctx))
      expect(msg).toContain("Database file not found")
    }),
  )

  it.instance("non-sqlite file errors on every action including run", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "fake.db"), "this is not a sqlite database at all"))
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")
      for (const action of ["tables", "schema", "query", "explain", "export"] as const) {
        const base = action === "query" || action === "explain" || action === "export" ? { sql: "SELECT 1" } : {}
        const extra = action === "export" ? { outputPath: "out.csv" } : {}
        const msg = yield* failMsg(tool.execute({ action, db: "fake.db", ...base, ...extra }, asks().ctx))
        expect(msg).toContain("Not a SQLite database")
      }
      // run refuses to clobber a non-sqlite file
      const runMsg = yield* failMsg(
        tool.execute({ action: "run", db: "fake.db", sql: "CREATE TABLE t (x)" }, asks().ctx),
      )
      expect(runMsg).toContain("Not a SQLite database")
    }),
  )

  it.instance("rejects :memory:, NUL, and '-' leading paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")
      for (const db of [":memory:", "", "-x.db", "nul\u0000.db"]) {
        const msg = yield* failMsg(tool.execute({ action: "query", db, sql: "SELECT 1" }, asks().ctx))
        expect(msg.length).toBeGreaterThan(0)
      }
    }),
  )
})

describe("tool.sqlite — actions", () => {
  it.instance("tables lists tables and views", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      makeDb(test.directory, "app.db")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")

      const { items, ctx } = asks()
      const result = yield* tool.execute({ action: "tables", db: "app.db" }, ctx)
      expect(result.output).toContain("users")
      expect(result.output).toContain("logs")
      expect(result.metadata.tables).toBe(2)
      expect(result.metadata.views).toBe(0)
      expect(items.map((i) => i.permission)).toEqual(["read"])
    }),
  )

  it.instance("schema shows CREATE statement and columns for one table", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      makeDb(test.directory, "app.db")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")

      const result = yield* tool.execute({ action: "schema", db: "app.db", table: "users" }, asks().ctx)
      expect(result.output).toContain("CREATE TABLE users")
      expect(result.output).toContain("name")
      expect(result.output).toContain("active")

      const unknownMsg = yield* failMsg(
        tool.execute({ action: "schema", db: "app.db", table: "missing" }, asks().ctx),
      )
      expect(unknownMsg).toContain("no such table")
    }),
  )

  it.instance("schema without table lists all DDL", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      makeDb(test.directory, "app.db")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")

      const result = yield* tool.execute({ action: "schema", db: "app.db" }, asks().ctx)
      expect(result.output).toContain("CREATE TABLE users")
      expect(result.output).toContain("CREATE TABLE logs")
    }),
  )

  it.instance("query binds positional params and renders", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      makeDb(test.directory, "app.db")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")

      const { ctx } = asks()
      const result = yield* tool.execute(
        { action: "query", db: "app.db", sql: "SELECT name FROM users WHERE active = ? ORDER BY name", params: [1] },
        ctx,
      )
      expect(result.output).toContain("alice")
      expect(result.output).toContain("carol")
      expect(result.output).not.toContain("bob")
      expect(result.metadata.rows).toBe(2)
      expect(typeof result.metadata.elapsedMs).toBe("number")
    }),
  )

  it.instance("query on write SQL gives readonly guidance", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      makeDb(test.directory, "app.db")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")

      const msg = yield* failMsg(
        tool.execute({ action: "query", db: "app.db", sql: "INSERT INTO users (name) VALUES ('x')" }, asks().ctx),
      )
      expect(msg).toContain("read-only")
      expect(msg).toContain("action:'run'")
    }),
  )

  it.instance("query caps rows with limit and truncation hint", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dbPath = path.join(test.directory, "big.db")
      const db = new Database(dbPath)
      db.exec("CREATE TABLE nums (n INTEGER)")
      db.exec("BEGIN")
      for (let i = 0; i < 1000; i++) db.query("INSERT INTO nums VALUES (?)").run(i)
      db.exec("COMMIT")
      db.close()
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")

      const result = yield* tool.execute({ action: "query", db: "big.db", sql: "SELECT n FROM nums", limit: 50 }, asks().ctx)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Showing 50 rows")
      expect(result.output).toContain("export")
    }),
  )

  it.instance("run dryRun defaults true and rolls back", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      makeDb(test.directory, "app.db")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")

      const { items, ctx } = asks()
      const dry = yield* tool.execute(
        { action: "run", db: "app.db", sql: "DELETE FROM users WHERE active = 0" },
        ctx,
      )
      expect(dry.metadata.dryRun).toBe(true)
      expect(dry.metadata.rolledBack).toBe(true)
      expect(dry.metadata.changes).toBe(1)
      expect(items.map((i) => i.permission)).toContain("edit")

      // rolled back: bob still there
      const check = yield* tool.execute(
        { action: "query", db: "app.db", sql: "SELECT count(*) AS c FROM users WHERE name = 'bob'" },
        ctx,
      )
      expect(check.output).toContain("1")
    }),
  )

  it.instance("run dryRun:false commits", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      makeDb(test.directory, "app.db")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")

      const { ctx } = asks()
      const result = yield* tool.execute(
        { action: "run", db: "app.db", sql: "INSERT INTO users (name, active) VALUES ('dave', 1)", dryRun: false },
        ctx,
      )
      expect(result.metadata.rolledBack).toBe(false)
      expect(result.metadata.changes).toBe(1)
      expect(result.metadata.lastInsertRowid).toBe(4)

      const check = yield* tool.execute({ action: "query", db: "app.db", sql: "SELECT count(*) AS c FROM users" }, ctx)
      expect(check.output).toContain("4")
    }),
  )

  it.instance("run reports DDL schema change and rejects interior ';'", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      makeDb(test.directory, "app.db")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")

      const { ctx } = asks()
      const ddl = yield* tool.execute({ action: "run", db: "app.db", sql: "CREATE TABLE extra (id INTEGER)" }, ctx)
      expect(ddl.output).toContain("schema changed")

      const chainedMsg = yield* failMsg(
        tool.execute({ action: "run", db: "app.db", sql: "SELECT 1; DROP TABLE users" }, ctx),
      )
      expect(chainedMsg).toContain("Single statement")
    }),
  )

  it.instance("run DROP surfaces destructive flag in ask metadata", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      makeDb(test.directory, "app.db")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")

      const { items, ctx } = asks()
      yield* tool.execute({ action: "run", db: "app.db", sql: "DROP TABLE logs" }, ctx)
      const ask = items.find((i) => i.permission === "edit")
      expect(ask).toBeDefined()
      expect((ask!.metadata as any).destructive).toEqual({ isDestructive: true, pattern: "DROP", hasWhere: false })
      expect((ask!.metadata as any).dryRun).toBe(true)
    }),
  )

  it.instance("run on a missing file creates it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")

      const { ctx } = asks()
      const result = yield* tool.execute(
        { action: "run", db: "new.db", sql: "CREATE TABLE t (x INTEGER)", dryRun: false },
        ctx,
      )
      expect(result.output).toContain("schema changed")
      const check = yield* tool.execute({ action: "query", db: "new.db", sql: "SELECT name FROM sqlite_master WHERE name='t'" }, ctx)
      expect(check.output).toContain("t")
    }),
  )

  it.instance("explain renders the query plan", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      makeDb(test.directory, "app.db")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")

      const result = yield* tool.execute(
        { action: "explain", db: "app.db", sql: "SELECT * FROM users WHERE active = 1" },
        asks().ctx,
      )
      expect(result.output).toContain("SCAN users")
      expect(result.output).toContain("detail")
    }),
  )

  it.instance("explain renders long detail rows without 40-char truncation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      makeDb(test.directory, "app.db")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")

      // A filtered join produces a detail line well over 40 chars.
      const result = yield* tool.execute(
        { action: "explain", db: "app.db", sql: "SELECT users.name FROM users JOIN logs ON logs.id = users.id WHERE users.active = 1" },
        asks().ctx,
      )
      // the long detail line renders in full (wider cell cap for detail)
      const longDetail = "SEARCH logs USING INTEGER PRIMARY KEY (rowid=?)"
      expect(result.output).toContain(longDetail)
      expect(result.output).not.toContain("(truncated)")
    }),
  )

  it.instance("export writes csv and json, refuses existing without overwrite", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      makeDb(test.directory, "app.db")
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")

      const { ctx } = asks()
      const csv = yield* tool.execute(
        { action: "export", db: "app.db", sql: "SELECT name, active FROM users ORDER BY name", format: "csv", outputPath: "out/users.csv" },
        ctx,
      )
      expect(csv.metadata.format).toBe("csv")
      expect(csv.metadata.rows).toBe(3)
      const csvText = yield* readText(path.join(test.directory, "out", "users.csv"))
      expect(csvText).toContain("name,active")
      expect(csvText).toContain("alice,1")

      const json = yield* tool.execute(
        { action: "export", db: "app.db", sql: "SELECT name, active FROM users", format: "json", outputPath: "out/users.json" },
        ctx,
      )
      const jsonText = yield* readText(path.join(test.directory, "out", "users.json"))
      const parsed = JSON.parse(jsonText)
      expect(parsed).toHaveLength(3)
      expect(parsed[0].name).toBe("alice")

      // existing file refused
      const refusedMsg = yield* failMsg(
        tool.execute({ action: "export", db: "app.db", sql: "SELECT 1", outputPath: "out/users.csv" }, ctx),
      )
      expect(refusedMsg).toContain("already exists")

      // overwrite works
      const over = yield* tool.execute(
        { action: "export", db: "app.db", sql: "SELECT name FROM users", outputPath: "out/users.csv", overwrite: true },
        ctx,
      )
      expect(over.metadata.rows).toBe(3)
    }),
  )

  it.instance("export respects maxRows cap and reports truncated", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dbPath = path.join(test.directory, "big.db")
      const db = new Database(dbPath)
      db.exec("CREATE TABLE nums (n INTEGER)")
      db.exec("BEGIN")
      for (let i = 0; i < 100; i++) db.query("INSERT INTO nums VALUES (?)").run(i)
      db.exec("COMMIT")
      db.close()
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")

      const { ctx } = asks()
      const result = yield* tool.execute(
        { action: "export", db: "big.db", sql: "SELECT n FROM nums", format: "csv", outputPath: "out/limited.csv", maxRows: 10 },
        ctx,
      )
      expect(result.metadata.truncated).toBe(true)
      expect(result.metadata.rows).toBe(10)
      const text = yield* readText(path.join(test.directory, "out", "limited.csv"))
      expect(text.trim().split("\n")).toHaveLength(11) // header + 10
    }),
  )

  it.instance("read action with attach aliases works query_only-protected", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      makeDb(test.directory, "app.db")
      const aux = path.join(test.directory, "aux.db")
      const a = new Database(aux)
      a.exec("CREATE TABLE meta (k TEXT, v TEXT); INSERT INTO meta VALUES ('lang', 'en')")
      a.close()
      const registry = yield* ToolRegistry.Service
      const tool = yield* toolByID(registry, SqliteTool.id)
      if (!tool) throw new Error("sqlite tool not found")

      const { items, ctx } = asks()
      const result = yield* tool.execute(
        { action: "query", db: "app.db", attach: ["aux.db"], sql: "SELECT k, v FROM attach0.meta" },
        ctx,
      )
      expect(result.output).toContain("lang")
      expect(result.output).toContain("en")

      // write through attached db on a read action is blocked
      const writeMsg = yield* failMsg(
        tool.execute({ action: "query", db: "app.db", attach: ["aux.db"], sql: "INSERT INTO attach0.meta VALUES ('x','y')" }, ctx),
      )
      expect(writeMsg).toContain("read-only")
      expect(items.map((i) => i.permission)).toContain("read")
    }),
  )

  it.instance("registry resolves the sqlite tool id", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("sqlite")
    }),
  )
})
