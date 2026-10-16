/** Isolated, reproducible timeline aggregation benchmark (no user databases). */
import { Database } from "bun:sqlite"

const db = new Database(":memory:")
db.exec(`
 CREATE TABLE usage_record (
  message_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,completed_at INTEGER NOT NULL,
  provider_id TEXT,model_id TEXT,cost_usd REAL,mode TEXT,agent TEXT,
  created_at INTEGER,request_sent_at INTEGER,first_token_at INTEGER,streamed_at INTEGER,
  input_tokens INTEGER NOT NULL,cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,reasoning_tokens INTEGER NOT NULL
 );
 CREATE INDEX usage_record_completed_idx ON usage_record(completed_at);
`)
const count = 180_000
const insert = db.prepare(`
 INSERT INTO usage_record VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`)
db.transaction(() => {
 for (let i = 0; i < count; i++) {
  const start = 1700000000000 + i * 59000
  insert.run("m"+i,"s"+(i%3000),start+400,"provider-"+i%3,"model-"+i%5,
    i%4===0?null:0.00015,"chat","assistant",
    start,start+100,start+200,start+350,100+i%50,20,7,30+i%17,3)
 }
})()
const hour = "CAST(r.completed_at / 3600000 AS INTEGER) * 3600000"
const group = `GROUP BY ${hour},COALESCE(r.provider_id,'unknown'),COALESCE(r.model_id,'unknown') ORDER BY ${hour} ASC`
const common=`FROM usage_record r WHERE r.completed_at >= ? AND r.completed_at < ? AND COALESCE(r.mode,'') <> 'maintenance' AND COALESCE(r.mode,'') <> 'compaction' AND COALESCE(r.agent,'') <> 'compaction' AND COALESCE(r.agent,'') <> 'summary' ${group}`
const commonSelect=`
 ${hour} AS start,
 COALESCE(r.provider_id,'unknown') AS provider_id,
 COALESCE(r.model_id,'unknown') AS model_id,
 COUNT(*) AS messages,
 COALESCE(SUM(CASE WHEN r.cost_usd IS NOT NULL THEN r.cost_usd ELSE 0 END),0) AS recorded_cost,
 COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN 1 ELSE 0 END),0) AS missing_records,
 COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.input_tokens ELSE 0 END),0) AS missing_input_tokens,
 COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.cache_read_tokens ELSE 0 END),0) AS missing_cache_read_tokens,
 COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.cache_write_tokens ELSE 0 END),0) AS missing_cache_write_tokens,
 COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.output_tokens ELSE 0 END),0) AS missing_output_tokens,
 COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.reasoning_tokens ELSE 0 END),0) AS missing_reasoning_tokens`
const oldSQL=`SELECT ${commonSelect},
 COUNT(DISTINCT r.session_id) AS sessions,
 COALESCE(SUM(CASE WHEN r.cost_usd IS NOT NULL THEN 1 ELSE 0 END),0) AS recorded_records,
 COALESCE(SUM(r.input_tokens),0) AS input_tokens,
 COALESCE(SUM(r.cache_read_tokens),0) AS cache_read_tokens,
 COALESCE(SUM(r.cache_write_tokens),0) AS cache_write_tokens,
 COALESCE(SUM(r.output_tokens),0) AS output_tokens,
 COALESCE(SUM(r.reasoning_tokens),0) AS reasoning_tokens,
 COALESCE(SUM(CASE WHEN r.created_at IS NOT NULL AND r.completed_at>=r.created_at THEN r.completed_at-r.created_at ELSE 0 END),0) AS duration_ms,
 COALESCE(SUM(CASE WHEN r.created_at IS NOT NULL AND r.completed_at>=r.created_at THEN 1 ELSE 0 END),0) AS duration_records,
 COALESCE(SUM(CASE WHEN r.request_sent_at IS NOT NULL AND r.first_token_at IS NOT NULL AND r.first_token_at>=r.request_sent_at THEN r.first_token_at-r.request_sent_at ELSE 0 END),0) AS ttft_ms,
 COALESCE(SUM(CASE WHEN r.request_sent_at IS NOT NULL AND r.first_token_at IS NOT NULL AND r.first_token_at>=r.request_sent_at THEN 1 ELSE 0 END),0) AS ttft_records,
 COALESCE(SUM(CASE WHEN r.first_token_at IS NOT NULL AND r.streamed_at IS NOT NULL AND r.streamed_at>=r.first_token_at THEN r.streamed_at-r.first_token_at WHEN r.created_at IS NOT NULL AND r.completed_at>=r.created_at THEN r.completed_at-r.created_at ELSE 0 END),0) AS generation_ms
 ${common}`
const newSQL=`SELECT ${commonSelect},
 COALESCE(SUM(r.input_tokens+r.cache_read_tokens+r.cache_write_tokens+r.output_tokens+r.reasoning_tokens),0) AS tokens
 ${common}`
const oldStmt=db.prepare(oldSQL),newStmt=db.prepare(newSQL)
const unorderedSQL = newSQL.replace(` ORDER BY ${hour} ASC`, "")
const unorderedStmt = db.prepare(unorderedSQL)
const range=[1700000000000,1700000000000 + count * 59000 + 500]
const oldRows=oldStmt.all(...range) as Record<string,number|string>[]
const newRows=newStmt.all(...range) as Record<string,number|string>[]
if(oldRows.length!==newRows.length) throw Error("row count mismatch")
for(let i=0;i<oldRows.length;i++){
 const before=oldRows[i]!,after=newRows[i]!
 for(const key of Object.keys(after)){
  const prev = key==="tokens"
    ? Number(before.input_tokens)+Number(before.cache_read_tokens)+Number(before.cache_write_tokens)+Number(before.output_tokens)+Number(before.reasoning_tokens)
    : before[key]
  if(typeof prev==="number"&&typeof after[key]==="number"){
   if(Math.abs(prev-Number(after[key]))>1e-9)throw Error("numeric parity "+key+" row "+i)
  } else if(prev!==after[key])throw Error("parity "+key+" row "+i)
 }
}
function bench(fn:()=>unknown){
 for(let i=0;i<2;i++)fn()
 const times:number[]=[]
 for(let i=0;i<8;i++){const t=performance.now();fn();times.push(performance.now()-t)}
 times.sort((a,b)=>a-b)
 return Number(times[Math.floor(times.length/2)]!.toFixed(2))
}
const oldMs=bench(()=>oldStmt.all(...range))
const newMs=bench(()=>newStmt.all(...range))
const unorderedRows=unorderedStmt.all(...range) as Record<string,number|string>[]
const keys=(rows:Record<string,number|string>[]) => rows.map((r)=>JSON.stringify(r)).sort()
if(JSON.stringify(keys(newRows))!==JSON.stringify(keys(unorderedRows)))throw Error("order-free result mismatch")
const unorderedMs=bench(()=>unorderedStmt.all(...range))
console.log(JSON.stringify({messages:count,groupRows:oldRows.length,oldFields:Object.keys(oldRows[0]??{}).length,newFields:Object.keys(newRows[0]??{}).length,oldMedianMs:oldMs,newMedianMs:newMs,unorderedMedianMs:unorderedMs,speedup:Number((oldMs/newMs).toFixed(2)),unorderedSpeedup:Number((oldMs/unorderedMs).toFixed(2)),resultParity:true}))
db.close()
