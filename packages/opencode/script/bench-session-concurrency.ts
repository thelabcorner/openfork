/**
 * Explicit opt-in, isolated end-to-end delegated Session concurrency harness.
 * No model credentials, production DB, desktop host, or live runtime reload.
 *
 * Run from packages/opencode:
 *   bun script/bench-session-concurrency.ts 25 50 100
 *
 * This process creates its own unique disposable DB and overrides
 * OPENCODE_DB before dynamically importing any OpenFork modules.
 *
 * A real local HTTP fake-provider holds response tails while N independent
 * durable Sessions are admitted concurrently. Only this CLI command runs it.
 * Do not confuse these measurements with remote-provider/account quotas,
 * cross-process SQLite contention, or Electron renderer responsiveness.
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { tmpdir as systemTmpdir } from "node:os"
import type * as EffectType from "effect/Effect"

// SECURITY: initialize isolation BEFORE importing any OpenFork module.
// Flag.OPENCODE_DB is captured at module evaluation; a scoped test directory
// alone does NOT isolate the global AppRuntime database connection.
const benchDirectory = mkdtempSync(join(systemTmpdir(), "openfork-concurrency-bench-"))
const benchDB = join(benchDirectory, "openfork-concurrency-bench-fixture.db")
const localTmp = join(benchDirectory, "tmp")
mkdirSync(localTmp, { recursive: true })
for (const [key, value] of Object.entries({
  XDG_DATA_HOME: join(benchDirectory, "data"),
  XDG_CACHE_HOME: join(benchDirectory, "cache"),
  XDG_CONFIG_HOME: join(benchDirectory, "config"),
  XDG_STATE_HOME: join(benchDirectory, "state"),
  OPENCODE_CONFIG_DIR: join(benchDirectory, "config", "openfork"),
  OPENCODE_TEST_HOME: join(benchDirectory, "home"),
  TMP: localTmp,
  TEMP: localTmp,
})) process.env[key] = value
process.env.OPENCODE_DB = benchDB
process.env.OPENCODE_SEAL_ENABLED = "0"
process.env.OPENCODE_SEAL_DEDUP = "0"
// Explicit controlled logging A/B; baseline stays at the runtime's INFO default.
if (process.env.OPENFORK_BENCH_LOG_LEVEL) process.env.OPENCODE_LOG_LEVEL = process.env.OPENFORK_BENCH_LOG_LEVEL
// Controlled A/B of the experimental SQLite execution lane. Never enable
// this driver outside the generated isolated benchmark runtime.
if (process.env.OPENFORK_BENCH_SQLITE_WORKER === "1") {
  process.env.OPENFORK_SQLITE_ASYNC_WORKER = "1"
}
if (process.env.OPENFORK_BENCH_SQLITE_READ_WORKER === "1") {
  process.env.OPENFORK_SQLITE_ASYNC_READ_WORKER = "1"
}
const { Flag } = await import("@opencode-ai/core/flag/flag")
const { Global } = await import("@opencode-ai/core/global")
const base = (resolve(benchDirectory) + sep).toLowerCase()
if (
  Flag.OPENCODE_DB !== benchDB ||
  Flag.OPENCODE_SEAL_ENABLED ||
  ![Global.Path.data, Global.Path.cache, Global.Path.config, Global.Path.state, Global.Path.tmp]
    .every((path) => resolve(path).toLowerCase().startsWith(base))
) {
  throw new Error("Refusing unisolated runtime: database and every global storage root must live in temporary bench directory")
}
const { Effect, ManagedRuntime } = await import("effect")
const Scheduler = await import("effect/Scheduler")
// Benchmark-only fairness experiment; no global production scheduler changes.
const requestedYieldOps = Number(process.env.OPENFORK_BENCH_EFFECT_YIELD_OPS)
const yieldOps = Number.isSafeInteger(requestedYieldOps) &&
  requestedYieldOps >= 16 && requestedYieldOps <= 16_384
  ? requestedYieldOps
  : undefined
const withYieldBudget = <A, E, R>(effect: EffectType.Effect<A, E, R>) =>
  yieldOps === undefined ? effect : Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, yieldOps)
const { AppRuntime } = await import("../src/effect/app-runtime")
const { InstanceStore } = await import("../src/project/instance-store")
const { DelegatedWorker } = await import("../src/session/delegated-worker")
const { TestLLMServer, reply } = await import("../test/lib/llm-server")
const { testProviderConfig } = await import("../test/lib/test-provider")
const { tmpdir } = await import("../test/fixture/fixture")

const sizes = process.argv.slice(2).map(Number)
const requested = sizes.length > 0 ? sizes : [25, 50, 100]
if (requested.some((size) => !Number.isSafeInteger(size) || size < 1 || size > 100)) {
  throw new Error("Only explicit sizes 1..100 are allowed")
}

const cancelMode = process.env.OPENFORK_BENCH_CANCEL === "1"
const providerAdmissionMs = Math.max(1000, Math.min(120000, Number(process.env.OPENFORK_BENCH_PROVIDER_ADMISSION_MS) || 30000))
const principalRef = "oxp:isolated-concurrency-benchmark"
const model = { providerID: "test", modelID: "test-model" } as const
const identity = { producer: "oxp", principalRef } as const
const testRuntime = ManagedRuntime.make(TestLLMServer.layer)
const median = (values: number[]) => {
  if (values.length === 0) return 0
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}
const isTitleRequest = (body: Record<string, unknown>) =>
  Array.isArray(body.tools) && JSON.stringify(body.tools).includes("generated_title")

const quantile = (values: readonly number[], fraction: number) => {
  if (values.length === 0) return 0
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!
}

async function scenario(count: number) {
  const llm = await testRuntime.runPromise(TestLLMServer)
  const tmp = await tmpdir({ config: testProviderConfig(llm.url) })
  const gate = Promise.withResolvers<void>()
  const delays: number[] = []
  let lastTick = 0
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    await testRuntime.runPromise(llm.reset)
    await testRuntime.runPromise(llm.pushMatch(
      (hit) => !isTitleRequest(hit.body),
      ...Array.from({ length: count }, () => reply().wait(gate.promise).text("bench done").stop().item()),
    ))
    const result = await AppRuntime.runPromise(
      withYieldBudget(InstanceStore.Service.use((instances) =>
        instances.provide({ directory: tmp.path },
          Effect.gen(function* () {
            const worker = yield* DelegatedWorker.make
            lastTick = performance.now()
            timer = setInterval(() => {
              const now = performance.now()
              delays.push(Math.max(0, now - lastTick - 25))
              lastTick = now
            }, 25)
            const startAt = performance.now()
            const sessions = yield* Effect.forEach(
              Array.from({ length: count }, (_, i) => i),
              (i) => worker.start({
                title: `Benchmark worker ${i}`,
                // A unique marker in the first provider-visible user turn
                // proves all N *distinct Sessions* reached the fake HTTP server,
                // rather than counting N requests from fewer retrying Sessions.
                prompt: `Reply to this isolated local test with a short answer. OPENFORK_CONCURRENCY_${count}_${i}`,
                agent: "build",
                model,
                origin: {
                  producer: "oxp",
                  principalRef,
                  invocationRef: `oxp-inv:isolated-concurrency-${count}-${i}`,
                  rootRef: `root-isolated-concurrency-${count}`,
                  agent: "build",
                  model,
                  nestedDelegation: false,
                },
              }),
              { concurrency: count },
            )
            const admittedAt = performance.now()
            // Do not mistake concurrently admitted Sessions for concurrent
            // provider requests. Every fake transport must actually reach the
            // HTTP server while ALL of their SSE tails remain held by the gate.
            // Bound the wait; a serializing/deadlocked path is a failed gate.
            const providerWaitStart = performance.now()
            let hitList = yield* llm.hits
            const arrivals = new Map<number, (typeof hitList)[number]>()
            const checkHits = () => {
              for (const hit of hitList) {
                if (isTitleRequest(hit.body)) continue
                const marker = JSON.stringify(hit.body).match(/OPENFORK_CONCURRENCY_(\d+)_(\d+)/)
                const size = marker ? Number(marker[1]) : NaN
                const index = marker ? Number(marker[2]) : NaN
                if (size !== count || !Number.isSafeInteger(index) || index < 0 || index >= count) {
                  throw new Error("Fake provider received an unidentifiable or foreign Session request")
                }
                const prior = arrivals.get(index)
                if (prior !== undefined && prior !== hit) {
                  throw new Error(`Worker ${index} made multiple provider requests before overlap admission`)
                }
                arrivals.set(index, hit)
              }
              return arrivals.size
            }
            let overlappingRequests = checkHits()
            while (overlappingRequests < count && performance.now() - providerWaitStart < providerAdmissionMs) {
              yield* Effect.sleep(50)
              hitList = yield* llm.hits
              overlappingRequests = checkHits()
            }
            if (overlappingRequests !== count) {
              const snapshots = yield* worker.snapshotMany(sessions.map((session) => session.id), identity).pipe(Effect.exit)
              console.error(JSON.stringify({ stage: "provider-admission-failure", expected: count, received: overlappingRequests,
                snapshots: snapshots._tag === "Success" ? snapshots.value.map((s) => ({ state: s.state, activity: s.activity, error: s.error, recovered: s.recovered, generation: s.generation })) : "unavailable" }))
              throw new Error(`Fake provider overlap gate failed: ${overlappingRequests}/${count} arrived within ${providerAdmissionMs}ms`)
            }
            // Hold the concurrent SSE responses for one more measurable tick.
            yield* Effect.sleep(100)
            const providerOverlapAdmissionMs = performance.now() - providerWaitStart
            const arrivalTimes = [...arrivals.values()].map((hit) => hit.receivedAt)
            const requestDelays = arrivalTimes.map((time) => time - startAt)
            const cancelIDs = cancelMode
              ? sessions.filter((_, index) => index % 2 === 1).map((session) => session.id)
              : []
            const cancelStart = performance.now()
            const cancelAcks = yield* Effect.forEach(
              cancelIDs,
              (sessionID) => worker.cancel({ sessionID, identity }),
              { concurrency: Math.min(count, 16) },
            ).pipe(Effect.timeout("15 seconds"))
            if (cancelAcks.some((item) => item.state !== "cancelled")) {
              throw new Error("At least one cancellation did not acknowledge cancelled")
            }
            const cancelMs = performance.now() - cancelStart
            gate.resolve()
            const terminal = yield* worker.waitMany({
              sessionIDs: sessions.map((s) => s.id),
              identity,
              timeout: 90_000,
            })
            const endedAt = performance.now()
            const aborted = new Set(cancelIDs)
            for (const item of terminal) {
              if (aborted.has(item.sessionID) && (item.state === "running" || item.state === "completed")) {
                throw new Error(`Cancelled Session resurrected as ${item.state}: ${item.sessionID}`)
              }
            }
            const states = terminal.reduce<Record<string, number>>((map, item) => {
              map[item.state] = (map[item.state] ?? 0) + 1
              return map
            }, {})
            return {
              sessions: count,
              admitted: sessions.length,
              overlappingProviderRequests: overlappingRequests,
              uniqueProviderSessions: arrivals.size,
              providerFirstArrivalMs: +Math.min(...requestDelays).toFixed(1),
              providerArrivalP50Ms: +quantile(requestDelays, 0.5).toFixed(1),
              providerArrivalP95Ms: +quantile(requestDelays, 0.95).toFixed(1),
              providerArrivalSpanMs: +(Math.max(...arrivalTimes) - Math.min(...arrivalTimes)).toFixed(1),
              cancelRequested: cancelIDs.length,
              cancelAcknowledged: cancelAcks.length,
              cancelMs: +cancelMs.toFixed(1),
              terminal: terminal.length,
              states,
              admissionMs: +(admittedAt - startAt).toFixed(1),
              providerOverlapAdmissionMs: +providerOverlapAdmissionMs.toFixed(1),
              totalMs: +(endedAt - startAt).toFixed(1),
              completedPerSecond: +((states.completed ?? 0) * 1000 / Math.max(1, endedAt - startAt)).toFixed(2),
            }
          }),
        ),
      )),
    )
    const lag = delays.toSorted((a, b) => a - b)
    return {
      ...result,
      timerLagP50Ms: +median(delays).toFixed(1),
      timerLagP95Ms: +(lag[Math.floor(lag.length * 0.95)] ?? 0).toFixed(1),
      timerLagMaxMs: +(lag.at(-1) ?? 0).toFixed(1),
      note: "Local fake HTTP provider and disposable test DB; TTFT and renderer unavailable",
    }
  } finally {
    gate.resolve()
    if (timer) clearInterval(timer)
    await tmp[Symbol.asyncDispose]()
  }
}

let exitCode = 0
try {
  const report = []
  for (const count of requested) {
    const result = await scenario(count)
    report.push(result)
    console.log(JSON.stringify({ stage: "scenario", ...result }))
    const expectedCompleted = count - (cancelMode ? Math.floor(count / 2) : 0)
    if (
      result.admitted !== count ||
      result.overlappingProviderRequests !== count ||
      result.uniqueProviderSessions !== count ||
      result.terminal !== count ||
      result.states.completed !== expectedCompleted ||
      result.cancelAcknowledged !== (cancelMode ? Math.floor(count / 2) : 0)
    ) {
      throw new Error(`Incomplete isolated concurrency fixture at ${count} sessions`)
    }
  }
  console.log(JSON.stringify({ benchmark: "isolated-delegated-session-concurrency", report }, null, 2))
} catch (error) {
  exitCode = 1
  console.error("Isolated benchmark failed:", error)
} finally {
  try {
    await testRuntime.dispose()
  } catch (error) {
    exitCode = 1
    console.error("Fake HTTP server cleanup failed:", error)
  }
  try {
    await AppRuntime.dispose()
  } catch (error) {
    exitCode = 1
    console.error("Isolated AppRuntime cleanup failed:", error)
  }
  try {
    rmSync(benchDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  } catch (error) {
    // Windows SQLite handles may remain locked until process exit.
    // Only the benchmark's explicitly generated temp root is affected.
    console.warn("Temporary benchmark DB cleanup deferred:", (error as Error).message)
  }
  // Native HTTP/SQLite worker handles can keep the Bun event loop alive even
  // after ManagedRuntime disposal. This process is the opt-in benchmark ONLY.
  process.exit(exitCode)
}
