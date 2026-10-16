// Diagnostic: kill the packaged ACP host 750 ms after spawn, then inspect the
// disposable database state (tables, size, journal mode, integrity) to explain
// the fresh-host refusal "Database is not empty and has no session table".

/// <reference types="bun" />
import { Database } from "bun:sqlite"
import { statSync } from "node:fs"
import { resolve } from "node:path"
import { AcpHost } from "../lib/acp-host"
import { buildCertEnv } from "../lib/env"
import { createFixture } from "../lib/fixture"

const binary = process.argv[2] ? resolve(process.argv[2]) : undefined
if (!binary) {
  console.error("usage: startup-kill-inspect <binary>")
  process.exit(64)
}

const fixture = await createFixture("startup-kill-inspect")
const cert = buildCertEnv(fixture, "default")
const host = AcpHost.spawn({
  binary,
  cwd: fixture.workspace,
  env: cert.env,
  label: "inspect",
  requestTimeoutMs: 30_000,
})

await new Promise((resolve) => setTimeout(resolve, 750))
host.kill()
let exited = false
try {
  await host.waitExit(10_000)
  exited = true
} catch {}
host.dispose()

let inspection: Record<string, unknown> = { exited }
try {
  const size = statSync(fixture.db).size
  const db = new Database(fixture.db, { readonly: true })
  try {
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name)
    const journal = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode
    const userVersion = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version
    const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all().map((row) => row.integrity_check)
    inspection = { ...inspection, size, tables, journal, userVersion, integrity }
  } finally {
    db.close()
  }
} catch (error) {
  inspection = { ...inspection, inspectError: String(error) }
}
console.log(JSON.stringify({ probe: "startup-kill-inspect", stderrTail: host.stderrTail().slice(-800), inspection }, null, 2))
await fixture.dispose().catch(() => {})
