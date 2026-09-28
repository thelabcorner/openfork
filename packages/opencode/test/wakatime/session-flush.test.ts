import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Scope } from "effect"
import { relative } from "node:path"

import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { WakaTime } from "@opencode-ai/core/wakatime"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"

import { WakaTimeSessionFlush } from "../../src/wakatime/session-flush"

/**
 * `session.idle` -> `WakaTime.requestFlushSession` settlement adapter.
 *
 * These tests exercise the adapter's real compiled layer through the standard
 * node machinery against stubbed `EventV2` and `WakaTime` boundaries, because
 * the ownership facts worth proving are the ones a unit test of the handler body
 * would miss:
 *
 * 1. Lifetime. A direct `AppRuntime` graph and a served httpapi graph are
 *    compiled independently in one process. Given one shared memo map they build
 *    one layer, so the invariants are: one Idle listener across both, the
 *    listener surviving the first graph's close, and a clean unsubscribe plus
 *    rebuild on the last.
 * 2. Callback cardinality. One listener, and 1 / 3 / 6+ concurrent sessions each
 *    producing exactly one request, so nothing here scales per session.
 * 3. The callback's blast radius. EventV2 runs `listenType` callbacks inline on
 *    the publish path and detaches a listener on its first fault, so telemetry
 *    failure staying contained is a negative invariant, not a comment.
 *
 * The `WakaTime` stub is pure request capture and nothing more. It deliberately
 * does NOT model delivery, the coalescing queue, the pending slice, or the
 * scheduler, because `requestFlushSession` is Core's O(1) scheduling request and
 * simulating a scheduler here would invent Core semantics in an adapter test.
 * What delivery does with a request — selective pending, duplicate requests, the
 * shared debounce window — is Core's contract and belongs to Core's own tests.
 *
 * Test isolation: every test builds its own `Layer.makeMemoMapUnsafe()` and
 * shares THAT map between the two simulated graphs. This harness deliberately
 * does not import the repository's process-wide `memoMap`, because doing so
 * would co-run with unrelated full-runtime tests in the same Bun process and
 * make this file order-dependent on their cached layers. The production wiring
 * is proven separately, by source, below.
 */

type Listener = (event: never) => Effect.Effect<void>

interface Harness {
  /** Every event type any graph asked to subscribe to, in call order. */
  readonly subscribed: string[]
  /** Live listeners per event type. Length is the duplicate-listener invariant. */
  readonly listeners: Map<string, Listener[]>
  /** Every selective flush request, in order. One per Idle settlement signal. */
  readonly requests: string[]
  /** Sessions whose request faults, to prove telemetry failure stays contained. */
  readonly failing: Set<string>
  /** Every WakaTime operation the adapter called, in order. */
  readonly touched: string[]
  /** Listeners EventV2 would detach after an unisolated callback fault. */
  detached: number
}

function harness(): Harness {
  return {
    subscribed: [],
    listeners: new Map(),
    requests: [],
    failing: new Set(),
    touched: [],
    detached: 0,
  }
}

function detach(state: Harness, type: string, listener: Listener) {
  const list = state.listeners.get(type)
  if (list === undefined) return
  const index = list.indexOf(listener)
  if (index >= 0) list.splice(index, 1)
}

/**
 * Faithful to `EventV2`'s `observe`: a non-interrupt callback fault detaches
 * that listener instead of failing the publisher. A harness that did not
 * reproduce this would keep passing even if the adapter let telemetry failure
 * escape and EventV2 silently stopped every later session from settling.
 */
const publish = (state: Harness, type: string, data: unknown) =>
  Effect.gen(function* () {
    const payload = { id: "evt_test", type, data }
    for (const listener of [...(state.listeners.get(type) ?? [])]) {
      const outcome = yield* (listener as (event: unknown) => Effect.Effect<void>)(payload).pipe(Effect.exit)
      if (Exit.isFailure(outcome) && !Cause.hasInterrupts(outcome.cause)) {
        detach(state, type, listener)
        state.detached++
      }
    }
  })

const idle = (state: Harness, sessionID: string, reason?: "aborted") =>
  publish(state, SessionStatusEvent.Idle.type, reason === undefined ? { sessionID } : { sessionID, reason })

