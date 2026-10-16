/**
 * Reproducible synthetic IPC overhead comparison. NOT a production database
 * benchmark: includes warm per-statement IPC, excludes SQL query planning on
 * real Session tables, caching, network, UI, and WAL writer contention.
 * bun test/database/bench-sqlite-reader-ipc-20261011.ts
 */
import { Database as Native } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteScanProcessClient } from "../../src/database/sqlite-scan-process"
import { SqliteBunWorkerClient } from "../../src/database/sqlite-bun-worker-client"

const dir=await mkdtemp(join(tmpdir(),"openfork-sqlite-ipc-bench-"))
const filename=join(dir,"latency.db")
const owner=new Native(filename)
owner.exec("PRAGMA journal_mode=WAL; CREATE TABLE baseline(id INTEGER PRIMARY KEY, payload TEXT); INSERT INTO baseline VALUES(1,'ok')")
owner.close()
const variants=[
  ["readOnly Bun worker",new SqliteBunWorkerClient({filename,readonly:true,disableWAL:true,checkpointOnClose:false})],
  ["killable isolated Bun subprocess",new SqliteScanProcessClient({filename,readonly:true,permitLane:"scan",queryTimeoutMs:3000})],
] as const
try {
  for (const [name,client] of variants) {
    await client.ready
    const ms:number[]=[]
    for(let i=0;i<240;i++){
      const started=performance.now()
      const rows=await client.request<Array<{payload:string}>>({kind:"query",query:"SELECT payload FROM baseline WHERE id=?",params:[1],arrays:false,safeIntegers:false})
      if(rows[0]?.payload!=="ok")throw Error("row fidelity changed")
      if(i>=40)ms.push(performance.now()-started)
    }
    ms.sort((a,b)=>a-b)
    const p=(q:number)=>ms[Math.floor((ms.length-1)*q)]!.toFixed(3)
    console.log(JSON.stringify({name,n:ms.length,p50Ms:p(.5),p95Ms:p(.95),p99Ms:p(.99),meanMs:(ms.reduce((a,b)=>a+b,0)/ms.length).toFixed(3)}))
  }
} finally {
  await Promise.all(variants.map(([,client])=>client.close()))
  await rm(dir,{recursive:true,force:true,maxRetries:6,retryDelay:75})
}
