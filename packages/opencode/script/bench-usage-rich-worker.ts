/**
 * Experimental single-file Bun SQLite worker-side FULL rich Usage fold.
 * Bench-only: no production API route, no worker pool ownership changes.
 * Reuses the exact source-of-truth createSummaryAccumulator.
 */
import { parentPort, workerData } from "node:worker_threads"
import { Database as BunDatabase } from "bun:sqlite"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import {
  createSummaryAccumulator,
  type RawUsageRow,
  type UsageDimensionRow,
  type UsageRow,
  type MaintenanceUsageRow,
  type UsageSummaryRequest,
} from "../src/usage/usage"
import {
  usageSummaryRawRowsQuery,
  usageSummaryRowsQuery,
  usageSummaryDimensionsQuery,
  usageSummaryMaintenanceRowsQuery,
} from "../src/usage/summary-row-query"
import { buildRates } from "../src/usage/valuation"
import type { ModelsDev } from "@opencode-ai/core/models-dev"

type Task = {kind:"summary"; id:number; request: UsageSummaryRequest; streamRows?:boolean;
  cancelFlag?:SharedArrayBuffer; reportProgressEvery?:number}
type Close = {kind:"close"}
type Config = {filename:string; catalog:Record<string,ModelsDev.Provider>}
const port = parentPort
if (!port) throw new Error("rich-worker must be run inside an owned Worker")
const settings = workerData as Config
const database = new BunDatabase(settings.filename, { readonly:true, readwrite:false, create:false })
database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=20; PRAGMA cache_size=-16000")
const dialect = new SQLiteSyncDialect()
const rates = buildRates(settings.catalog)
const execute = <T>(statement: Parameters<SQLiteSyncDialect["sqlToQuery"]>[0]): T[] => {
  const compiled = dialect.sqlToQuery(statement)
  return database.prepare(compiled.sql).all(...(compiled.params as any[])) as T[]
}
const iterate = <T>(statement: Parameters<SQLiteSyncDialect["sqlToQuery"]>[0]): Iterable<T> => {
  const compiled=dialect.sqlToQuery(statement)
  return database.prepare(compiled.sql).iterate(...(compiled.params as any[])) as Iterable<T>
}
port.on("message", (input: Task | Close) => {
  if (input.kind==="close") {
    try { database.close() }
    finally { port.postMessage({kind:"closed"}); port.close() }
    return
  }
  const {id,request}=input
  const cancel= input.cancelFlag ? new Int32Array(input.cancelFlag) : undefined
  const checkCancel=()=>{
    if(cancel && Atomics.load(cancel,0)!==0) throw new Error("Usage rich aggregation cancelled")
  }
  const started=performance.now()
  let readMs=0, foldMs=0, rowCount=0
  let activeTransaction=false
  try {
    database.exec("BEGIN DEFERRED")
    activeTransaction=true
    checkCancel()
    const projectID=request.projectID??null
    const collector=createSummaryAccumulator(rates, request)
    if (projectID===null || projectID==="__historical__") {
      const dimensionRows=execute<UsageDimensionRow>(usageSummaryDimensionsQuery(request))
      const dimensions=new Map(dimensionRows.map(row=>[row.session_id,row] as const))
      const statement=usageSummaryRawRowsQuery(request,undefined,false)
      if(input.streamRows){
        // Feed native SQLite's cursor into the same pure fold. Intermediate
        // row storage drops from O(turns) to O(1).
        const cursor=function*(){
          for(const row of iterate<RawUsageRow>(statement)){
            if((rowCount & 127)===0)checkCancel()
            rowCount++
            if(input.reportProgressEvery && rowCount % input.reportProgressEvery===0)
              port.postMessage({id,kind:"progress",rowCount})
            yield row
          }
        }
        collector.addRows(cursor(),dimensions)
        readMs+=performance.now()-started // Streaming SQL and fold overlap.
      }else{
        const rawRows=execute<RawUsageRow>(statement)
        rowCount=rawRows.length
        const afterRead=performance.now()
        collector.addRows(rawRows,dimensions)
        foldMs+=performance.now()-afterRead
        readMs+=afterRead-started
      }
    } else {
      // Same attribution semantics; always use the indexed project plan.
      const statement=usageSummaryRowsQuery(request,projectID,true)
      if(input.streamRows){
        const cursor=function*(){
          for(const row of iterate<UsageRow>(statement)){
            if((rowCount & 127)===0)checkCancel()
            rowCount++
            if(input.reportProgressEvery && rowCount % input.reportProgressEvery===0)
              port.postMessage({id,kind:"progress",rowCount})
            yield row
          }
        }
        collector.addRows(cursor())
        readMs+=performance.now()-started
      }else{
        const rows=execute<UsageRow>(statement)
        rowCount=rows.length
        const afterRead=performance.now()
        collector.addRows(rows)
        foldMs+=performance.now()-afterRead
        readMs+=afterRead-started
      }
    }
    const maintenance=execute<MaintenanceUsageRow>(usageSummaryMaintenanceRowsQuery(request,projectID))
    checkCancel()
    const beforeFinish=performance.now()
    const summary=collector.finish(maintenance)
    foldMs+=performance.now()-beforeFinish
    database.exec("COMMIT")
    activeTransaction=false
    port.postMessage({id,kind:"summary",summary,rowCount,streamRows:input.streamRows===true,
      readMs,foldMs,totalMs:performance.now()-started})
  } catch(e) {
    if(activeTransaction) {
      try{database.exec("ROLLBACK")}catch{}
    }
    port.postMessage({id,kind:"error",cancelled:cancel ? Atomics.load(cancel,0)!==0 : false,
      rowCount,error:String(e),stack:e instanceof Error?e.stack:undefined})
  }
})
port.postMessage({kind:"ready"})
