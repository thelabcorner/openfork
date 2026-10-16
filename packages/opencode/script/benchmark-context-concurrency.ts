/**
 * Disposable SQLite Context read-contention probe (not actual agent/session
 * generation, Electron renderer, or first-token latency certification).
 *
 * bun script/benchmark-context-concurrency.ts
 *
 * 100 distinct synthetic sessions, 20 durable V1 text messages each.
 * Simultaneous first-page reads + all-history scalar aggregates at fan-outs of
 * 25, 50, and 100; verify every response and report p50/p95 and throughput.
 * No live OpenFork daemon or user database is opened.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { readPage } from "../src/session/context/page"
import { readTotals } from "../src/session/context/totals"

const folder = mkdtempSync(join(tmpdir(), "openfork-context-fanout-"))
const file = join(folder, "fanout.db")
const SESSION_COUNT = 100
const MESSAGES_PER_SESSION = 20
const percentile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(fraction * values.length) - 1)]!
try {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`
      INSERT INTO project (id, worktree, name, sandboxes, time_created, time_updated)
      VALUES ('p_context_fanout', '/context-fanout', 'context-fanout', '[]', 1000, 1000)
    `)
    const sessions = Array.from({ length: SESSION_COUNT }, (_, i) => `ses_context_fanout_${i}`)
    for (let i = 0; i < SESSION_COUNT; i++) {
      const sessionID = sessions[i]!
      yield* db.run(sql`
        INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated)
        VALUES (${sessionID}, 'p_context_fanout', '/context-fanout', ${sessionID}, 'Fanout benchmark', '1', 1000, 1000)
      `)
      const rows = Array.from({ length: MESSAGES_PER_SESSION }, (_, j) => {
        const id = `msg_context_fanout_${i}_${j}`
        return sql`(${id}, ${sessionID}, ${1000+j}, ${1000+j},
          ${JSON.stringify({role:"user",time:{created:1000+j}})})`
      })
      yield* db.run(sql`
        INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ${sql.join(rows,sql`,`)}
      `)
      const parts = Array.from({ length: MESSAGES_PER_SESSION }, (_, j) => {
        const id = `msg_context_fanout_${i}_${j}`
        return sql`(${"prt_"+id}, ${id}, ${sessionID}, ${1000+j}, ${1000+j},
          ${JSON.stringify({type:"text",text:"Synthetic V1 read workload"})},1,'text',7,'Synthetic V1 read workload')`
      })
      yield* db.run(sql`
        INSERT INTO part
          (id,message_id,session_id,time_created,time_updated,data,
            context_projection_version,context_kind,context_tokens,context_preview)
        VALUES ${sql.join(parts,sql`,`)}
      `)
    }
    // Warm each exact session once before measuring concurrent reads. Repeating
    // fanouts in ascending then descending order reduces the systematic bias
    // that otherwise makes later, larger fanouts appear unrealistically faster.
    for (const sessionID of sessions) {
      yield* readPage({ sessionID, limit: 20 })
      yield* readTotals(sessionID)
    }
    const trials: Array<{
      simulatedConcurrentClients:number; elapsedMs:number; throughputRequestsPerSec:number;
      p50Ms:number; p95Ms:number; maxMs:number
    }> = []
    for (const n of [25,50,100,100,50,25]) {
      const latencies: number[] = []
      const started = performance.now()
      const jobs = sessions.slice(0,n).map((sessionID) =>
        Effect.gen(function* () {
          const requestStart = performance.now()
          const page = yield* readPage({sessionID,limit:20})
          const totals = yield* readTotals(sessionID)
          if (page.entries.length !== MESSAGES_PER_SESSION ||
              totals.totals?.messageCount !== MESSAGES_PER_SESSION)
            throw new Error(`Context fanout read mismatch for ${sessionID}`)
          latencies.push(performance.now() - requestStart)
        }),
      )
      yield* Effect.all(jobs, { concurrency: "unbounded" })
      const elapsed = performance.now() - started
      trials.push({
        simulatedConcurrentClients:n,
        elapsedMs:Number(elapsed.toFixed(2)),
        throughputRequestsPerSec:Number((n/elapsed*1000).toFixed(1)),
        p50Ms:Number(percentile(latencies,.5).toFixed(2)),
        p95Ms:Number(percentile(latencies,.95).toFixed(2)),
        maxMs:Number(Math.max(...latencies).toFixed(2)),
      })
    }
    const scenarios = [25,50,100].map((n) => {
      const measurements = trials.filter((trial) => trial.simulatedConcurrentClients === n)
      return {
        simulatedConcurrentClients:n,
        repeats:measurements.length,
        elapsedMedianMs:Number(percentile(measurements.map((x)=>x.elapsedMs),.5).toFixed(2)),
        throughputMedianRequestsPerSec:Number(percentile(measurements.map((x)=>x.throughputRequestsPerSec),.5).toFixed(1)),
        p50MedianMs:Number(percentile(measurements.map((x)=>x.p50Ms),.5).toFixed(2)),
        p95MedianMs:Number(percentile(measurements.map((x)=>x.p95Ms),.5).toFixed(2)),
        maxObservedMs:Number(Math.max(...measurements.map((x)=>x.maxMs)).toFixed(2)),
      }
    })
    return { sessions:SESSION_COUNT, messagesPerSession:MESSAGES_PER_SESSION, scenarios, trials,
      limitation:"Synthetic read fanout; NOT active model generation or Electron end-to-end certification." }
  }).pipe(Effect.provide(Database.layerFromPath(file))))
  console.log(JSON.stringify(result,null,2))
} finally {
  rmSync(folder,{recursive:true,force:true})
}
