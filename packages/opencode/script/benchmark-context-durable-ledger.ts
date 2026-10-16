/**
 * Reproducible, disposable proof-of-concept for a transactionally maintained
 * V1 Context ledger. NOT activated in production: the required per-event
 * projector adapter and writer fencing still need performance certification.
 *
 * bun script/benchmark-context-durable-ledger.ts
 */
import { Database as SQLite } from "bun:sqlite"
import {
  materializeContextMessage, contextMaterializedDelta,
  type ContextMaterializedTotals,
} from "@opencode-ai/core/session/context-incremental-model"

type Row = ContextMaterializedTotals
type InputPart = { id:string; version:number; kind:string; tokens:number; signed:boolean; status:string|null }
const COLUMNS = ["messageCount","excludedCount","pinnedCount","editedCount","estimatedTokens","estimatedTokensExcluded"] as const
const SESSION = "ses_incremental_lab"
const TOTAL = 3000
const EDITS = 15000
function random(seed:number) {
  let s=seed>>>0
  return ()=>((s=(Math.imul(1664525,s)+1013904223)>>>0)/0x100000000)
}
function createDatabase(materialized:boolean) {
  const db = new SQLite(":memory:")
  db.exec(`
    PRAGMA journal_mode = MEMORY;
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,opaque INTEGER NOT NULL DEFAULT 0,state_owned INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,
      kind TEXT,tokens INTEGER NOT NULL DEFAULT 0,signed INTEGER NOT NULL DEFAULT 0,status TEXT);
    CREATE INDEX part_msg_idx ON part(message_id);
    CREATE TABLE overlay(message_id TEXT PRIMARY KEY,excluded INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0,
      target TEXT,edited_text INTEGER NOT NULL DEFAULT 0,collapsed INTEGER NOT NULL DEFAULT 0);
  `)
  if (materialized) db.exec(`
    CREATE TABLE row_context(message_id TEXT PRIMARY KEY,valid INTEGER NOT NULL DEFAULT 1,
      messageCount INTEGER NOT NULL,excludedCount INTEGER NOT NULL,pinnedCount INTEGER NOT NULL,
      editedCount INTEGER NOT NULL,estimatedTokens INTEGER NOT NULL,estimatedTokensExcluded INTEGER NOT NULL);
    CREATE TABLE total_context(session_id TEXT PRIMARY KEY,invalidCount INTEGER NOT NULL DEFAULT 0,
      messageCount INTEGER NOT NULL DEFAULT 0,excludedCount INTEGER NOT NULL DEFAULT 0,
      pinnedCount INTEGER NOT NULL DEFAULT 0,editedCount INTEGER NOT NULL DEFAULT 0,
      estimatedTokens INTEGER NOT NULL DEFAULT 0,estimatedTokensExcluded INTEGER NOT NULL DEFAULT 0);
    INSERT INTO total_context(session_id) VALUES ('ses_incremental_lab');
  `)
  return db
}
function engine(db: SQLite, materialized:boolean) {
  const insertMessage = db.prepare("INSERT INTO message(id,session_id) VALUES (?,?)")
  const insertPart = db.prepare("INSERT INTO part(id,message_id,tokens,kind) VALUES (?,?,?,'text')")
  const updatePart = db.prepare("UPDATE part SET tokens = ? WHERE id = ?")
  const updateOverlay = db.prepare("INSERT INTO overlay(message_id,excluded,pinned,target,edited_text,collapsed) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET excluded=excluded.excluded,pinned=excluded.pinned,target=excluded.target,edited_text=excluded.edited_text,collapsed=excluded.collapsed")
  const deleteMessage = db.prepare("DELETE FROM message WHERE id = ?")
  const deletePart = db.prepare("DELETE FROM part WHERE message_id = ?")
  const queryMessage = db.query<{id:string,opaque:number,state_owned:number},[string]>("SELECT id,opaque,state_owned FROM message WHERE id=?")
  const queryParts = db.query<{id:string,version:number,kind:string,tokens:number,signed:number,status:string|null},[string]>("SELECT id,version,kind,tokens,signed,status FROM part WHERE message_id=?")
  const queryOverlay = db.query<{excluded:number,pinned:number,target:string|null,edited_text:number,collapsed:number},[string]>("SELECT excluded,pinned,target,edited_text,collapsed FROM overlay WHERE message_id=?")
  const queryPrevious = materialized ? db.query<(Row&{valid:number}),[string]>("SELECT * FROM row_context WHERE message_id=?") : undefined
  const upsertRow = materialized ? db.prepare(`INSERT INTO row_context(message_id,valid,${COLUMNS.join(",")})
    VALUES (?,?,${COLUMNS.map(()=>"?").join(",")})
    ON CONFLICT(message_id) DO UPDATE SET valid=excluded.valid,${COLUMNS.map(k=>`${k}=excluded.${k}`).join(",")}`) : undefined
  const delRow = materialized ? db.prepare("DELETE FROM row_context WHERE message_id=?") : undefined
  const changeTotals = materialized ? db.prepare(`UPDATE total_context SET
    invalidCount=invalidCount+?,
    ${COLUMNS.map(k=>`${k}=${k}+?`).join(",")}
    WHERE session_id=?`) : undefined
  const refresh = (id:string)=>{
    if (!materialized) return
    const old = queryPrevious!.get(id)
    const msg = queryMessage.get(id)
    const overlay = msg ? queryOverlay.get(id):null
    const parts:InputPart[] = msg ? queryParts.all(id).map(p=>({
      id:p.id,version:p.version,kind:p.kind,tokens:p.tokens,signed:!!p.signed,status:p.status,
    })) : []
    const current = msg ? materializeContextMessage({
      parts,
      overlay:overlay ? {
        excluded:!!overlay.excluded,pinned:!!overlay.pinned,
        override:overlay.collapsed?{collapsed:true,partID:overlay.target}:
          overlay.edited_text?{text:"edited",...(overlay.target?{partID:overlay.target}:{})}:undefined,
      }:undefined,
      stateOwned:!!msg.state_owned,
      messageOpaque:!!msg.opaque,
    }):undefined
    const before:Row|undefined = old&&old.valid? Object.fromEntries(COLUMNS.map(k=>[k,old[k]])) as Row:undefined
    const validAfter=!!current
    const d=contextMaterializedDelta(before,current)
    const invalidDelta=(msg&&!current?1:0)-(old&&!old.valid?1:0)
    if (msg) upsertRow!.run(id,validAfter?1:0,...COLUMNS.map(k=>current?.[k]??0))
    else delRow!.run(id)
    changeTotals!.run(invalidDelta,...COLUMNS.map(k=>d[k]),SESSION)
  }
  return {
    create:db.transaction((id:string)=>{
      insertMessage.run(id,SESSION)
      insertPart.run("p"+id,id,5)
      refresh(id)
    }),
    update:db.transaction((id:string,n:number)=>{
      updatePart.run(n,"p"+id)
      refresh(id)
    }),
    overlay:db.transaction((id:string,n:number)=>{
      updateOverlay.run(id,(n&1)?1:0,(n&2)?1:0,"p"+id,(n&4)?1:0,(n&8)?1:0)
      refresh(id)
    }),
    remove:db.transaction((id:string)=>{
      deletePart.run(id)
      deleteMessage.run(id)
      refresh(id)
    }),
  }
}
function verify(db:SQLite) {
  const row=db.query<{invalidCount:number}&Row,[]>("SELECT * FROM total_context WHERE session_id='ses_incremental_lab'").get()!
  const actual=db.query<{invalidCount:number}&Row,[]>(`SELECT
      SUM(CASE WHEN valid=0 THEN 1 ELSE 0 END) AS invalidCount,
      ${COLUMNS.map(k=>`COALESCE(SUM(${k}),0) AS ${k}`).join(",")}
    FROM row_context`).get()!
  for(const key of [...COLUMNS,"invalidCount"] as const)
    if(row[key]!==actual[key]) throw new Error(`Incremental drift on ${key}: ${row[key]} != ${actual[key]}`)
  return row
}
function bench(enabled:boolean,seed:number) {
  const db=createDatabase(enabled)
  const api=engine(db,enabled)
  const rng=random(seed)
  let start=performance.now()
  for(let i=0;i<TOTAL;i++) api.create("msg"+i)
  const insertMs=performance.now()-start
  start=performance.now()
  for(let i=0;i<EDITS;i++){
    const id="msg"+Math.floor(rng()*TOTAL)
    if(i%3===0)api.overlay(id,i)
    else api.update(id,1+Math.floor(rng()*8000))
  }
  const updateMs=performance.now()-start
  let queryMs=0
  if(enabled) {
    verify(db)
    const get=db.prepare("SELECT * FROM total_context WHERE session_id=?")
    start=performance.now()
    for(let i=0;i<10000;i++){
      const result=get.get(SESSION) as Row|undefined
      if(!result || result.messageCount!==TOTAL)throw new Error("O(1) summary corrupted")
    }
    queryMs=performance.now()-start
    for(let i=0;i<40;i++)api.remove("msg"+i)
    verify(db)
    for(let i=0;i<400;i++)api.update("msg"+(40+i),77) // duplicate replay must not drift
    verify(db)
    // Failed transactions must not expose an intermediate summary.
    const before=verify(db)
    try {
      db.transaction(()=>{
        api.update("msg100",919)
        throw new Error("simulated-crash")
      })()
    } catch {}
    const after=verify(db)
    if(COLUMNS.some(k=>before[k]!==after[k]))throw new Error("Rollback broke Context total")
  }
  db.close()
  return {insertMs,updateMs,read10000Ms:queryMs}
}
const scenarios=[]
for(let trial=0;trial<3;trial++){
  const base=bench(false,2333+trial)
  const projected=bench(true,2333+trial)
  scenarios.push({
    trial,
    originalInsertsMs:+base.insertMs.toFixed(2),
    projectedInsertsMs:+projected.insertMs.toFixed(2),
    insertCostFactor:+(projected.insertMs/base.insertMs).toFixed(3),
    originalUpdatesMs:+base.updateMs.toFixed(2),
    projectedUpdatesMs:+projected.updateMs.toFixed(2),
    updateCostFactor:+(projected.updateMs/base.updateMs).toFixed(3),
    projected10000ScalarReadsMs:+projected.read10000Ms.toFixed(2),
  })
}
console.log(JSON.stringify({rows:TOTAL,mutations:EDITS,scenario:"disposable Bun SQLite in-memory; two SQL tables + per-message aggregate recomputation",scenarios,
  note:"Proof of concept only; not production write latency / Electron / WAL contention."},null,2))
