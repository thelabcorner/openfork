import { afterAll, beforeEach, describe, expect } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OxpConfig } from "@/oxp/config"
import { OxpRoot } from "@/oxp/root"
import { OxpSqlite } from "@/oxp/sqlite"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-sqlite-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const layer = AppNodeBuilder.build(
  LayerNode.group([OxpSqlite.node, OxpRoot.node, OxpConfig.node]),
  [[Global.node, Global.layerWith({ config: configDir, state: stateDir })]],
)
const it = testEffect(layer)
let caseDir = ""

function createDb(file: string, label = "main") {
  const db = new Database(file)
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)")
  db.query("INSERT INTO items (label) VALUES (?)").run(label)
  db.close()
}

function labels(file: string) {
  const db = new Database(file, { readonly: true })
  try {
    return (db.query("SELECT label FROM items ORDER BY id").all() as Array<{ label: string }>).map((row) => row.label)
  } finally {
    db.close()
  }
}

async function cleanupSuite() {
  try {
    await fs.rm(suite, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (process.platform === "win32" && (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY")) return
    throw error
  }
}

beforeEach(async () => {
  await Promise.all([
    fs.rm(configDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }),
    fs.rm(stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }),
  ])
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
  caseDir = path.join(suite, `case-${randomUUID()}`)
  await fs.mkdir(caseDir, { recursive: true })
})
afterAll(cleanupSuite)

describe("OxpSqlite", () => {
  it.live("queries only inside an approved root", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sqlite = yield* OxpSqlite.Service
    const rootDir = path.join(caseDir, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    createDb(path.join(rootDir, "app.db"), "inside")
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true })

    const result = yield* sqlite.execute({
      rootID: root.id,
      action: "query",
      db: "app.db",
      sql: "SELECT label FROM items",
    })
    expect(result.output).toContain("inside")
    expect(JSON.stringify(result)).not.toContain(rootDir)
  }))

  it.live("requires write authority and commit revalidation for run", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sqlite = yield* OxpSqlite.Service
    const rootDir = path.join(caseDir, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const dbPath = path.join(rootDir, "app.db")
    createDb(dbPath)
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true })

    const denied = yield* sqlite.execute({
      rootID: root.id,
      action: "run",
      db: "app.db",
      sql: "INSERT INTO items (label) VALUES ('committed')",
      dryRun: false,
    }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_AUTH_DENIED")
    expect(labels(dbPath)).toEqual(["main"])

    yield* config.setGrant({ write: true })
    const committed = yield* sqlite.execute({
      rootID: root.id,
      action: "run",
      db: "app.db",
      sql: "INSERT INTO items (label) VALUES ('committed')",
      dryRun: false,
    })
    expect(committed.mutation).toEqual({ attempted: true, committed: true })
    expect(labels(dbPath)).toEqual(["main", "committed"])
  }))

  it.live("rejects attached databases outside the approved root", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sqlite = yield* OxpSqlite.Service
    const rootDir = path.join(caseDir, "workspace")
    const outsideDir = path.join(caseDir, "outside")
    yield* Effect.promise(() => Promise.all([fs.mkdir(rootDir), fs.mkdir(outsideDir)]))
    createDb(path.join(rootDir, "app.db"))
    const outside = path.join(outsideDir, "other.db")
    createDb(outside, "outside")
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true, write: true })

    const escaped = yield* sqlite.execute({
      rootID: root.id,
      action: "query",
      db: "app.db",
      attach: [outside],
      sql: "SELECT label FROM attach0.items",
    }).pipe(Effect.flip)
    expect(escaped._tag).toBe("OXP_PATH_ESCAPE")
  }))

  it.live("export requires separate write authority and keeps output inside the root", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sqlite = yield* OxpSqlite.Service
    const rootDir = path.join(caseDir, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    createDb(path.join(rootDir, "app.db"), "exported")
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true })

    const denied = yield* sqlite.execute({
      rootID: root.id,
      action: "export",
      db: "app.db",
      sql: "SELECT label FROM items",
      outputPath: "out.csv",
    }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_AUTH_DENIED")

    yield* config.setGrant({ write: true })
    const exported = yield* sqlite.execute({
      rootID: root.id,
      action: "export",
      db: "app.db",
      sql: "SELECT label FROM items",
      outputPath: "out.csv",
    })
    expect(exported.mutation).toEqual({ attempted: true, committed: true })
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "out.csv"), "utf8"))).toContain("exported")

    const escaped = yield* sqlite.execute({
      rootID: root.id,
      action: "export",
      db: "app.db",
      sql: "SELECT label FROM items",
      outputPath: path.join(caseDir, "escaped.csv"),
    }).pipe(Effect.flip)
    expect(escaped._tag).toBe("OXP_PATH_ESCAPE")
  }))
})
