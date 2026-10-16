/**
 * End-to-end Usage.summary cold-response benchmark with a disposable DB.
 * Runs migrations, WAL scans, the full rich accumulator, and JSON transport
 * materialization; does NOT touch a user's OpenFork profile/database.
 *
 * bun script/bench-usage-cold-summary.ts
 */
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Usage } from "../src/usage/usage"
import { usageSummaryRawRowsQuery } from "../src/usage/summary-row-query"
import { benchUsageRichPool } from "./bench-usage-rich-pool"
import { tmpdir } from "../test/fixture/fixture"
import { join } from "path"
import { Worker } from "node:worker_threads"

const base = 1_700_000_000_000
const count = 60_000
const scanReaders = Number(process.env["OPENFORK_BENCH_USAGE_READERS"] ?? 1)
const tmp = await tmpdir()
const filename = join(tmp.path, "usage-bench.db")
const catalog = {
  synthetic: {
    id: "synthetic", name: "synthetic", env: [],
    models: Object.fromEntries(Array.from({length:40}, (_, i) =>
      ["model-"+i, {
        id:"model-"+i, name:"model-"+i, family:"bench",
        cost: {input:2.5,output:10,cache_read:0.25,cache_write:2.5},
      }],
    )),
  },
}
const modelService = Layer.succeed(ModelsDev.Service,
  ModelsDev.Service.of({
    getCached: () => Effect.succeed({}),
    getForSelectedProvider: () => Effect.succeed(catalog as any),
    get: () => Effect.succeed(catalog as any),
    getDecisionModels: () => Effect.succeed({}),
    refresh: () => Effect.void,
  }),
)
const database = Database.layerFromPath(filename, { scanReaders })
const usageLayer = LayerNode.compile(Usage.node, [[Database.node,database],[ModelsDev.node,modelService]])
const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.run(sql`WITH RECURSIVE p(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM p WHERE n<24)
    INSERT INTO project(id,worktree,name,sandboxes,time_created,time_updated)
    SELECT 'p'||n,'/work/'||n,'Project '||n,'[]',${base},${base} FROM p`)
  yield* db.run(sql`WITH RECURSIVE s(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM s WHERE n<999)
    INSERT INTO session(id,project_id,directory,slug,title,version,time_created,time_updated)
    SELECT 's'||n,'p'||(n%25),'/work/'||(n%25),'s'||n,'Session '||n,'1',${base},${base} FROM s`)
  yield* db.run(sql`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${count-1})
    INSERT INTO usage_record(
      message_id,session_id,provider_id,model_id,variant,agent,mode,
      created_at,request_sent_at,first_token_at,streamed_at,completed_at,
      cost_usd,input_tokens,cache_read_tokens,cache_write_tokens,
      output_tokens,reasoning_tokens
    )
    SELECT 'm'||i, 's'||(i%1000), 'synthetic', 'model-'||(i%40),
      CASE WHEN i%11=0 THEN 'high' ELSE NULL END, 'build','primary',
      ${base}+i*60000,${base}+i*60000+100,${base}+i*60000+200,
      ${base}+i*60000+700,${base}+i*60000+1000,
      CASE WHEN i%3=0 THEN NULL ELSE 0.0004 END,
      100+i%100,20+i%5,10,30+i%12,3
    FROM n`)
})
const results: Array<Record<string,unknown>> = []
try {
  await Effect.runPromise(seed.pipe(Effect.provide(database)))
  // Paired projection-only experiment: query the same scalar rows through
  // the same persistent SQLite reader with and without message_id.
  // Alternate query order to reduce warm-cache/order bias. This measures
  // SQL hydration, not the complete rich accumulator.
  await Effect.runPromise(Effect.gen(function*() {
    const {scanDb} = yield* Database.Service
    const conn = yield* scanDb()
    const request = {since:base,until:base+count*60000+1001}
    const measurements: {full:number[];compact:number[]}={full:[],compact:[]}
    for(let iteration=0;iteration<14;iteration++){
      const order=iteration%2===0?["full","compact"] as const:["compact","full"] as const
      for(const mode of order){
        const before=performance.now()
        const rows=yield* conn.all(usageSummaryRawRowsQuery(request,undefined,mode==="full"))
        const elapsed=performance.now()-before
        if(rows.length!==count)throw Error("Projection lost rows")
        if(mode==="compact" && Object.hasOwn(rows[0]??{},"id"))throw Error("Compact scalar read leaked message IDs")
        if(iteration>=2)measurements[mode].push(elapsed)
      }
    }
    const median=(values:number[])=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)]!
    results.push({mode:"hydration-only",input:count,
      fullMedianMs:+median(measurements.full).toFixed(2),
      compactMedianMs:+median(measurements.compact).toFixed(2)})
  }).pipe(Effect.provide(database)))
  await Effect.runPromise(Effect.gen(function*() {
    const usage = yield* Usage.Service
    for (const visible of [2000,20_000,60_000]) {
      for (const projectID of [null,"p0"]) {
        const since = base + (count-visible)*60_000
        const until = base + count*60_000+1000
        const times: number[]=[]
        let payloadBytes=0,turns=0,days=0
        for(let round=0;round<5;round++){
          Usage.resetUsageSummaryCache()
          const before=performance.now()
          const answer=yield* usage.summary({since,until,resolution:"day",projectID})
          times.push(performance.now()-before)
          payloadBytes=JSON.stringify(answer).length
          turns=answer.totals.messages
          days=answer.activity.activeDays
        }
        times.sort((a,b)=>a-b)
        results.push({visible,projectID:projectID??"all",turns,days,
          coldMedianMs:+times[2]!.toFixed(2),
          coldMinMs:+times[0]!.toFixed(2),
          payloadKiB:+(payloadBytes/1024).toFixed(1)})
      }
    }
    // Same-key callers should share one server summary computation; distinct
    // uncached keys contend for the bounded read lane. Both are real service
    // requests in one shared Effect Layer, not independent mocked instances.
    for (const concurrency of [25, 50, 100]) {
      for (const mode of ["same-key", "disjoint"] as const) {
        Usage.resetUsageSummaryCache()
        const batchStart=performance.now()
        const timings=yield* Effect.forEach(
          Array.from({length:concurrency},(_,i)=>i),
          (i)=>Effect.gen(function*(){
            const rangeStart=base+(mode==="same-key" ? 0 : i*500*60000)
            const answer=yield* usage.summary({
              since:rangeStart,until:rangeStart+2000*60000+1000,
              resolution:"day",projectID:null,
            })
            if(answer.totals.messages!==2000)throw Error(`concurrency parity ${mode}: ${answer.totals.messages}`)
            // Completion latency from the common submission instant includes
            // waiting for the summary query permit. Timing only after an
            // Effect fiber starts hides queueing and understates p95 severely.
            return performance.now()-batchStart
          }),
          {concurrency:"unbounded"},
        )
        const duration=performance.now()-batchStart
        const sorted=[...timings].sort((a,b)=>a-b)
        results.push({mode,concurrency,batchMs:+duration.toFixed(2),
          p50Ms:+sorted[Math.floor(sorted.length*.5)]!.toFixed(2),
          p95Ms:+sorted[Math.floor(sorted.length*.95)]!.toFixed(2),
          perSecond:+(concurrency/duration*1000).toFixed(1)})
      }
    }
    // Regression benchmark for the former clear-all cliff at 101+ windows.
    // A recently touched entry must remain warm even when the bounded
    // server cache has to evict several genuinely cold distinct windows.
    Usage.resetUsageSummaryCache()
    const cachedWindow = (index: number) => {
      const since = base + index * 400 * 60_000
      return { since, until: since + 2_000 * 60_000, resolution: "day" as const, projectID: null }
    }
    const hot = yield* usage.summary(cachedWindow(0))
    for (let i = 1; i < 100; i++) yield* usage.summary(cachedWindow(i))
    const promoted = yield* usage.summary(cachedWindow(0))
    if (promoted !== hot) throw new Error("LRU warm promotion parity failure")
    for (let i = 100; i < 105; i++) yield* usage.summary(cachedWindow(i))
    const hotStart = performance.now()
    const warm = yield* usage.summary(cachedWindow(0))
    const hotLatencyMs = performance.now() - hotStart
    if (warm !== hot) throw new Error("LRU eviction wrongly dropped the hot summary")
    results.push({ mode: "lru-overflow", uniqueWindows: 105, preservedHot: true,
      hotLatencyMs: +hotLatencyMs.toFixed(3) })

    // Experimental worker-side FULL rich aggregation: same source-of-truth
    // collector, same SQLite projection, full response parity rather than
    // comparing only a few scalar counters. This is NOT production wiring.
    const startupBegin=performance.now()
    const workerFile=process.env["OPENFORK_BENCH_USAGE_WORKER_FILE"]
    const worker=new Worker(workerFile || new URL("./bench-usage-rich-worker.ts",import.meta.url),{
      workerData:{filename,catalog},
    })
    const ready=new Promise<void>((resolve,reject)=>{
      worker.once("message",(message)=>message?.kind==="ready"
        ? resolve() : reject(Error("Unexpected rich worker startup: "+JSON.stringify(message))))
      worker.once("error",reject)
    })
    try {
      yield* Effect.promise(()=>ready)
      results.push({mode:"rich-worker-startup",startupMs:+(performance.now()-startupBegin).toFixed(2)})
      for(const visible of [2_000,20_000,60_000]){
        for(const projectID of [null,"p0"]){
          const request={since:base+(count-visible)*60_000,until:base+count*60_000+1000,
            projectID,resolution:"day" as const}
          Usage.resetUsageSummaryCache()
          const authoritative=yield* usage.summary(request)
          for(const streamRows of [false,true]){
            const samples:number[]=[]
            let rows=0,fold=0,read=0
            for(let sample=0;sample<5;sample++){
              const begin=performance.now()
              const answer=yield* Effect.promise(()=>new Promise<any>((resolve,reject)=>{
                worker.once("message",(message)=>message.kind==="error"
                  ? reject(Error(String(message.error)+"\n"+String(message.stack??"")))
                  : resolve(message))
                worker.postMessage({kind:"summary",id:sample,request,streamRows})
              }))
              const duration=performance.now()-begin
              if(JSON.stringify(answer.summary)!==JSON.stringify(authoritative)){
                throw Error("Rich worker schema/content divergence "+JSON.stringify({visible,projectID,streamRows,
                  expected:authoritative.totals,actual:answer.summary.totals}))
              }
              samples.push(duration)
              rows=answer.rowCount
              fold=answer.foldMs
              read=answer.readMs
            }
            samples.sort((a,b)=>a-b)
            results.push({mode:"worker-rich-fold",visible,projectID:projectID??"all",
              streamRows,rows,parity:true,roundTripMedianMs:+samples[2]!.toFixed(2),
              workerReadOrCombinedMs:+read.toFixed(2),workerFoldMs:+fold.toFixed(2)})
          }
        }
      }
      // Cancel a live 60k synchronous cursor from a separate host thread.
      // A normal cancellation message would be queued behind the fold;
      // shared memory is observable without a worker message-loop tick.
      const cancelFlag=new SharedArrayBuffer(4)
      const cancelAt=performance.now()
      const cancelled=yield* Effect.promise(()=>new Promise<any>((resolve,reject)=>{
        const onMessage=(message:any)=>{
          if(message.id!==99)return
          if(message.kind==="progress"){
            // Do not cancel until the worker has demonstrably started
            // iterating 5,000 real SQL rows.
            Atomics.store(new Int32Array(cancelFlag),0,1)
            return
          }
          worker.off("message",onMessage)
          resolve(message)
        }
        worker.on("message",onMessage)
        worker.once("error",reject)
        worker.postMessage({kind:"summary",id:99,streamRows:true,cancelFlag,
          reportProgressEvery:5000,
          request:{since:base,until:base+count*60_000+1000,projectID:null,resolution:"day"}})
      }))
      if(cancelled.kind!=="error"||cancelled.cancelled!==true||cancelled.rowCount<5000||cancelled.rowCount>=count)
        throw Error("Shared cancellation failed to interrupt the rich cursor "+JSON.stringify(cancelled))
      results.push({mode:"worker-cooperative-cancel",interruptMs:+(performance.now()-cancelAt).toFixed(2),
        processedBeforeCancel:cancelled.rowCount,expectedRows:count,rollback:true})
      // Throughput alone hides the primary reason for worker offloading:
      // whether a large fold blocks the host JS event loop. This directly
      // measures timer-delivery gaps while each *complete* 60k query runs.
      const monitorLoop=async(run:()=>Promise<unknown>)=>{
        let previous=performance.now(),maxGap=0,ticks=0
        const timer=setInterval(()=>{
          const now=performance.now()
          maxGap=Math.max(maxGap,now-previous)
          previous=now
          ticks++
        },2)
        const started=performance.now()
        try{
          await run()
          // Allow a delayed tick to observe how long the host was blocked.
          await Bun.sleep(20)
        }finally{clearInterval(timer)}
        return {elapsedMs:+(performance.now()-started-20).toFixed(2),
          maxIntervalGapMs:+maxGap.toFixed(2),ticks}
      }
      const stress={since:base,until:base+count*60_000+1000,projectID:null,resolution:"day" as const}
      for(let round=0;round<3;round++){
        Usage.resetUsageSummaryCache()
        const native=yield* Effect.promise(()=>monitorLoop(()=>
          Effect.runPromise(usage.summary(stress)),
        ))
        const inWorker=yield* Effect.promise(()=>monitorLoop(()=>new Promise<void>((resolve,reject)=>{
          worker.once("message",(result)=>result.kind==="error"
            ? reject(Error(String(result.error))) : resolve())
          worker.postMessage({kind:"summary",id:100+round,request:stress,streamRows:true})
        })))
        results.push({mode:"event-loop-stall",round:round+1,native,inWorker})
      }
      // Full rich aggregation pool, with worker ownership and finalizers per
      // trial. Unlike the earlier scalar-only benchmark, every request
      // performs the actual canonical SQL+rich fold+structured response.
      for(const lanes of [1,2,4]) {
        for(const concurrency of [25,50,100]) {
          const trial=yield* Effect.promise(()=>benchUsageRichPool({
            filename,catalog:catalog as any,base,
            lanes,requests:concurrency,streamRows:false,
          }))
          results.push({mode:"worker-rich-pool",...trial})
        }
      }
    } finally {
      yield* Effect.promise(async()=>{
        try{
          const closed=new Promise<void>((resolve,reject)=>{
            worker.once("message",(message)=>message?.kind==="closed"?resolve():reject(Error("Worker close failed")))
            worker.once("error",reject)
          })
          worker.postMessage({kind:"close"})
          await closed
        }finally{await worker.terminate()}
      })
    }
  }).pipe(Effect.provide(usageLayer)))
  console.log(JSON.stringify({ scanReaders, results },null,2))
} finally {
  await tmp[Symbol.asyncDispose]()
}
