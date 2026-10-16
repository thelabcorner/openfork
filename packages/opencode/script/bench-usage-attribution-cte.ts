/** Compare exact Usage.summary row-attribution SQL to session-deduplicated CTE.
 * Standalone read-only synthetic in-memory benchmark; no product database use.
 */
import { Database } from "bun:sqlite"
const db = new Database(":memory:")
db.exec(`
CREATE TABLE usage_record (message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, completed_at INTEGER NOT NULL, cost_usd REAL, provider_id TEXT, model_id TEXT);
CREATE INDEX usage_record_completed_idx ON usage_record(completed_at);
CREATE INDEX usage_record_session_completed_idx ON usage_record(session_id,completed_at);
CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT, title TEXT);
CREATE TABLE usage_session(session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT, title TEXT, project_name TEXT);
CREATE TABLE project(id TEXT PRIMARY KEY, name TEXT);
`)
const messages=240000, sessions=800, projects=35
const transaction = db.transaction(() => {
 const r = db.prepare("INSERT INTO usage_record (message_id,session_id,completed_at,cost_usd,provider_id,model_id) VALUES(?,?,?,?,?,?)")
 const s = db.prepare("INSERT INTO session(id,project_id,directory,title) VALUES(?,?,?,?)")
 const us = db.prepare("INSERT INTO usage_session(session_id,project_id,directory,title,project_name) VALUES(?,?,?,?,?)")
 const p = db.prepare("INSERT INTO project(id,name) VALUES(?,?)")
 for(let k=0;k<projects;k++)p.run("p"+k,"Project "+k)
 for(let i=0;i<sessions;i++){
  let project="p"+(i%projects)
  if (i%17!==0) s.run("s"+i,project,"/work/"+project,"Title "+i)
  us.run("s"+i,project,"/work/"+project,"Title "+i,"Project "+(i%projects))
 }
 for(let i=0;i<messages;i++){
  const sid = (i*347)%sessions
  r.run("r"+i,"s"+sid,1700000000000+i*1000,(i%4)*0.0001,"vendor"+(i%5),"model"+(i%7))
 }
})
transaction()
const projection=`r.message_id AS id, r.session_id, r.provider_id, r.model_id, r.cost_usd,COALESCE(s.project_id,us.project_id,'__historical__') AS project_id, COALESCE(s.directory,us.directory,'Historical usage') AS directory, COALESCE(s.title,us.title,'Deleted session') AS session_title,COALESCE(p.name,us.project_name) AS project_name`
const baseline = `SELECT ${projection} FROM usage_record r LEFT JOIN session s ON s.id=r.session_id LEFT JOIN project p ON p.id=s.project_id LEFT JOIN usage_session us ON us.session_id=r.session_id WHERE r.completed_at>=? AND r.completed_at<? ORDER BY r.completed_at ASC`
const cte = `WITH active AS MATERIALIZED (SELECT DISTINCT session_id FROM usage_record WHERE completed_at>=? AND completed_at<?),dimensions AS MATERIALIZED (SELECT a.session_id,COALESCE(s.project_id,us.project_id,'__historical__') AS project_id,COALESCE(s.directory,us.directory,'Historical usage') AS directory, COALESCE(s.title,us.title,'Deleted session') AS session_title,COALESCE(p.name,us.project_name) AS project_name FROM active a LEFT JOIN session s ON s.id=a.session_id LEFT JOIN project p ON p.id=s.project_id LEFT JOIN usage_session us ON us.session_id=a.session_id) SELECT r.message_id AS id,r.session_id,r.provider_id,r.model_id,r.cost_usd,d.project_id,d.directory,d.session_title,d.project_name FROM usage_record r LEFT JOIN dimensions d ON d.session_id=r.session_id WHERE r.completed_at>=? AND r.completed_at<? ORDER BY r.completed_at ASC`
const baseQuery=db.prepare(baseline), cteQuery=db.prepare(cte)
const pagedQuery = db.prepare(`SELECT r.rowid AS cursor_id, ${projection}
 FROM usage_record r
 LEFT JOIN session s ON s.id=r.session_id
 LEFT JOIN project p ON p.id=s.project_id
 LEFT JOIN usage_session us ON us.session_id=r.session_id
 WHERE r.completed_at>=? AND r.completed_at<? AND (r.completed_at, r.rowid) > (?,?)
 ORDER BY r.completed_at ASC,r.rowid ASC LIMIT ?`)
