import { expect, test } from "bun:test"
import { Database as NativeSQLite } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("six independent Bun hosts commit distinct writes into one WAL file without deadlocking", async () => {
  const folder = await mkdtemp(join(tmpdir(), "openfork-bun-peer-writers-"))
  const filename = join(folder, "shared.db")
  const db = new NativeSQLite(filename)
  const children: Array<ReturnType<typeof Bun.spawn>> = []
  try {
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("CREATE TABLE peer_writes(id INTEGER PRIMARY KEY)")
    const script = resolve(import.meta.dir, "../fixture/sqlite-bun-peer.ts")
    const results = Array.from({ length: 6 }, (_, id) => {
      const child = Bun.spawn(["bun", script, filename, String(id)], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      })
      children.push(child)
      return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    })
    const timeout = Bun.sleep(20_000).then(() => {
      for (const child of children) child.kill()
      throw new Error("Bun peer writer stress exceeded 20 seconds")
    })
    const settled = await Promise.race([Promise.all(results), timeout])
    for (const [status, stdout, stderr] of settled) {
      expect(status, stderr.slice(0, 1000)).toBe(0)
      const stats = JSON.parse(stdout.trim()) as { clientID: number; inserted: number; attempts: number }
      expect(stats.inserted).toBe(20)
      expect(stats.attempts).toBeGreaterThanOrEqual(20)
    }
    expect(db.query("SELECT count(*) AS n FROM peer_writes").get()).toEqual({ n: 120 })
    expect(db.query("SELECT count(DISTINCT id) AS n FROM peer_writes").get()).toEqual({ n: 120 })
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill()
    db.close()
    await rm(folder, { recursive: true, force: true })
  }
}, 35_000)