/**
 * Pure request capture. `requestFlushSession` is Core's non-blocking lifecycle
 * call, so the only thing this adapter can be observed doing is naming the
 * session once. Every other operation is recorded rather than left unimplemented
 * so that reaching for a completion-oriented flush shows up as a recorded call
 * instead of a tolerated one.
 */
function stubWakaTime(state: Harness) {
  return Layer.mock(WakaTime.Service, {
    requestFlushSession: (sessionID: string) =>
      Effect.sync(() => {
        state.touched.push("requestFlushSession")
        state.requests.push(sessionID)
        if (state.failing.has(sessionID)) throw new Error(`wakatime-cli unavailable for ${sessionID}`)
      }),
    flushSession: () =>
      Effect.sync(() => {
        state.touched.push("flushSession")
      }),
    flush: () =>
      Effect.sync(() => {
        state.touched.push("flush")
      }),
    record: () =>
      Effect.sync(() => {
        state.touched.push("record")
      }),
    status: () => Effect.sync(() => ({ enabled: true, configured: true })),
    setEnabled: () => Effect.sync(() => ({ enabled: true, configured: true })),
  })
}

function stubEventV2(state: Harness) {
  return Layer.mock(EventV2.Service, {
    listenType: ((definition: { type: string }, listener: Listener) =>
      Effect.sync(() => {
        state.subscribed.push(definition.type)
        const list = state.listeners.get(definition.type) ?? []
        list.push(listener)
        state.listeners.set(definition.type, list)
        return Effect.sync(() => detach(state, definition.type, listener))
      })) as EventV2.Interface["listenType"],
  })
}

/**
 * One direct/server-style graph, compiled independently of every other graph in
 * the process. The only dependencies supplied are the two process-global
 * boundaries this adapter is allowed to reach, which is also the negative
 * invariant for bootstrap cost: a build that needed `InstanceStore`, a Location,
 * or the database could not satisfy its context here at all.
 */
const graph = (state: Harness) =>
  AppNodeBuilder.build(LayerNode.group([WakaTimeSessionFlush.node]), [
    [EventV2.node, stubEventV2(state)],
    [WakaTime.node, stubWakaTime(state)],
  ])

/**
 * Build one graph into a scope the caller owns, through the caller's memo map.
 * Passing one map to two builds is exactly what production does; passing two
 * maps is exactly what production must never do.
 */
const openGraph = (state: Harness, map: Layer.MemoMap) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* Layer.buildWithMemoMap(graph(state), map, scope)
    return scope
  })

/** One map, shared by the direct and served graphs of a single test. */
const sharedMap = () => Layer.makeMemoMapUnsafe()

const closeGraph = (scope: Scope.Closeable) => Scope.close(scope, Exit.void)

const listenerCount = (state: Harness, type: string) => state.listeners.get(type)?.length ?? 0

const IDLE = SessionStatusEvent.Idle.type

/**
 * Assembled rather than written literally, so this file's own assertions about
 * the production memo map cannot match themselves.
 */
const PROCESS_MAP_MODULE = ["@opencode-ai/core", "effect/memo-map"].join("/")

const run = <A, E>(body: Effect.Effect<A, E>) => Effect.runPromise(body)

const repoRoot = new URL("../../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")

async function source(path: string): Promise<string> {
  return Bun.file(`${repoRoot}/${path}`).text()
}

