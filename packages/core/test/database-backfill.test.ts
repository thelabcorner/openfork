import { Database as BunDatabase } from "bun:sqlite"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "./fixture/tmpdir"

test("withBackfillDb installs busy timeout before transitioning a DELETE-mode database to WAL", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "backfill.sqlite")

  const seed = new BunDatabase(filename)
  seed.run("PRAGMA journal_mode = DELETE")
  seed.run("CREATE TABLE probe (id integer PRIMARY KEY)")
  seed.close()

  const helper = fileURLToPath(new URL("./fixture/database-exclusive-lock.ts", import.meta.url))
  const holder = Bun.spawn(["bun", helper, filename, "250"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = holder.stdout.getReader()
  const started = await reader.read()
  expect(new TextDecoder().decode(started.value)).toContain("locked")

  const result = await Effect.runPromise(
    Effect.scoped(
      Database.withBackfillDb(
        filename,
        (db) =>
          Effect.gen(function* () {
            const journal = yield* db.get<{ journal_mode: string }>("PRAGMA journal_mode")
            const timeout = yield* db.get<{ timeout: number }>("PRAGMA busy_timeout")
            return { journal: journal?.journal_mode, timeout: timeout?.timeout }
          }),
        { busyTimeoutMs: 1_000 },
      ),
    ),
  )

  const [exitCode, stderr] = await Promise.all([holder.exited, new Response(holder.stderr).text()])
  expect(exitCode, stderr).toBe(0)
  expect(result).toEqual({ journal: "wal", timeout: 1_000 })
}, 10_000)
