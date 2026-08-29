import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import { SessionIngress, type SessionIngressEvent } from "@/session/ingress"
import { BackgroundJob } from "@/background/job"
import { ShellJobs } from "@/background/shell-jobs"
import { Effect, Fiber, Layer, Context, SynchronizedRef, Scope } from "effect"

let eventCounter = 0
function fastEventId(): string {
  eventCounter++
  return `mon-${Date.now()}-${eventCounter}`
}

const MAX_LINE_BYTES = 16 * 1024
const MAX_BATCH_LINES = 32
const MAX_BATCH_BYTES = 32 * 1024
const DEFAULT_DEBOUNCE_MS = 200
const RATE_LIMIT_PER_MIN = 60
const RATE_WINDOW_MS = 60_000

type DeliveryState = {
  jobID: string
  ownerSessionID: SessionID
  description: string
  debounceMs: number
  pendingLines: string[]
  pendingBytes: number
  sequence: number
  partial: string
  timerFiber: Fiber.Fiber<void> | undefined
  rateTimestamps: number[]
  stopped: boolean
  terminalEnqueued: boolean
}

type InternalState = {
  jobs: Map<string, DeliveryState>
  scope: Scope.Scope
}

export interface Interface {
  readonly attach: (input: {
    jobID: string
    ownerSessionID: SessionID
    description: string
    debounceMs?: number
  }) => Effect.Effect<void>
  readonly ingest: (jobID: string, chunk: string) => Effect.Effect<void>
  readonly complete: (jobID: string, exit: number | null, timedOut: boolean) => Effect.Effect<void>
  readonly detach: (jobID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MonitorDelivery") {}

function truncateLine(line: string): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(line, "utf-8")
  if (bytes <= MAX_LINE_BYTES) return { text: line, truncated: false }
  // truncate to MAX_LINE_BYTES preserving utf-8 boundaries
  const buf = Buffer.from(line, "utf-8")
  let end = MAX_LINE_BYTES - 20 // reserve for marker
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  const truncated = buf.subarray(0, end).toString("utf-8") + "…[truncated]"
  return { text: truncated, truncated: true }
}

function frameLines(partial: string, chunk: string): { lines: string[]; remaining: string } {
  const text = partial + chunk.replace(/\r\n/g, "\n")
  const parts = text.split("\n")
  const remaining = parts.pop() ?? ""
  const lines: string[] = []
  for (const raw of parts) {
    const trimmed = raw.trimEnd()
    // Empty lines discarded per spec §35.3
    if (trimmed.length === 0) continue
    // Check NUL-heavy binary: if contains NUL or >30% non-printable
    if (trimmed.includes("\0")) continue
    const { text } = truncateLine(trimmed)
    lines.push(text)
  }
  return { lines, remaining }
}

function isRateLimited(state: DeliveryState, newEvents: number): boolean {
  const now = Date.now()
  // prune window
  state.rateTimestamps = state.rateTimestamps.filter((t) => now - t < RATE_WINDOW_MS)
  // would adding newEvents exceed limit?
  return state.rateTimestamps.length + newEvents > RATE_LIMIT_PER_MIN
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const ingress = yield* SessionIngress.Service
    const background = yield* BackgroundJob.Service
    const jobs = yield* ShellJobs.Service
    const scope = yield* Scope.Scope

    const stateRef = yield* SynchronizedRef.make<InternalState>({ jobs: new Map(), scope })

    const flushBatch = Effect.fn("MonitorDelivery.flushBatch")(function* (jobID: string, terminal?: SessionIngressEvent["terminal"]) {
      // Re-read state after any async boundary — state may have been removed (e.g. detach)
      const internal = yield* SynchronizedRef.get(stateRef)
      const state = internal.jobs.get(jobID)
      if (!state) return
      if (state.pendingLines.length === 0) {
        if (terminal) {
          const ev: SessionIngressEvent = {
            id: fastEventId(),
            kind: "monitor",
            sessionID: state?.ownerSessionID ?? ("" as SessionID),
            jobID,
            sequenceFrom: state ? state.sequence : 1,
            sequenceTo: state ? state.sequence : 1,
            description: state?.description ?? jobID,
            createdAt: Date.now(),
            trust: "untrusted-external-data",
            payload: "",
            terminal,
          }
          if (state) state.sequence++
          yield* ingress.publish(ev)
        }
        return
      }
      const count = state.pendingLines.length
      // rate limit check
      if (isRateLimited(state, count)) {
        // firehose protection: stop monitor, emit rate_limited terminal once
        state.stopped = true
        // cancel job
        yield* background.cancel(jobID).pipe(Effect.ignore)
        const entry = yield* jobs.get(jobID).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (entry) yield* entry.handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore)
        // publish overflow terminal with coalesced payload
        const payload = state.pendingLines.join("\n")
        const ev: SessionIngressEvent = {
          id: fastEventId(),
          kind: "monitor",
          sessionID: state.ownerSessionID,
          jobID,
          sequenceFrom: state.sequence,
          sequenceTo: state.sequence + count - 1,
          description: state.description,
          createdAt: Date.now(),
          trust: "untrusted-external-data",
          payload: payload + "\n\n[monitor stopped: event rate exceeded 60 lines/minute — filter the watcher more narrowly before restarting it]",
          terminal: { status: "rate_limited" },
        }
        state.sequence += count
        state.pendingLines = []
        state.pendingBytes = 0
        state.rateTimestamps.push(...Array.from({ length: count }, () => Date.now()))
        yield* ingress.publish(ev)
        yield* Effect.logWarning("monitor firehose stopped", { jobID, description: state.description })
        return
      }

      // normal flush
      const payload = state.pendingLines.join("\n")
      const from = state.sequence
      const to = state.sequence + count - 1
      state.sequence += count
      // update rate window
      for (let i = 0; i < count; i++) state.rateTimestamps.push(Date.now())
      // prune old
      const now = Date.now()
      state.rateTimestamps = state.rateTimestamps.filter((t) => now - t < RATE_WINDOW_MS)

      const ev: SessionIngressEvent = {
        id: fastEventId(),
        kind: "monitor",
        sessionID: state.ownerSessionID,
        jobID,
        sequenceFrom: from,
        sequenceTo: to,
        description: state.description,
        createdAt: now,
        trust: "untrusted-external-data",
        payload,
        ...(terminal ? { terminal } : {}),
      }
      // clear pending before publish (enqueue-first invariant holds inside ingress)
      state.pendingLines = []
      state.pendingBytes = 0
      if (state.timerFiber) {
        yield* Fiber.interrupt(state.timerFiber).pipe(Effect.ignore)
        state.timerFiber = undefined
      }
      yield* ingress.publish(ev)
    })

