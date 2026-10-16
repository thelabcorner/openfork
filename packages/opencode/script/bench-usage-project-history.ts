/**
 * Read-only synthetic benchmark for project-scoped Usage.summary history.
 * Compare time-first COALESCE project attribution to session-first indexed
 * scope with correct live-Session-over-tombstone precedence.
 */
import { Database } from "bun:sqlite"
const db=new Database(":memory:")
db.exec(`
 CREATE TABLE usage_record(message_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,completed_at INTEGER,cost_usd REAL);
 CREATE INDEX usage_completed ON usage_record(completed_at);
 CREATE INDEX usage_session_completed ON usage_record(session_id,completed_at);
 CREATE TABLE session(id TEXT PRIMARY KEY,project_id TEXT,directory TEXT,title TEXT);
 CREATE INDEX session_project ON session(project_id);
 CREATE TABLE usage_session(session_id TEXT PRIMARY KEY,project_id TEXT,directory TEXT,title TEXT,project_name TEXT);
 CREATE INDEX usage_session_project ON usage_session(project_id);
 CREATE TABLE project(id TEXT PRIMARY KEY,name TEXT);
`)
const rows=180000, sessions=1300, projects=Math.max(1,Number(process.argv[2] ?? 75))
db.transaction(()=>{
 const r=db.prepare("INSERT INTO usage_record VALUES (?,?,?,?)")
 const s=db.prepare("INSERT INTO session VALUES (?,?,?,?)")
 const u=db.prepare("INSERT INTO usage_session VALUES (?,?,?,?,?)")
 const p=db.prepare("INSERT INTO project VALUES (?,?)")
 for(let j=0;j<projects;j++)p.run("p"+j,"Project "+j)
 for(let j=0;j<sessions;j++){
  const id="s"+j, project="p"+(j%projects)
  // 1/11 deleted; 1/23 reassigned after tombstone snapshot.
  if(j%11!==0)s.run(id,j%23===0?"p"+((j+3)%projects):project,"/work","Session "+j)
  u.run(id,project,"/work","Session "+j,"Project "+j%projects)
 }
 for(let i=0;i<rows;i++){
  const sid=i%1231===0?"orphan-"+(i%10):"s"+(i%sessions)
  r.run("m"+i,sid,1700000000000+i*800,0.001)
 }
})()
const projection=`r.message_id AS id,r.session_id,r.completed_at,r.cost_usd,COALESCE(s.project_id,us.project_id,'__historical__') AS project_id,COALESCE(s.title,us.title,'Deleted session') AS title,COALESCE(p.name,us.project_name) AS project_name`
const baselineSQL=`SELECT ${projection} FROM usage_record r LEFT JOIN session s ON s.id=r.session_id LEFT JOIN project p ON p.id=s.project_id LEFT JOIN usage_session us ON us.session_id=r.session_id WHERE r.completed_at>=? AND r.completed_at<? AND COALESCE(s.project_id,us.project_id,'__historical__')=? ORDER BY r.completed_at ASC`
const scopedSQL=`
 WITH target_session AS MATERIALIZED (
  SELECT s.id FROM session s WHERE s.project_id=?
  UNION ALL
  SELECT us.session_id FROM usage_session us
    WHERE us.project_id=? AND NOT EXISTS(SELECT 1 FROM session live WHERE live.id=us.session_id)
 )
 SELECT ${projection}
 FROM target_session target
 JOIN usage_record r ON r.session_id=target.id
 LEFT JOIN session s ON s.id=r.session_id
 LEFT JOIN project p ON p.id=s.project_id
 LEFT JOIN usage_session us ON us.session_id=r.session_id
 WHERE r.completed_at>=? AND r.completed_at<?
 ORDER BY r.completed_at ASC`
const predicateSQL=`SELECT ${projection}
 FROM usage_record r
 LEFT JOIN session s ON s.id=r.session_id
 LEFT JOIN project p ON p.id=s.project_id
 LEFT JOIN usage_session us ON us.session_id=r.session_id
 WHERE r.completed_at>=? AND r.completed_at<?
 AND r.session_id IN (
   SELECT live.id FROM session live WHERE live.project_id=?
   UNION ALL
   SELECT snap.session_id FROM usage_session snap
     WHERE snap.project_id=? AND NOT EXISTS (SELECT 1 FROM session live WHERE live.id=snap.session_id)
 )
 ORDER BY r.completed_at ASC`
const base=db.prepare(baselineSQL),scoped=db.prepare(scopedSQL),predicate=db.prepare(predicateSQL)
const until=1700000000000+rows*800
const measure=(fn:()=>unknown)=>{
 for(let j=0;j<2;j++)fn()
 const times=[]
 for(let j=0;j<7;j++){const t=performance.now();fn();times.push(performance.now()-t)}
 times.sort((a,b)=>a-b)
 return Number(times[3]!.toFixed(3))
}
for(const projectID of new Set([0,Math.min(1,projects-1),Math.floor(projects/2),projects-1].map(i=>"p"+i)).values()){
 for(const visible of [3000,rows]){
  const bounds=[until-visible*800,until]
  const previous=base.all(...bounds,projectID)
  const indexed=scoped.all(projectID,projectID,...bounds)
  if(JSON.stringify(previous)!==JSON.stringify(indexed))throw Error(`parity ${projectID} ${visible}: ${previous.length}/${indexed.length}`)
  const filtered=predicate.all(...bounds,projectID,projectID)
  if(JSON.stringify(previous)!==JSON.stringify(filtered))throw Error(`predicate parity ${projectID} ${visible}`)
  const prev=measure(()=>base.all(...bounds,projectID))
  const next=measure(()=>scoped.all(projectID,projectID,...bounds))
  const where=measure(()=>predicate.all(...bounds,projectID,projectID))
  console.log(JSON.stringify({projectID,rangeRows:visible,matches:previous.length,timeFirstMs:prev,sessionFirstMs:next,inPredicateMs:where,speedup:Number((prev/next).toFixed(2)),predicateSpeedup:Number((prev/where).toFixed(2))}))
 }
}
console.log("index-plan",db.prepare("EXPLAIN QUERY PLAN "+scopedSQL).all("p0","p0",1700000000000,until))
db.close()
