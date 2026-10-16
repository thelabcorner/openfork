/**
 * Standalone synthetic portfolio benchmark: no real application database,
 * no Usage service, no user data. Tests full-row hydration vs SQL group projection.
 */
import { Database } from "bun:sqlite"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import { portfolioSql, valuePortfolio, type PortfolioGroup } from "../src/usage/portfolio-query"
import { estimateCost, cacheSavings, type ModelRates } from "../src/usage/valuation"

const db = new Database(":memory:")
db.exec(`
 CREATE TABLE usage_record (
  message_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,completed_at INTEGER NOT NULL,
  provider_id TEXT,model_id TEXT,variant TEXT,mode TEXT,agent TEXT,cost_usd REAL,
  created_at INTEGER,request_sent_at INTEGER,first_token_at INTEGER,streamed_at INTEGER,
  input_tokens INTEGER NOT NULL,cache_read_tokens INTEGER NOT NULL,cache_write_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,reasoning_tokens INTEGER NOT NULL
 );
 CREATE INDEX usage_record_completed_idx ON usage_record(completed_at);
 CREATE INDEX usage_record_session_completed_idx ON usage_record(session_id,completed_at);
`)
const base = 1_700_000_000_000
const recordCount = 160_000
const insert = db.prepare("INSERT INTO usage_record VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
db.transaction(()=>{
 for(let i=0;i<recordCount;i++) {
  const stamp=base+i*1000
  const agent=i%97===0?"summary":"build"
  insert.run("m"+i,"s"+i%1200,stamp,"provider-"+i%5,"model-"+i%30,
    i%7===0?"high":null,i%113===0?"compaction":"primary",agent,
    i%3===0?null:i%100/10000,stamp-100,stamp-70,stamp-60,stamp-10,
    100+i%101,20+i%13,5+i%7,40+i%17,3+i%3)
 }
})()
const rates = new Map<string,ModelRates>()
for(let p=0;p<5;p++)for(let m=0;m<30;m++)if(m%7!==0)
 rates.set(`provider-${p}/model-${m}`,{input:2.5,output:10,cacheRead:0.25,cacheWrite:2.5})
const dialect=new SQLiteSyncDialect()
const prep=(statement:ReturnType<typeof portfolioSql>["groups"])=>{
 const compiled=dialect.sqlToQuery(statement)
  // This benchmark uses only numeric time bounds; drizzle's general
  // SQL fragment API otherwise types params as unknown[].
  return {stmt:db.prepare(compiled.sql),params:compiled.params as number[]}
}
const all=db.prepare(`
 SELECT provider_id,model_id,variant,session_id,cost_usd,input_tokens,cache_read_tokens,
 cache_write_tokens,output_tokens,reasoning_tokens,created_at,completed_at,
 first_token_at,streamed_at FROM usage_record r
 WHERE r.completed_at>=? AND r.completed_at<?
 AND COALESCE(r.mode,'')<>'maintenance' AND COALESCE(r.mode,'')<>'compaction'
 AND COALESCE(r.agent,'')<>'compaction' AND COALESCE(r.agent,'')<>'summary'
 ORDER BY r.completed_at ASC`)
function legacy(range:[number,number]){
 const rows=all.all(...range) as Array<{
  provider_id:string;model_id:string;variant:string|null;session_id:string;cost_usd:number|null;
  input_tokens:number;cache_read_tokens:number;cache_write_tokens:number;output_tokens:number;
  reasoning_tokens:number;created_at:number;completed_at:number;first_token_at:number;streamed_at:number
 }>
 let sum=0
 const m=new Map<string,{turns:number,cost:number,estimated:number,savings:number}>()
 const sessions=new Map<string,Set<string>>()
 for(const row of rows){
  const key=row.provider_id+"/"+row.model_id+(row.variant??"")
  let item=m.get(key)
  if(!item){item={turns:0,cost:0,estimated:0,savings:0};m.set(key,item)}
  item.turns++
  const rate=rates.get(row.provider_id+"/"+row.model_id)
  const tokens={input:row.input_tokens,cacheRead:row.cache_read_tokens,cacheWrite:row.cache_write_tokens,
    output:row.output_tokens,reasoning:row.reasoning_tokens}
  if(row.cost_usd!==null)item.cost+=row.cost_usd
  else if(rate)item.estimated+=estimateCost(tokens,rate)
  item.savings+=cacheSavings(tokens,rate)
  sum+=row.input_tokens+row.cache_read_tokens+row.cache_write_tokens+row.output_tokens+row.reasoning_tokens
  const seen=sessions.get(row.provider_id)??new Set<string>()
  seen.add(row.session_id)
  sessions.set(row.provider_id,seen)
 }
 return {rows:rows.length,models:m.size,providers:sessions.size,sum}
}
function sqlProjection(range:[number,number]){
 const {groups,providerSessions}=portfolioSql({since:range[0],until:range[1]},false)
 const g=prep(groups)
 const s=prep(providerSessions)
 const rows=g.stmt.all(...g.params) as PortfolioGroup[]
 const sessions=s.stmt.all(...s.params) as Array<{provider_id:string,sessions:number}>
 const valued=valuePortfolio(rows,sessions,rates)
 return {rows:rows.reduce((s,x)=>s+x.messages,0),models:valued.models.length,
  providers:valued.providers.length,groups:rows.length,
  sum:valued.models.reduce((s,x)=>s+x.tokens.input+x.tokens.cacheRead+x.tokens.cacheWrite+x.tokens.output+x.tokens.reasoning,0)}
}
const measure=(fn:()=>unknown,n=7)=>{for(let i=0;i<2;i++)fn();const t=[];for(let i=0;i<n;i++){let start=performance.now();fn();t.push(performance.now()-start)}t.sort((a,b)=>a-b);return +t[Math.floor(t.length/2)]!.toFixed(2)}
for(const visible of [2000,16000,160000]){
 const range:[number,number]=[base+1000*(recordCount-visible),base+recordCount*1000]
 const a=legacy(range),b=sqlProjection(range)
 if(a.rows!==b.rows||a.sum!==b.sum||a.models!==b.models||a.providers!==b.providers)throw Error("projection shape parity "+JSON.stringify({a,b}))
 const legacyMs=measure(()=>legacy(range))
 const sqlMs=measure(()=>sqlProjection(range))
 console.log(JSON.stringify({input:visible,valid:a.rows,groupRows:b.groups,legacyMs,sqlMs,
  ratio:+(legacyMs/sqlMs).toFixed(2),shapeParity:true}))
}
// Hypothesis from SQLite's query planner documentation: a group-order index
// may eliminate the temporary GROUP BY B-tree. Test it *in memory only* before
// ever proposing a write-amplifying production index migration.
const allRange:[number,number]=[base,base+recordCount*1000]
const before = dialect.sqlToQuery(portfolioSql({since:allRange[0],until:allRange[1]},false).groups)
const beforeParams = before.params as number[]
console.log("beforePlan",db.prepare("EXPLAIN QUERY PLAN "+before.sql).all(...beforeParams).slice(0,7))
db.exec("CREATE INDEX usage_portfolio_group_idx ON usage_record(provider_id,model_id,variant,completed_at)")
console.log("afterPlan",db.prepare("EXPLAIN QUERY PLAN "+before.sql).all(...beforeParams).slice(0,7))
const forcedSql=before.sql.replace("FROM usage_record r", "FROM usage_record r INDEXED BY usage_portfolio_group_idx")
const forced=db.prepare(forcedSql)
console.log("forcedPlan",db.prepare("EXPLAIN QUERY PLAN "+forcedSql).all(...beforeParams).slice(0,7))
console.log(JSON.stringify({forcedGroupIndexMs:measure(()=>forced.all(...beforeParams),5)}))
db.exec("CREATE INDEX usage_portfolio_expression_idx ON usage_record(COALESCE(provider_id,'unknown'),COALESCE(model_id,'unknown'),variant,completed_at)")
const expressionSql=before.sql.replace("FROM usage_record r","FROM usage_record r INDEXED BY usage_portfolio_expression_idx")
console.log("expressionPlan",db.prepare("EXPLAIN QUERY PLAN "+expressionSql).all(...beforeParams).slice(0,7))
console.log(JSON.stringify({forcedExpressionIndexMs:measure(()=>db.prepare(expressionSql).all(...beforeParams),5)}))
for (const visible of [16000,160000]) {
 const range:[number,number]=[base+(recordCount-visible)*1000,base+recordCount*1000]
 const after=sqlProjection(range)
 const sqlMs=measure(()=>sqlProjection(range))
 console.log(JSON.stringify({withGroupIndex:visible,groupRows:after.groups,sqlMs}))
}
db.close()