const bounds=[1700000000000,1700000000000+messages*1000]
const measure=(fn:()=>unknown,iterations=8)=>{
 for(let i=0;i<2;i++)fn()
 const times=[]
 for(let i=0;i<iterations;i++){const t=performance.now();fn();times.push(performance.now()-t)}
 times.sort((a,b)=>a-b)
 return {median:times[Math.floor(times.length/2)].toFixed(2),min:times[0]!.toFixed(2)}
}
for (const visible of [400,4000,24000,120000,240000]) {
 const range=[bounds[1]-visible*1000,bounds[1]]
 const a=baseQuery.all(...range)
 const b=cteQuery.all(...range,...range)
 if(JSON.stringify(a)!==JSON.stringify(b))throw Error("Parity failed at "+visible)
 const baselineTiming=measure(()=>baseQuery.all(...range),5)
 const cteTiming=measure(()=>cteQuery.all(...range,...range),5)
  console.log(JSON.stringify({rows:visible,baseline:baselineTiming,cte:cteTiming,medianSpeedup:(Number(baselineTiming.median)/Number(cteTiming.median)).toFixed(2)}))
}
const readPages = (range: number[], pageSize: number, retain = false) => {
 let afterTime = 0
 let afterID = 0
 let count = 0
 let checksum = 0
 let maxPage = 0
 const gathered: Record<string, unknown>[] = []
 for (;;) {
  const page = pagedQuery.all(...range,afterTime,afterID,pageSize) as Array<{cursor_id:number;id:string;completed_ms?:number}>
  if (!page.length) break
  count += page.length
  maxPage = Math.max(maxPage,page.length)
  for(const row of page)checksum += Number(row.id.substring(1))
  if(retain)for(const {cursor_id,...row} of page)gathered.push(row)
  const last = page.at(-1)!
  afterTime = Number(bounds[0]) + Number(last.id.substring(1))*1000
  afterID = last.cursor_id
  if(page.length < pageSize)break
 }
 return {count,checksum,maxPage,gathered}
}
for(const visible of [4000,24000,240000]){
 const range=[bounds[1]-visible*1000,bounds[1]]
 const baselineRows = baseQuery.all(...range) as Array<{id:string}>
 const pageResult=readPages(range,4096,true)
 if(JSON.stringify(baselineRows)!==JSON.stringify(pageResult.gathered))throw Error("paged parity mismatch "+visible)
 const sample=readPages(range,4096)
 const singleMs=measure(()=>baseQuery.all(...range),5)
 const pagedMs=measure(()=>readPages(range,4096),5)
 console.log(JSON.stringify({pagedRows:visible,peakRowsPerPage:sample.maxPage,fullMedianMs:singleMs.median,pagedMedianMs:pagedMs.median,ratio:(Number(singleMs.median)/Number(pagedMs.median)).toFixed(2),parity:true}))
}
const rawQuery=db.prepare(`SELECT r.message_id AS id,r.session_id,r.provider_id,r.model_id,r.cost_usd,r.completed_at
 FROM usage_record r WHERE r.completed_at>=? AND r.completed_at<? ORDER BY r.completed_at ASC`)
