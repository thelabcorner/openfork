import { Database as SQLite } from "bun:sqlite"

const db = new SQLite(":memory:")
db.exec(`
  CREATE TABLE message(id TEXT PRIMARY KEY, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE usage_record(message_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, route_kind TEXT, completed_at INTEGER NOT NULL);
  CREATE INDEX part_message_id_id_idx ON part(message_id,id);
  CREATE INDEX idx_part_time_created ON part(time_created);
  CREATE INDEX idx_message_time_updated ON message(time_updated);
  CREATE INDEX usage_record_model_completed_idx ON usage_record(provider_id,model_id,completed_at);
`)
const N=40000, now=1_800_000_000_000, since=now-90*86400000
const putMsg=db.prepare("INSERT INTO message VALUES (?,?,?,?)")
const putPart=db.prepare("INSERT INTO part VALUES (?,?,?,?)")
const putUsage=db.prepare("INSERT INTO usage_record VALUES (?,?,?,?,?)")
db.exec("BEGIN")
for(let i=0;i<N;i++){
  const mid="msg_"+i, provider=i%10===0?"opencode":"other", route=i%12===0?"public":"account", free=i%7===0
  const model=free?"mimo-free":"paid", at=now-(i%89)*86400000-10000-i
  const error=i%997===0?{name:"APIError",data:{responseBody:"FreeUsageLimitError"}}:undefined
  putMsg.run(mid,at,at+8000,JSON.stringify({providerID:provider,role:"assistant",modelID:model,time:{completed:at+8000},error}))
  putUsage.run(mid,provider,model,route,at+8000)
  putPart.run("step_"+i,mid,at+1000,'{"type":"step-finish"}')
  putPart.run("text_"+i,mid,at+2000,'{"type":"text"}')
  putPart.run("tool_"+i,mid,at+3000,'{"type":"tool"}')
}
db.exec("COMMIT")
const oldRequests=`SELECT p.time_created AS at,json_extract(m.data,'$.modelID') AS model_id
FROM part p JOIN message m ON m.id=p.message_id JOIN usage_record u ON u.message_id=m.id
WHERE p.time_created>=? AND p.time_created<? AND json_extract(p.data,'$.type')='step-finish'
AND json_extract(m.data,'$.role')='assistant' AND json_extract(m.data,'$.providerID')='opencode'
AND u.route_kind='public' ORDER BY p.time_created ASC`
const newRequests=`SELECT p.time_created AS at,json_extract(m.data,'$.modelID') AS model_id
FROM usage_record u INDEXED BY usage_record_model_completed_idx
CROSS JOIN message m CROSS JOIN part p
WHERE u.provider_id='opencode' AND u.route_kind='public'
AND m.id=u.message_id AND p.message_id=m.id
AND p.time_created>=? AND p.time_created<?
AND json_extract(p.data,'$.type')='step-finish'
AND json_extract(m.data,'$.role')='assistant' AND json_extract(m.data,'$.providerID')='opencode'
ORDER BY p.time_created ASC`
const oldErrors=`SELECT COALESCE(json_extract(m.data,'$.time.completed'),m.time_updated,m.time_created) AS at,json_extract(m.data,'$.modelID') AS model_id
FROM message m JOIN usage_record u ON u.message_id=m.id
WHERE COALESCE(json_extract(m.data,'$.time.completed'),m.time_updated,m.time_created)>=?
AND json_extract(m.data,'$.role')='assistant' AND json_extract(m.data,'$.providerID')='opencode'
AND u.route_kind='public' AND json_extract(m.data,'$.error.name')='APIError'
AND instr(COALESCE(json_extract(m.data,'$.error.data.responseBody'),''),'FreeUsageLimitError')>0
ORDER BY at ASC`
const newErrors=`SELECT COALESCE(json_extract(m.data,'$.time.completed'),m.time_updated,m.time_created) AS at,json_extract(m.data,'$.modelID') AS model_id
FROM usage_record u INDEXED BY usage_record_model_completed_idx CROSS JOIN message m
WHERE u.provider_id='opencode' AND u.route_kind='public' AND m.id=u.message_id
AND COALESCE(json_extract(m.data,'$.time.completed'),m.time_updated,m.time_created)>=?
AND json_extract(m.data,'$.role')='assistant' AND json_extract(m.data,'$.providerID')='opencode'
AND json_extract(m.data,'$.error.name')='APIError'
AND instr(COALESCE(json_extract(m.data,'$.error.data.responseBody'),''),'FreeUsageLimitError')>0
ORDER BY at ASC`
for(const [label,a,b,params] of [["requests",oldRequests,newRequests,[since,now]],["errors",oldErrors,newErrors,[since]]] as const){
  const scan=(sql:string)=>db.prepare(sql).all(...params)
  const left=scan(a),right=scan(b)
  if(JSON.stringify(left)!==JSON.stringify(right)) throw new Error(label+" semantic divergence: "+JSON.stringify({left:left.length,right:right.length}))
  const sample=(sql:string)=>{const s=db.prepare(sql);let t=0;for(let i=0;i<5;i++){const start=performance.now();s.all(...params);t+=performance.now()-start}return +(t/5).toFixed(3)}
  console.log(JSON.stringify({label,rows:N,parts:N*3,matching:left.length,oldAvgMs:sample(a),newAvgMs:sample(b),oldPlan:db.prepare("EXPLAIN QUERY PLAN "+a).all(...params).map((x:any)=>x.detail),newPlan:db.prepare("EXPLAIN QUERY PLAN "+b).all(...params).map((x:any)=>x.detail)},null,2))
}
db.close()
