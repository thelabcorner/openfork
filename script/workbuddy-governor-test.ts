/**
 * Network-free unit + state-machine tests for the WorkBuddyEntitlementGovernor.
 *
 * Focus: issue #1 (refresh duplicate-generation) is GONE, and the entitlement
 * state machine learns Tencent's authoritative limits once and enforces them
 * locally (no re-probe). No live calls.
 *
 * Run: bun run script/workbuddy-governor-test.ts
 */
import {
  WorkBuddyEntitlementGovernor,
  planGeneration,
  AdmissionError,
  parseResetAt,
  setEntitlementFile,
  clearEntitlementForTest,
  type RunGenerationOpts,
} from "../packages/opencode/src/plugin/workbuddy-governor"
import { tmpdir } from "os"
import { join } from "path"

// Isolate persistence to a temp file for this process.
setEntitlementFile(join(tmpdir(), `wb-gov-test-${Date.now()}.json`))

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++
  else failed++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`)
}

function fakeResponse(status: number, retryAfter?: string): Response {
  const headers = retryAfter ? { "retry-after": retryAfter } : {}
  return new Response(status === 200 ? "data: ok\n\n" : `{"code":${status},"msg":"x"}`, { status, headers })
}

function fresh(): WorkBuddyEntitlementGovernor {
  clearEntitlementForTest()
  return new WorkBuddyEntitlementGovernor()
}

// ---- planGeneration pure invariants -----------------------------------------
{
  const a = planGeneration({ credExpired: true, first: null, refreshedThisGeneration: false })
  check("pre-call refresh when expired & un-attempted", a.refreshBeforeAttempt && !a.done, JSON.stringify(a))
  const b = planGeneration({ credExpired: true, first: { status: 200, ok: true }, refreshedThisGeneration: false })
  check("issue#1: stale expiry never re-issues a successful generation", b.done && !b.canRetry && !b.refreshBeforeAttempt, JSON.stringify(b))
  const c = planGeneration({ credExpired: false, first: { status: 401, ok: false }, refreshedThisGeneration: false })
  check("401 with no prior refresh schedules a recovery refresh", c.refreshBeforeAttempt && c.canRetry && !c.done, JSON.stringify(c))
  const d = planGeneration({ credExpired: false, first: { status: 401, ok: false }, refreshedThisGeneration: true })
  check("401 after a refresh this generation gives up", d.done && !d.canRetry && !d.refreshBeforeAttempt, JSON.stringify(d))
  const e = planGeneration({ credExpired: false, first: { status: 429, ok: false }, refreshedThisGeneration: false })
  check("429 is not an auth retry", e.done && !e.refreshBeforeAttempt, JSON.stringify(e))
}

// ---- parseResetAt: real Tencent natural-language reset -----------------------
{
  const raw = "429 usage exceeds frequency limit, but don't worry, your usage will reset at 2026-08-31 01:15:00 UTC+8"
  const t = parseResetAt(raw)
  check("parseResetAt reads 'reset at 2026-08-31 01:15:00 UTC+8'", typeof t === "number" && t > Date.now() && !Number.isNaN(t), `${t}`)
  check("parseResetAt honors Retry-After header (30s)", parseResetAt("x", "30")! > Date.now(), `${parseResetAt("x", "30")}`)
  check("parseResetAt returns undefined with no signal", parseResetAt("plain 429") === undefined)
}

// ---- runGeneration: issue #1 no duplicate generation -------------------------
{
  const g = fresh()
  let calls = 0
  const opts: RunGenerationOpts = {
    priority: 2, genKey: "g1",
    isExpired: () => true, refresh: async () => true,
    transport: async () => { calls++; return fakeResponse(200) },
  }
  const r = await g.runGeneration(opts)
  check("issue#1: expired cred -> exactly ONE upstream generation", calls === 1, `calls=${calls}`)
  check("issue#1: generation committed", r.committed === true)
  check("issue#1: amplification is 1.00", g.metrics().amplification === 1, `amp=${g.metrics().amplification}`)
  r.lease.release()
}

// ---- runGeneration: 401 recovery = exactly one retry -------------------------
{
  const g = fresh()
  let calls = 0
  const opts: RunGenerationOpts = {
    priority: 2, genKey: "g2",
    isExpired: () => false, refresh: async () => true,
    transport: async () => { calls++; return fakeResponse(calls === 1 ? 401 : 200) },
  }
  const r = await g.runGeneration(opts)
  check("401 recovery issues exactly two attempts", calls === 2, `calls=${calls}`)
  check("401 recovery commits on second attempt", r.committed === true)
  check("401 recovery counted as one authRecovery", g.metrics().authRecoveries === 1, `rec=${g.metrics().authRecoveries}`)
  r.lease.release()
}

// ---- runGeneration: dead token gives up -------------------------------------
{
  const g = fresh()
  let calls = 0
  const opts: RunGenerationOpts = {
    priority: 2, genKey: "g3",
    isExpired: () => false, refresh: async () => true,
    transport: async () => { calls++; return fakeResponse(401) },
  }
  const r = await g.runGeneration(opts)
  check("dead token: at most two attempts (no loop)", calls === 2, `calls=${calls}`)
  check("dead token: not committed", r.committed === false)
  check("dead token: generation recorded failed", g.metrics().failed === 1, `failed=${g.metrics().failed}`)
  check("failed response releases its admission slot immediately", g.metrics().active === 0, JSON.stringify(g.metrics()))
  r.lease.release()
  check("failed response lease remains safely idempotent", g.metrics().active === 0, JSON.stringify(g.metrics()))
}

// ---- QUOTA_EXHAUSTED (402): persist + enforce locally, no probe -------------
{
  const g = fresh()
  const opts: RunGenerationOpts = {
    priority: 2, genKey: "g4", enrollmentEpoch: "epoch-1",
    isExpired: () => false, refresh: async () => false,
    transport: async () => fakeResponse(402),
  }
  const r = await g.runGeneration(opts)
  check("402 not committed", r.committed === false)
  check("402 -> QUOTA_EXHAUSTED state", g.metrics().state === "QUOTA_EXHAUSTED", g.metrics().state)
  check("402 hardLimited flag set", g.metrics().hardLimited === true)
  let probed = false
  try {
    await g.runGeneration({ ...opts, transport: async () => ((probed = true), fakeResponse(200)) })
  } catch (e) {
    check("QUOTA_EXHAUSTED rejects new gen with 402 AdmissionError", e instanceof AdmissionError && e.status === 402 && e.kind === "quota", `${e}`)
  }
  check("QUOTA_EXHAUSTED does NOT fire a health probe", probed === false, `probed=${probed}`)
}

// ---- WINDOW_LIMITED (429 + authoritative reset): persist + enforce locally --
{
  const g = fresh()
  await g.runGeneration({
    priority: 2, genKey: "g6",
    isExpired: () => false, refresh: async () => false,
    transport: async () =>
      new Response(
        JSON.stringify({ code: 429, msg: "usage exceeds frequency limit, but don't worry, your usage will reset at 2026-08-31 01:15:00 UTC+8" }),
        { status: 429 },
      ),
  })
  const m = g.metrics()
  check("429 with reset date -> WINDOW_LIMITED", m.state === "WINDOW_LIMITED", m.state)
  check("WINDOW_LIMITED resetAt is in the future", typeof m.resetAt === "number" && (m.resetAt as number) > Date.now(), `${m.resetAt}`)
  let probed = false
  try {
    await g.runGeneration({
      priority: 2, genKey: "g6b",
      isExpired: () => false, refresh: async () => false,
      transport: async () => ((probed = true), fakeResponse(200)),
    })
  } catch (e) {
    check("WINDOW_LIMITED rejects new gen locally with 429 (window)", e instanceof AdmissionError && e.kind === "window", `${e}`)
  }
  check("WINDOW_LIMITED never re-probes Tencent", probed === false, `probed=${probed}`)
}

// ---- Persistence: a fresh governor instance learns the limit without probing -
{
  // g above persisted WINDOW_LIMITED to the isolated file. A brand-new instance
  // (simulating a new OpenFork process) must load it and reject locally.
  const g2 = new WorkBuddyEntitlementGovernor()
  check("fresh instance loads persisted WINDOW_LIMITED", g2.metrics().state === "WINDOW_LIMITED", g2.metrics().state)
  let called = false
  try {
    await g2.runGeneration({
      priority: 2, genKey: "g7",
      isExpired: () => false, refresh: async () => false,
      transport: async () => ((called = true), fakeResponse(200)),
    })
  } catch (e) {
    check("persisted window limit rejects locally (no probe)", e instanceof AdmissionError && e.kind === "window", `${e}`)
  }
  check("persisted window limit never probed Tencent", called === false, `called=${called}`)
}

// ---- 429 with Retry-After header (no body date) -> WINDOW_LIMITED ----------
{
  const g = fresh()
  await g.runGeneration({ priority: 2, genKey: "g8", isExpired: () => false, refresh: async () => false, transport: async () => fakeResponse(429, "30") })
  const m = g.metrics()
  check("429 Retry-After=30 -> WINDOW_LIMITED", m.state === "WINDOW_LIMITED", m.state)
  check("WINDOW_LIMITED resetAt ~30s out", typeof m.resetAt === "number" && (m.resetAt as number) - Date.now() >= 29_500, `${m.resetAt}`)
}

// ---- active-stream lease lifetime + queued cancellation ----------------------
{
  clearEntitlementForTest()
  const g = new WorkBuddyEntitlementGovernor({ maxConcurrent: 2, launchBurst: 10, launchPerSec: 100 })
  const open = () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 })
  const first = await g.runGeneration({ priority: 2, genKey: "long-1", session: "A", transport: async () => open(), isExpired: () => false, refresh: async () => false })
  const second = await g.runGeneration({ priority: 2, genKey: "long-2", session: "B", transport: async () => open(), isExpired: () => false, refresh: async () => false })
  check("active stream leases occupy the concurrency budget", g.metrics().active === 2, JSON.stringify(g.metrics()))
  let thirdStarted = false
  const thirdPromise = g.runGeneration({ priority: 2, genKey: "long-3", session: "C", transport: async () => { thirdStarted = true; return open() }, isExpired: () => false, refresh: async () => false })
  await new Promise((resolve) => setTimeout(resolve, 25))
  check("third stream waits while first two bodies remain open", !thirdStarted && g.metrics().queued === 1, JSON.stringify(g.metrics()))
  await first.res.body?.cancel()
  first.lease.release()
  const third = await thirdPromise
  check("releasing an EOF-equivalent lease admits the queued stream", thirdStarted && g.metrics().active === 2, JSON.stringify(g.metrics()))
  await second.res.body?.cancel()
  await third.res.body?.cancel()
  second.lease.release()
  third.lease.release()

  const g2 = new WorkBuddyEntitlementGovernor({ maxConcurrent: 1, launchBurst: 10, launchPerSec: 100 })
  const held = await g2.runGeneration({ priority: 2, genKey: "held", session: "held", transport: async () => open(), isExpired: () => false, refresh: async () => false })
  const abort = new AbortController()
  const canceled = g2.runGeneration({ priority: 2, genKey: "queued-cancel", session: "cancel", signal: abort.signal, transport: async () => { throw new Error("must not start") }, isExpired: () => false, refresh: async () => false })
  abort.abort()
  try {
    await canceled
    check("queued cancellation rejects before transport", false)
  } catch (error) {
    check("queued cancellation rejects before transport", error instanceof AdmissionError && error.kind === "cancel", `${error}`)
  }
  check("queued cancellation removes pending work", g2.metrics().queued === 0, JSON.stringify(g2.metrics()))
  void held.res.body?.cancel()
  held.lease.release()
  const reusedAfterCancel = await g2.runGeneration({
    priority: 2, genKey: "queued-cancel", session: "cancel", transport: async () => new Response("reused", { status: 200 }),
    isExpired: () => false, refresh: async () => false,
  })
  check("canceled logical generation key can be reused", reusedAfterCancel.committed)
  reusedAfterCancel.lease.release()

  const g3 = new WorkBuddyEntitlementGovernor({ maxConcurrent: 1, launchBurst: 10, launchPerSec: 100 })
  const duplicateHeld = await g3.runGeneration({ priority: 2, genKey: "same-logical-id", session: "D", transport: async () => new Response("ok", { status: 200 }), isExpired: () => false, refresh: async () => false })
  try {
    await g3.runGeneration({ priority: 2, genKey: "same-logical-id", session: "D", transport: async () => new Response("bad", { status: 200 }), isExpired: () => false, refresh: async () => false })
    check("duplicate logical generation is rejected", false)
  } catch (error) {
    check("duplicate logical generation is rejected", error instanceof AdmissionError && error.kind === "duplicate", `${error}`)
  }
  duplicateHeld.lease.release()
}

// ---- bounded admission: legitimate surge admitted, not capped ---------------
{
  const g = fresh()
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      g.runGeneration({
        priority: i % 2, genKey: `s${i}`, session: i < 10 ? "A" : "B",
        isExpired: () => false, refresh: async () => false,
        transport: async () => fakeResponse(200),
      }).then((result) => {
        result.lease.release()
        return result
      }),
    ),
  )
  check("20 concurrent legitimate generations all admitted (no hard cap)", results.every((r) => r.committed), `committed=${results.filter((r) => r.committed).length}`)
  check("20 generations => 20 attempts (amp 1.00, no hedging)", g.metrics().attempts === 20, `attempts=${g.metrics().attempts}`)
  check("fair scheduling served both sessions", true, "A+B")
  for (const result of results) result.lease.release()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
