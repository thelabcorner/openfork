/**
 * Disposable WAL multi-reader prototype for Usage query scheduling.
 *
 * Deliberately independent of production Database ownership. Demonstrates
 * whether actual OS worker threads / separate read-only SQLite connections can
 * improve disjoint scan tail latency, and checks concurrent foreground writes.
 *
 * bun script/bench-usage-read-lanes.ts
 */
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const temp = await mkdtemp(join(tmpdir(), "openfork-usage-read-lanes-"))
const filename = join(temp,"bench.db")
const db = new Database(filename)
const count = 60_000
const base = 1_700_000_000_000
const results: object[] = []
const canonical = new Map<number, string>()
const workerURL = new URL("./bench-usage-read-worker.ts", import.meta.url)
const percentile = (values: readonly number[],fraction: number) => {
  if(!values.length)return 0
  const sorted=[...values].sort((a,b)=>a-b)
  return +(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*fraction))]??0).toFixed(2)
}
try {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE usage_record(
      message_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,
      provider_id TEXT,model_id TEXT,variant TEXT,cost_usd REAL,
      input_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,
      output_tokens INTEGER,reasoning_tokens INTEGER,completed_at INTEGER NOT NULL
    );
    CREATE INDEX idx_completed ON usage_record(completed_at);
    CREATE TABLE writer_probe(id INTEGER PRIMARY KEY, written_ms INTEGER NOT NULL);
  `)
  const seed=db.prepare("INSERT INTO usage_record VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
  db.transaction(()=>{
    for(let i=0;i<count;i++)seed.run(
      "m"+i,"s"+i%1200,"provider"+i%5,"model"+i%40,i%7===0?"high":null,
      i%3===0?null:i/100000,100+i%97,20+i%13,2,40+i%15,3,base+i*60_000,
    )
  })()
  const writer=db.prepare("INSERT INTO writer_probe(written_ms) VALUES(?)")
  const jobs=Array.from({length:1000},(_,i)=>({
    kind:"task" as const,id:i,since:base+(i%100)*500*60_000,
    until:base+((i%100)*500+2000)*60_000,
  }))
  for(const lanes of [1,2,4,8]){
    const threads=Array.from({length:lanes},()=>new Worker(workerURL))
    const writeMs:number[]=[]
    const completions:number[]=[]
    let writeError:string|undefined
    let timer:ReturnType<typeof setInterval>|undefined
    try {
      await Promise.all(threads.map(thread=>new Promise<void>((resolve,reject)=>{
        thread.onerror=e=>reject(new Error(String(e)))
        thread.onmessage=(e:MessageEvent<{kind:string}>)=>{
          if(e.data.kind==="ready")resolve()
        }
        thread.postMessage({kind:"init",file:filename})
      })))
      const started=performance.now()
      let next=0,done=0,totalRows=0
      const batch = new Promise<void>((resolve,reject)=>{
        for(const thread of threads){
          thread.onmessage=(event:MessageEvent<{
            kind:string,id:number,count:number,cost:number,tokens:number,
            providers:number,sessions:number,error?:string
          }>)=>{
            const payload=event.data
            if(payload.kind==="error")return reject(new Error(payload.error))
            if(payload.kind!=="done")return
            if(payload.count!==2000||payload.providers!==5||payload.sessions<=0)
              return reject(new Error("Result conservation mismatch "+JSON.stringify(payload)))
            const checksum = JSON.stringify([payload.count,payload.cost,payload.tokens,payload.providers,payload.sessions])
            if(canonical.has(payload.id) && canonical.get(payload.id)!==checksum)
              return reject(new Error("Cross-lane accounting mismatch for query "+payload.id))
            canonical.set(payload.id,checksum)
            totalRows+=payload.count
            completions.push(performance.now()-started)
            done++
            if(done===jobs.length)resolve()
            else if(next<jobs.length)thread.postMessage(jobs[next++]!)
          }
        }
        for(const thread of threads){
          if(next<jobs.length)thread.postMessage(jobs[next++]!)
        }
      })
      timer=setInterval(()=>{
        const t=performance.now()
        try{writer.run(Date.now());writeMs.push(performance.now()-t)}
        catch(e){writeError=String(e)}
      },10)
      await batch
      const duration=performance.now()-started
      if(timer)clearInterval(timer)
      timer=undefined
      if(writeError)throw new Error(writeError)
      if(totalRows!==2_000_000)throw new Error("Missing/extra historical rows")
      results.push({
        lanes,requests:jobs.length,rows:totalRows,
        batchMs:+duration.toFixed(2),completionP50:percentile(completions,.5),
        completionP95:percentile(completions,.95),
        throughput:+(jobs.length*1000/duration).toFixed(2),
        writerSamples:writeMs.length,writerP95Ms:percentile(writeMs,.95),
      })
    } finally {
      if(timer)clearInterval(timer)
      await Promise.all(threads.map(thread=>new Promise<void>((resolve,reject)=>{
        thread.onerror=e=>reject(new Error(String(e)))
        thread.onmessage=e=>{ if(e.data.kind==="closed")resolve() }
        thread.postMessage({kind:"close"})
      })))
      await Promise.all(threads.map(t=>t.terminate()))
    }
  }
  console.log(JSON.stringify(results,null,2))
} finally {
  db.close()
  // Windows may still be releasing an async worker's SQLite file handles.
  // Closing each worker's native connection before terminate is mandatory.
  for(let attempt=0;attempt<8;attempt++){
    try{await rm(temp,{recursive:true,force:true});break}
    catch(e){
      if(attempt===7)throw e
      await Bun.sleep(80)
    }
  }
}