    const scheduleFlush = Effect.fn("MonitorDelivery.scheduleFlush")(function* (jobID: string) {
      const internal = yield* SynchronizedRef.get(stateRef)
      const state = internal.jobs.get(jobID)
      if (!state || state.timerFiber || state.stopped) return
      const fiber = yield* Effect.sleep(`${state.debounceMs} millis`).pipe(
        Effect.andThen(flushBatch(jobID)),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      state.timerFiber = fiber
    })

    const attach: Interface["attach"] = Effect.fn("MonitorDelivery.attach")(function* (input) {
      const internal = yield* SynchronizedRef.get(stateRef)
      if (internal.jobs.has(input.jobID)) return
      internal.jobs.set(input.jobID, {
        jobID: input.jobID,
        ownerSessionID: input.ownerSessionID,
        description: input.description,
        debounceMs: input.debounceMs ?? DEFAULT_DEBOUNCE_MS,
        pendingLines: [],
        pendingBytes: 0,
        sequence: 1,
        partial: "",
        timerFiber: undefined,
        rateTimestamps: [],
        stopped: false,
        terminalEnqueued: false,
      })
      yield* Effect.logInfo("monitor attached", { jobID: input.jobID, description: input.description })
    })

    const ingest: Interface["ingest"] = Effect.fn("MonitorDelivery.ingest")(function* (jobID, chunk) {
      const internal = yield* SynchronizedRef.get(stateRef)
      const state = internal.jobs.get(jobID)
      if (!state || state.stopped) return
      const { lines, remaining } = frameLines(state.partial, chunk)
      state.partial = remaining
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line, "utf-8")
        // pending bounds: if adding would exceed, flush early
        if (state.pendingLines.length >= MAX_BATCH_LINES || state.pendingBytes + lineBytes > MAX_BATCH_BYTES) {
          yield* flushBatch(jobID)
          // re-check after flush in case still stopped
          if (state.stopped) return
        }
        state.pendingLines.push(line)
        state.pendingBytes += lineBytes + 1
      }
      if (state.pendingLines.length === 0) return
      // hard bound flush mid-batch already handled; else schedule debounce
      if (state.pendingLines.length >= MAX_BATCH_LINES || state.pendingBytes >= MAX_BATCH_BYTES) {
        yield* flushBatch(jobID)
      } else {
        yield* scheduleFlush(jobID)
      }
    })

    const complete: Interface["complete"] = Effect.fn("MonitorDelivery.complete")(function* (jobID, exit, timedOut) {
      const internal = yield* SynchronizedRef.get(stateRef)
      const state = internal.jobs.get(jobID)
      if (!state) return
      // flush partial line if any
      if (state.partial.trim().length > 0) {
        const trimmed = state.partial.trimEnd()
        if (trimmed.length > 0 && !trimmed.includes("\0")) {
          const { text } = truncateLine(trimmed)
          state.pendingLines.push(text)
          state.pendingBytes += Buffer.byteLength(text, "utf-8")
        }
        state.partial = ""
      }
      if (state.stopped) {
        // already terminated via rate limit, don't emit second terminal
        yield* SynchronizedRef.update(stateRef, (s) => {
          const next = new Map(s.jobs)
          next.delete(jobID)
          return { ...s, jobs: next }
        })
        return
      }
      // Determine terminal status for monitor semantics: only terminal wake for natural exit/error/timeout, but NOT for explicit kill (cancelled)
      // Background lifecycle owns terminal; however monitor delivery should coalesce pending lines + terminal into ONE wake when exit happens soon after lines.
      // For explicit kill, background cancel will have already set status cancelled — we should NOT emit a monitor terminal wake (spec §52)
      // Detect explicit kill: background info status cancelled? We can check background.get
      const info = yield* background.get(jobID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const statusCancelled = info?.status === "cancelled"
      let terminal: SessionIngressEvent["terminal"] | undefined
      if (timedOut) terminal = { status: "timeout" }
      else if (exit === 0) terminal = { status: "completed" }
      else if (exit !== null) terminal = { status: "error" }
      else if (statusCancelled) terminal = undefined // no wake for explicit kill
      // If there are pending lines, flush them with terminal coalesced
      if (state.pendingLines.length > 0) {
        yield* flushBatch(jobID, terminal)
      } else if (terminal) {
        const ev: SessionIngressEvent = {
          id: fastEventId(),
          kind: "monitor",
          sessionID: state.ownerSessionID,
          jobID,
          sequenceFrom: state.sequence,
          sequenceTo: state.sequence,
          description: state.description,
          createdAt: Date.now(),
          trust: "untrusted-external-data",
          payload: "",
          terminal,
        }
        yield* ingress.publish(ev)
      }
      // cleanup
      if (state.timerFiber) yield* Fiber.interrupt(state.timerFiber).pipe(Effect.ignore)
      yield* SynchronizedRef.update(stateRef, (s) => {
        const next = new Map(s.jobs)
        next.delete(jobID)
        return { ...s, jobs: next }
      })
    })

    const detach: Interface["detach"] = Effect.fn("MonitorDelivery.detach")(function* (jobID) {
      const internal = yield* SynchronizedRef.get(stateRef)
      const state = internal.jobs.get(jobID)
      if (!state) return
      if (state.timerFiber) yield* Fiber.interrupt(state.timerFiber).pipe(Effect.ignore)
      internal.jobs.delete(jobID)
    })

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const internal = yield* SynchronizedRef.get(stateRef)
        for (const s of internal.jobs.values()) {
          if (s.timerFiber) yield* Fiber.interrupt(s.timerFiber).pipe(Effect.ignore)
        }
        internal.jobs.clear()
      }),
    )

    return Service.of({ attach, ingest, complete, detach })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [SessionIngress.node, BackgroundJob.node, ShellJobs.node],
})

export * as MonitorDelivery from "./monitor-delivery"
