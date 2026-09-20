import { Database } from "bun:sqlite"

const filename = process.argv[2]
const holdMs = Number(process.argv[3] ?? 250)
if (!filename) throw new Error("database path required")

const db = new Database(filename)
try {
  db.run("PRAGMA journal_mode = DELETE")
  db.run("BEGIN EXCLUSIVE")
  process.stdout.write("locked\n")
  await Bun.sleep(holdMs)
  db.run("COMMIT")
} finally {
  db.close()
}