/** Comments may discuss a prohibition; only executable code must obey it. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

describe("WakaTime session settlement is a single process-global Idle consumer", () => {
  test("the adapter declares only the two process-global boundaries it needs", () => {
    expect(WakaTimeSessionFlush.node.dependencies.map((node) => node.name)).toEqual([
      EventV2.node.name,
      WakaTime.node.name,
    ])
  })

  test("two independently compiled graphs sharing one memo map install one Idle listener", async () => {
    const state = harness()
    await run(
      Effect.gen(function* () {
        const map = sharedMap()
        // Concurrent, as two graphs racing at process start really do build.
        const [direct, served] = yield* Effect.all([openGraph(state, map), openGraph(state, map)], {
          concurrency: "unbounded",
        })

        expect(state.subscribed).toEqual([IDLE])
        expect(listenerCount(state, IDLE)).toBe(1)

        state.requests.length = 0
        yield* idle(state, "ses_1")
        expect(state.requests).toEqual(["ses_1"])
        expect(listenerCount(state, IDLE)).toBe(1)

        yield* closeGraph(direct)
        yield* closeGraph(served)
      }),
    )
  })

  test("a private memo map per graph really is a second listener", async () => {
    const state = harness()
    await run(
      Effect.gen(function* () {
        // The counterfactual that gives the test above its meaning: the shared
        // map is what collapses two constructions into one layer. Separate maps
        // are separate constructions, and they do install separate listeners —
        // which is exactly why production must route both graphs through the
        // repository's one process-wide map.
        const shared = yield* openGraph(state, sharedMap())
        const isolated = yield* openGraph(state, Layer.makeMemoMapUnsafe())

        expect(state.subscribed).toEqual([IDLE, IDLE])
        expect(listenerCount(state, IDLE)).toBe(2)

        yield* closeGraph(shared)
        yield* closeGraph(isolated)
      }),
    )
  })

  test("closing the first graph leaves the survivor's listener live", async () => {
    const state = harness()
    await run(
      Effect.gen(function* () {
        const map = sharedMap()
        const direct = yield* openGraph(state, map)
        const served = yield* openGraph(state, map)
        expect(listenerCount(state, IDLE)).toBe(1)

        yield* closeGraph(direct)

        // The graph that built the listener is not the graph that owns it.
        expect(state.detached).toBe(0)
        expect(listenerCount(state, IDLE)).toBe(1)
        state.requests.length = 0
        yield* idle(state, "ses_after_close")
        expect(state.requests).toEqual(["ses_after_close"])

        yield* closeGraph(served)
      }),
    )
  })

  test("the last release unsubscribes, and a later graph rebuilds one listener", async () => {
    const state = harness()
    await run(
      Effect.gen(function* () {
        const map = sharedMap()
        const first = yield* openGraph(state, map)
        const second = yield* openGraph(state, map)
        yield* closeGraph(first)
        yield* closeGraph(second)

        // Convergent teardown: no detached listener outlives the graph that built it.
        expect(listenerCount(state, IDLE)).toBe(0)
        state.requests.length = 0
        yield* idle(state, "ses_after_finalize")
        expect(state.requests).toEqual([])

        const rebuilt = yield* openGraph(state, map)
        expect(state.subscribed).toEqual([IDLE, IDLE])
        expect(listenerCount(state, IDLE)).toBe(1)
        state.requests.length = 0
        yield* idle(state, "ses_rebuilt")
        expect(state.requests).toEqual(["ses_rebuilt"])

        yield* closeGraph(rebuilt)
        expect(listenerCount(state, IDLE)).toBe(0)
      }),
    )
  })
})

describe("Idle handling is O(1), selective, and best-effort", () => {
  test("one listener serves 1 / 3 / 6+ concurrent sessions, one request each", async () => {
    const state = harness()
    await run(
      Effect.gen(function* () {
        const scope = yield* openGraph(state, sharedMap())

        for (const count of [1, 3, 6, 9]) {
          const sessions = Array.from({ length: count }, (_, index) => `ses_${index}`)
          state.requests.length = 0
          for (const session of sessions) yield* idle(state, session)

          // No per-session state: the callback is O(1) per settlement and the
          // subscription count never moves.
          expect(state.requests).toEqual(sessions)
          expect(listenerCount(state, IDLE)).toBe(1)
        }

        yield* closeGraph(scope)
      }),
    )
  })

  test("a natural settle and an aborted settle each request the same session once", async () => {
    const state = harness()
    await run(
      Effect.gen(function* () {
        const scope = yield* openGraph(state, sharedMap())

        yield* idle(state, "ses_natural")
        yield* idle(state, "ses_aborted", "aborted")

        // `Idle` is the one terminal signal for natural success, terminal error,
        // and explicit abort, so all three collapse onto this same single
        // request path rather than separate per-outcome hooks.
        expect(state.requests).toEqual(["ses_natural", "ses_aborted"])
        expect(state.touched).toEqual(["requestFlushSession", "requestFlushSession"])
        yield* closeGraph(scope)
      }),
    )
  })

  test("a duplicate Idle re-requests without multiplying the subscription", async () => {
    const state = harness()
    await run(
      Effect.gen(function* () {
        const scope = yield* openGraph(state, sharedMap())

        yield* idle(state, "ses_dupe")
        yield* idle(state, "ses_dupe")

        // A repeated signal is forwarded verbatim; whether the second request
        // delivers anything is Core's pending-queue semantics, not this
        // adapter's. What the adapter must guarantee is that it still holds
        // exactly one subscription, so a replay can never become a second live
        // listener that settles every future session twice.
        expect(state.requests).toEqual(["ses_dupe", "ses_dupe"])
        expect(listenerCount(state, IDLE)).toBe(1)

        yield* closeGraph(scope)
      }),
    )
  })

  test("the settlement callback only requests; it never delivers or records", async () => {
    const state = harness()
    await run(
      Effect.gen(function* () {
        const scope = yield* openGraph(state, sharedMap())

        // EventV2 runs the callback inline on the publish path, so a delivery
        // call here would hold session settlement on CLI/network work.
        yield* idle(state, "ses_inline")

        expect(state.touched).toEqual(["requestFlushSession"])
        expect(state.requests).toEqual(["ses_inline"])
        expect(listenerCount(state, IDLE)).toBe(1)

        yield* closeGraph(scope)
      }),
    )
  })

  test("nonterminal session events are never consumed", async () => {
    const state = harness()
    await run(
      Effect.gen(function* () {
        const scope = yield* openGraph(state, sharedMap())
        // The adapter subscribed to the terminal event and nothing else, so a
        // busy/retry/status transition has no listener to dispatch into.
        expect(state.subscribed).toEqual([IDLE])

        for (const status of [
          { type: "busy" as const },
          { type: "retry" as const, attempt: 1, message: "rate limited", next: 2 },
        ]) {
          yield* publish(state, SessionStatusEvent.Status.type, { sessionID: "ses_busy", status })
        }
        expect(state.requests).toEqual([])

        yield* closeGraph(scope)
      }),
    )
  })

  test("a telemetry failure neither fails settlement nor detaches the listener", async () => {
    const state = harness()
    await run(
      Effect.gen(function* () {
        const scope = yield* openGraph(state, sharedMap())
        state.failing.add("ses_broken")

        // Would fail this publish if the adapter let the cause escape.
        yield* idle(state, "ses_broken")
        // Would be dead forever if EventV2 had detached the listener.
        yield* idle(state, "ses_healthy")

        expect(state.detached).toBe(0)
        expect(state.requests).toEqual(["ses_broken", "ses_healthy"])
        expect(listenerCount(state, IDLE)).toBe(1)

        yield* closeGraph(scope)
      }),
    )
  })
})

describe("production really does share one process-wide memo map across both graphs", () => {
  test("the direct AppRuntime graph and the served web handler both use the repository map", async () => {
    const runtime = stripComments(await source("packages/opencode/src/effect/app-runtime.ts"))
    const server = stripComments(await source("packages/opencode/src/server/routes/instance/httpapi/server.ts"))

    // One module-level map, imported by both graphs. This is the production
    // precondition the tests above simulate with a local map.
    expect(runtime).toContain(`from "${PROCESS_MAP_MODULE}"`)
    expect(server).toContain(`from "${PROCESS_MAP_MODULE}"`)
    expect(runtime).toContain("ManagedRuntime.make(AppLayer, { memoMap })")
    expect(server).toContain("memoMap,")
    // Neither graph may hand the compiler a private map; that is the exact
    // mistake the counterfactual test reproduces.
    for (const [name, code] of [
      ["app-runtime", runtime],
      ["server", server],
    ] as const) {
      for (const forbidden of ["makeMemoMapUnsafe", "Layer.fresh"]) {
        expect({ name, forbidden, present: code.includes(forbidden) }).toEqual({ name, forbidden, present: false })
      }
    }
  })

  test("this harness does not import the process-wide map, so it cannot be order-dependent", async () => {
    const self = stripComments(await source(relative(repoRoot, new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))))
    expect(self).not.toContain(PROCESS_MAP_MODULE)
    expect(self).toContain("Layer.makeMemoMapUnsafe()")
  })
})
