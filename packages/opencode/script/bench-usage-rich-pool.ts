/**
 * Benchmark-only bounded pool running the CANONICAL full Usage accumulator
 * inside workers. Not a production request scheduler or public API.
 *
 * Every result includes the full structured summary; no scalar approximation.
 */
import { Worker } from "node:worker_threads"
import type { ModelsDev } from "@opencode-ai/core/models-dev"

type Request = {
  since: number
  until: number
  projectID: string | null
  resolution: "day" | "hour"
}
type Response = {
  kind: string
  id: number
  rowCount: number
  summary: { totals: { messages: number; tokens: { input: number } } }
  error?: string
}
const percentile = (data: number[], p: number) => {
  const sorted = [...data].sort((a,b)=>a-b)
  return +(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))] ?? 0).toFixed(2)
}

export async function benchUsageRichPool(input: {
  filename: string
  catalog: Record<string, ModelsDev.Provider>
  base: number
  lanes: number
  requests: number
  streamRows?: boolean
}) {
  const workerFile = process.env["OPENFORK_BENCH_USAGE_WORKER_FILE"]
  const workers = Array.from({length:input.lanes},() =>
    new Worker(workerFile || new URL("./bench-usage-rich-worker.ts",import.meta.url),{
      workerData:{filename:input.filename,catalog:input.catalog},
    }),
  )
  let interval: ReturnType<typeof setInterval> | undefined
  try {
    const starting=performance.now()
    await Promise.all(workers.map(worker=>new Promise<void>((resolve,reject)=>{
      const fail=(error:unknown)=>reject(error)
      worker.once("error",fail)
      worker.once("message",(message)=>message.kind==="ready"
        ?resolve():reject(Error("Worker failed to initialize: "+JSON.stringify(message))))
    })))
    const startupMs=performance.now()-starting
    const requests:Request[]=Array.from({length:input.requests},(_,i)=>{
      const since=input.base+i*500*60_000
      return {since,until:since+2000*60_000+1000,projectID:null,resolution:"day"}
    })
    let dispatched=0,done=0,totalRows=0,timerTicks=0,maxGapMs=0
    const completionTimes:number[]=[]
    const started=performance.now()
    let previous=started
    interval=setInterval(()=>{
      const now=performance.now()
      maxGapMs=Math.max(maxGapMs,now-previous)
      previous=now
      timerTicks++
    },2)
    await new Promise<void>((resolve,reject)=>{
      const send=(worker:Worker)=>{
        const id=dispatched++
        worker.postMessage({kind:"summary",id,request:requests[id],streamRows:input.streamRows??false})
      }
      for(const worker of workers) {
        const onMessage=(response:Response)=>{
          if(response.kind!=="summary"){
            reject(Error("Rich pool worker failed "+JSON.stringify(response)))
            return
          }
          if(response.summary.totals.messages!==2000||response.rowCount!==2000){
            reject(Error("Rich pool worker lost generation records "+JSON.stringify(response)))
            return
          }
          totalRows+=response.rowCount
          completionTimes.push(performance.now()-started)
          done++
          if(done===requests.length)resolve()
          else if(dispatched<requests.length)send(worker)
        }
        worker.on("message",onMessage)
        worker.once("error",reject)
      }
      for(const worker of workers) if(dispatched<requests.length)send(worker)
    })
    const batchMs=performance.now()-started
    if(interval){clearInterval(interval);interval=undefined}
    if(totalRows!==2000*requests.length)
      throw Error("Full worker pool did not conserve usage generations")
    return {
      lanes:input.lanes,streamRows:input.streamRows??false,
      requests:input.requests,totalRows,startupMs:+startupMs.toFixed(2),
      batchMs:+batchMs.toFixed(2),p50Ms:percentile(completionTimes,.5),
      p95Ms:percentile(completionTimes,.95),perSecond:+(1000*requests.length/batchMs).toFixed(1),
      mainThreadMaxTimerGapMs:+maxGapMs.toFixed(2),mainThreadTimerTicks:timerTicks,
    }
  } finally {
    if(interval)clearInterval(interval)
    // Remove pool response listeners before waiting for close ACKs.
    for(const worker of workers)worker.removeAllListeners("message")
    await Promise.all(workers.map(async worker=>{
      try{
        const closed=new Promise<void>((resolve,reject)=>{
          worker.once("message",(message)=>message.kind==="closed"
            ?resolve():reject(Error("Rich pool close failed")))
          worker.once("error",reject)
        })
        worker.postMessage({kind:"close"})
        await closed
      }finally{await worker.terminate()}
    }))
  }
}
