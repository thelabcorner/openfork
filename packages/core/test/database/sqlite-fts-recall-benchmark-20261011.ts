import { Database as NativeDb } from "bun:sqlite"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import * as Effect from "effect/Effect"
import { SessionSearch } from "../../src/session/search"

const term = Bun.argv[2] === "common" ? "common" : "sentinel"
const dialect = new SQLiteSyncDialect()
const captures: { sql: string; params: unknown[] }[] = []
const recorder = { all(q: Parameters<SQLiteSyncDialect["sqlToQuery"]>[0]) {
  captures.push(dialect.sqlToQuery(q))
  return Effect.succeed([])
} }
await Effect.runPromise(SessionSearch.search(recorder as never, {
  query: term, directoryPrefixes: ["/approved"], includeArchived: false, ranking: "relevance", limit: 20,
}))
const current = captures[2]!
const inner = /SELECT part_fts\.rowid, rank AS score\s+FROM part_fts\s+CROSS JOIN part p ON p\.rowid = part_fts\.rowid\s+JOIN session s ON s\.id = p\.session_id\s+WHERE part_fts MATCH \?\s+AND ([\s\S]*?)\s+ORDER BY rank\s+LIMIT \?/
const match = current.sql.match(inner)
if (!match) throw new Error("Production FTS-first query changed; refresh comparison")
const old = {
  sql: current.sql.replace(inner, `SELECT part_fts.rowid, rank AS score
    FROM (SELECT p.rowid FROM session s JOIN part p ON p.session_id = s.id WHERE ${match[1]}) scoped
    CROSS JOIN part_fts WHERE part_fts.rowid = scoped.rowid AND part_fts MATCH ?
    ORDER BY rank LIMIT ?`),
  params: [...current.params.slice(1, -1), current.params[0], current.params.at(-1)],
}
const db = new NativeDb(":memory:")
db.exec(`PRAGMA journal_mode=MEMORY;
CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,project_id TEXT,time_archived INTEGER);
CREATE TABLE message(id TEXT PRIMARY KEY,data TEXT,time_created INTEGER);
CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,data TEXT,search_text TEXT);
CREATE INDEX part_session_idx ON part(session_id);
CREATE INDEX session_directory_idx ON session(directory);
CREATE VIRTUAL TABLE part_fts USING fts5(search_text, content='part', content_rowid='rowid');`)
const sess = db.prepare("INSERT INTO session VALUES(?,?,?,?,?)")
const msg = db.prepare("INSERT INTO message VALUES(?,?,?)")
const part = db.prepare("INSERT INTO part VALUES(?,?,?,?,?)")
const nSessions = 2400, partsPerSession = 12
db.exec("BEGIN")
for (let s=0;s<nSessions;s++) {
  const sid="s"+s
  sess.run(sid,s%4===0 ? "/approved/work"+s : "/elsewhere/work"+s,sid,"project",s%29===0?1234:null)
  for(let j=0;j<partsPerSession;j++) {
    const n=s*partsPerSession+j
    msg.run("m"+n,'{"role":"user"}',n)
    part.run("p"+n,sid,"m"+n,'{"type":"text"}', n%197===0 ? "sentinel"+(" filler".repeat((n%199)+1)) : "common workflow status")
  }
}
db.exec("COMMIT")
db.exec("INSERT INTO part_fts(part_fts) VALUES('rebuild')")
const run=(query:typeof current)=>(db.prepare(query.sql).all(...(query.params as Array<string|number|null>)) as Array<{part_id:string}>).map(r=>r.part_id)
try {
  // The old plan can stall on high-frequency tokens; skip it for the common case.
  const a=term === "sentinel" ? run(old) : [],b=run(current)
  const identical=JSON.stringify(a)===JSON.stringify(b)
  // Scores for the broad "common" term tie, and preexisting ORDER BY rank has
  // no tie-breaker. Different tied top-N sets are permitted by SQLite.
  if(term==="sentinel"&&!identical)throw new Error("Non-tied ranked results differ: "+JSON.stringify({a,b}))
  if((term === "sentinel" && a.length!==20)||b.length!==20)throw new Error("Expected bounded top-N in executed plans")
  const time=(query:typeof current)=>{
    const times:number[]=[]
    for(let i=0;i<6;i++){const t=performance.now();run(query);times.push(performance.now()-t)}
    times.sort((a,b)=>a-b)
    return {medianMs:+((times[2]+times[3])/2).toFixed(3),minMs:+times[0]!.toFixed(3),maxMs:+times[5]!.toFixed(3)}
  }
  const before=term === "sentinel" ? time(old) : undefined,after=time(current)
  const plan=(q:typeof current)=>db.prepare("EXPLAIN QUERY PLAN "+q.sql).all(...(q.params as Array<string|number|null>)).map((r:any)=>r.detail)
  console.log(JSON.stringify({term,rows:nSessions*partsPerSession,scopeSessions:nSessions/4,matched:b.length,identical:term==="sentinel"?identical:null,old:before??"skipped",new:after,ratio:before?+(before.medianMs/after.medianMs).toFixed(2):null,oldPlan:plan(old),newPlan:plan(current)},null,2))
} finally {db.close()}