const dimensionQuery=db.prepare(`WITH active AS MATERIALIZED
 (SELECT DISTINCT r.session_id FROM usage_record r WHERE r.completed_at>=? AND r.completed_at<?)
 SELECT a.session_id,COALESCE(s.project_id,us.project_id,'__historical__') AS project_id,
 COALESCE(s.directory,us.directory,'Historical usage') AS directory,
 COALESCE(s.title,us.title,'Deleted session') AS session_title,
 COALESCE(p.name,us.project_name) AS project_name
 FROM active a LEFT JOIN session s ON s.id=a.session_id
 LEFT JOIN project p ON p.id=s.project_id LEFT JOIN usage_session us ON us.session_id=a.session_id`)
const projected=(range: number[])=>{
 const dims=dimensionQuery.all(...range) as Array<{session_id:string;project_id:string;directory:string;session_title:string;project_name:string|null}>
 const bySession=new Map(dims.map(d=>[d.session_id,d] as const))
 const raw=rawQuery.all(...range) as Array<{id:string;session_id:string;provider_id:string;model_id:string;cost_usd:number;completed_at:number}>
 return {dims:bySession,raw}
}
for (const visible of [4000,24000,240000]) {
 const range=[bounds[1]-visible*1000,bounds[1]]
 const expected=baseQuery.all(...range) as Array<{id:string;session_id:string;provider_id:string;model_id:string;cost_usd:number;project_id:string;directory:string;session_title:string;project_name:string|null}>
 const actual=projected(range)
 if(expected.length!==actual.raw.length)throw Error("projected count")
 for(let i=0;i<expected.length;i++){
  const old=expected[i]!,row=actual.raw[i]!,dimension=actual.dims.get(row.session_id)
  if(old.id!==row.id||old.provider_id!==row.provider_id||old.model_id!==row.model_id||
     old.cost_usd!==row.cost_usd||old.project_id!==dimension?.project_id||
     old.directory!==dimension.directory||old.session_title!==dimension.session_title||
     old.project_name!==dimension.project_name)throw Error("projected parity row "+i)
 }
 const directMs=measure(()=>baseQuery.all(...range),5)
 const projectedMs=measure(()=>projected(range),5)
 console.log(JSON.stringify({projectionRows:visible,distinctSessions:actual.dims.size,joinedMedianMs:directMs.median,dimensionThenRawMedianMs:projectedMs.median,speedup:(Number(directMs.median)/Number(projectedMs.median)).toFixed(2),parity:true}))
}
const rawPageQuery=db.prepare(`SELECT r.rowid AS cursor_id,r.message_id AS id,r.session_id,r.provider_id,r.model_id,r.cost_usd,r.completed_at
 FROM usage_record r WHERE r.completed_at>=? AND r.completed_at<?
 AND (r.completed_at,r.rowid)>(?,?) ORDER BY r.completed_at ASC,r.rowid ASC LIMIT ?`)
const rawPages=(range:number[],limit:number,collect=false)=>{
 let time=0,id=0,count=0,maxPage=0
 const seen:string[]=[]
 for(;;){
  const page=rawPageQuery.all(...range,time,id,limit) as Array<{cursor_id:number;id:string;completed_at:number}>
  if(!page.length)break
  count+=page.length
  maxPage=Math.max(maxPage,page.length)
  if(collect) for(const row of page)seen.push(row.id)
  const last=page.at(-1)!
  time=last.completed_at; id=last.cursor_id
  if(page.length<limit)break
 }
 return {count,maxPage,seen}
}
for(const visible of [24000,240000]){
 const range=[bounds[1]-visible*1000,bounds[1]]
 const before=rawQuery.all(...range) as Array<{id:string}>
 for(const batch of [8192,65536]){
  const actual=rawPages(range,batch,true)
  if(actual.count!==before.length || actual.seen.some((id,i)=>id!==before[i]!.id))throw Error("raw paged mismatch")
  const full=measure(()=>rawQuery.all(...range),5)
  const bounded=measure(()=>rawPages(range,batch),5)
  console.log(JSON.stringify({rawPaging:visible,batch,peakObjects:actual.maxPage,fullMs:full.median,pagedMs:bounded.median,relative:(Number(full.median)/Number(bounded.median)).toFixed(2),parity:true}))
 }
}
db.close()
