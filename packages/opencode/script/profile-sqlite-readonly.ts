import { Database } from "bun:sqlite"
import { statSync } from "node:fs"
const filename = process.argv[2]
if (!filename) throw new Error("Usage: bun run script/profile-sqlite-readonly.ts <database-path>")
const db = new Database(filename, { readonly: true, create: false })
db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 20; PRAGMA cache_size = -8192;")
try {
  console.log(JSON.stringify({ filename, bytes: statSync(filename).size, journal: db.query("PRAGMA journal_mode").get(), pageCount: db.query("PRAGMA page_count").get(), pageSize: db.query("PRAGMA page_size").get() }))
  const existing = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('part', 'message', 'session', 'session_message', 'session_message_tool_overlay', 'usage_record', 'swarm_task_lease', 'swarm_task_run','event','session_event','runtime_owner','sqlite_stat1')").all() as { name: string }[]
  for (const {name} of existing) {
    const start=performance.now()
    try {
      if (name === "sqlite_stat1") { console.log(JSON.stringify({name, sample: db.query("SELECT tbl, idx, stat FROM sqlite_stat1 LIMIT 10").all()})); continue }
      const count=db.query(`SELECT COUNT(*) AS total FROM "${name}"`).get()
      console.log(JSON.stringify({name, count, elapsedMs: Math.round(performance.now()-start), indexes: db.query(`PRAGMA index_list("${name}")`).all().map((x:any)=>x.name)}))
    } catch(e) { console.log(JSON.stringify({name,error:String(e)})) }
  }
  const tableNames=["part","session_message","session_message_tool_overlay","usage_record","swarm_task_lease"]
  for(const name of tableNames) {
    try {
      console.log(JSON.stringify({name, schema:db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) }))
    }catch(e) { console.log(String(e)) }
  }
} finally { db.close() }
