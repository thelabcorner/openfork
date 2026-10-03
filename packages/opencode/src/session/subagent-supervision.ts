import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { Context, Effect, Fiber, Layer, Option, Scope } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "./status"
import { Session } from "./session"
import { BackgroundJob } from "@/background/job"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { SessionIngress } from "./ingress"
import { SupervisorRegistryTag, type SupervisorRegistry } from "./subagent-supervision-contract"
import * as SubagentSupervisionMetadata from "./subagent-supervision-metadata"

/**
 * Subagent supervision — a lightweight oversight layer ABOVE BackgroundJob and
 * the Task delegation primitive.
 *
 * Ownership split (plan §9, §16, §33 Invariant 5):
 * - DURABLE supervision ownership lives on the child Session metadata
 *   (`taskDelegation`, owned by `subagent-supervision-metadata.ts`).
 * - PROCESS-LOCAL worker execution/lifetime state lives here and in
 *   `BackgroundJob`. Neither is durable, and this service must never claim a
 *   process-local worker is still executing after a restart.
 *
 * This service deliberately does NOT run child agents, schedule a DAG, own
 * permission decisions, replace Session status, replace BackgroundJob, or
 * replace Swarm. It only tracks live cohorts, coalesces meaningful child
 * events, classifies blockers conservatively, and wakes an idle supervisor
 * through the existing SessionIngress wake path (the same mechanism the monitor
 * delivery uses).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SupervisionMode = "supervisor"

/**
 * Whether live execution is known to this process. After a restart the durable
 * relationship survives but the runtime does not, so a reconstructed worker is
 * reported as `unknown_runtime`, never as live (plan §9, §44-45).
 */
export type RuntimeOwnership = "live" | "unknown_runtime"

/**
 * Conservative, evidence-based blocker classification (plan §19).
 * `stalled` is never derived from elapsed wall-clock alone.
 */
export type WorkerState =
  | "working"
  | "idle_with_pending_work"
  | "blocked_permission"
  | "blocked_question"
  | "stalled"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown_runtime"

export type WorkerRuntime =
  | { readonly type: "idle" }
  | { readonly type: "busy" }
  | { readonly type: "retry"; readonly attempt: number }
  | { readonly type: "none" }

export interface WorkerSnapshot {
  readonly sessionID: string
  readonly supervisorSessionID: string
  readonly supervisionGroupID: string
  readonly mode: SupervisionMode
  readonly description: string
  readonly createdFromMessageID: string
  /** Process-local live-execution ownership. `unknown_runtime` after restart. */
  readonly runtime: RuntimeOwnership
  /** Live Session status when the runtime is known; `none` for unknown_runtime. */
  readonly sessionStatus: WorkerRuntime
  readonly state: WorkerState
  /** True when the state was derived from evidence rather than a plain status. */
  readonly evidenceBased: boolean
  /** Bounded, human-readable evidence for the classification. */
  readonly note?: string
}

export interface CohortSnapshot {
  readonly supervisorSessionID: string
  readonly supervisionGroupID: string
  readonly workers: ReadonlyArray<WorkerSnapshot>
  readonly bounded: true
}

export type SupervisionTrigger =
  | "worker_completed"
  | "worker_failed"
  | "worker_cancelled"
  | "worker_blocked_permission"
  | "worker_blocked_question"
  | "worker_tool_failure"
  | "worker_status_changed"
  | "worker_terminal_evidence"
  | "worker_stalled"

export interface Interface extends SupervisorRegistry {
  /** Adopt an already-running detached worker into active supervision (plan §22.1). */
  readonly adopt: (input: import("./subagent-supervision-contract").SupervisorRegistration) => Effect.Effect<void>
  /** Drop active supervision while leaving the worker detached (plan §22.2). */
  readonly relinquish: (input: import("./subagent-supervision-contract").SupervisorRelinquish) => Effect.Effect<void>
  /**
   * Cohort snapshot keyed by supervisionGroupID (or supervisor Session). Live
   * registrations are reported live; durable-only children reconstruct as
   * `unknown_runtime`. Bounded, compact, and cheap enough for several workers.
   */
  readonly snapshot: (input?: {
    supervisorSessionID?: string
    supervisionGroupID?: string
  }) => Effect.Effect<CohortSnapshot>
  /** Live child registrations held in this process (tests/diagnostics). */
  readonly registrations: () => Effect.Effect<ReadonlyArray<WorkerSnapshot>>
  /**
   * Feed one child-changed observation into the coalescer. Meaningful triggers
   * produce at most one coalesced cohort wake per debounce window; low-level
   * tool chatter produces none.
   */
  readonly childChanged: (input: {
    childSessionID: string
    trigger?: SupervisionTrigger
  }) => Effect.Effect<void>
  /** Deliver a coalesced wake to the supervisor through the SessionIngress wake path. */
  readonly wakeSupervisor: (input: {
    supervisorSessionID: string
    supervisionGroupID: string
    triggers: ReadonlyArray<SupervisionTrigger>
  }) => Effect.Effect<void>
  /** Number of coalesced wakes emitted for a cohort (tests/diagnostics). */
  readonly wakeCount: (supervisionGroupID: string) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentSupervision/Service") {}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 150
const STALL_TOOL_FAILURE_THRESHOLD = 3
const STALL_IDENTICAL_CYCLE_THRESHOLD = 3
const MAX_COHORT_WORKERS = 64
const MAX_RECENT_ACTIVITY = 16

type LiveRegistration = {
  readonly supervisorSessionID: string
  readonly childSessionID: string
  readonly supervisionGroupID: string
  readonly mode: SupervisionMode
  readonly description: string
  readonly createdFromMessageID: string
}

type ChildActivity = {
  /** Bounded ring of recent tool names / failure markers for cycle detection. */
  readonly recent: ReadonlyArray<string>
  readonly consecutiveToolFailures: number
}

type CohortState = {
  debounceFiber: Fiber.Fiber<void> | undefined
  readonly pendingTriggers: Set<SupervisionTrigger>
  wakes: number
}

type State = {
  readonly byChild: Map<string, LiveRegistration>
  readonly childIndexByGroup: Map<string, Set<string>>
  readonly activity: Map<string, ChildActivity>
  readonly cohorts: Map<string, CohortState>
  readonly scope: Scope.Scope
}

/** Triggers that warrant waking the supervisor. All of these are meaningful. */
const MEANINGFUL_TRIGGERS: ReadonlySet<SupervisionTrigger> = new Set([
  "worker_completed",
  "worker_failed",
  "worker_cancelled",
  "worker_blocked_permission",
  "worker_blocked_question",
  "worker_tool_failure",
  "worker_status_changed",
  "worker_terminal_evidence",
  "worker_stalled",
])

function isMeaningfulTrigger(trigger: SupervisionTrigger | undefined): trigger is SupervisionTrigger {
  return trigger !== undefined && MEANINGFUL_TRIGGERS.has(trigger)
}

const LOW_LEVEL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.next.tool.input.started",
  "session.next.tool.input.delta",
  "session.next.tool.input.ended",
  "session.next.tool.progress",
  "session.next.tool.called",
  "session.next.tool.success",
  "session.next.text.started",
  "session.next.text.delta",
  "session.next.text.ended",
  "session.next.reasoning.started",
  "session.next.reasoning.delta",
  "session.next.reasoning.ended",
  "session.next.step.started",
  "session.next.step.streamed",
])

/** Real event type strings produced by the runtime producers we observe. */
export const RealEvent = {
  /** SessionStatus publishes on every status transition. */
  status: "session.status",
  /** SessionStatus publishes when a turn ends; `reason: "aborted"` is a real cancel. */
  idle: "session.idle",
  /** Permission service publishes when a child needs a human decision. */
  permissionAsked: "permission.asked",
  /** Permission service publishes when a decision is made (blocker cleared). */
  permissionReplied: "permission.replied",
  /** Question service publishes when a child asks the user something. */
  questionAsked: "question.asked",
  questionReplied: "question.replied",
  questionRejected: "question.rejected",
  /** Session aggregate tool/step/stream events. */
  toolCalled: "session.next.tool.called",
  toolSuccess: "session.next.tool.success",
  toolFailed: "session.next.tool.failed",
  stepFailed: "session.next.step.failed",
  stepEnded: "session.next.step.ended",
  retried: "session.next.retried",
  compactionEnded: "session.next.compaction.ended",
  textDelta: "session.next.text.delta",
  paused: "session.next.paused",
} as const

/**
 * Classify a REAL runtime event into a meaningful supervision trigger, or
 * `undefined` for low-level chatter that must not wake the supervisor
 * (plan §17.1, §41).
 *
 * The event sources are the ones the runtime already publishes; this service
 * adds no producer of its own and no polling:
 * - `session.status` / `session.idle`  — SessionStatus.set (status.ts)
 * - `permission.asked` / `permission.replied` — Permission service
 * - `question.asked` / `question.replied` / `question.rejected` — Question service
 * - `session.next.*` — Session aggregate tool/step/retry events
 */
export function triggerForEvent(event: { readonly type: string; readonly data?: unknown }): SupervisionTrigger | undefined {
  const data = (event.data ?? {}) as { readonly reason?: unknown; readonly status?: { readonly type?: unknown } }
  switch (event.type) {
    // Completion: a child turn settled normally.
    case RealEvent.idle:
      // A real operator cancel is published as idle with reason "aborted".
      return data.reason === "aborted" ? "worker_cancelled" : "worker_completed"
    // Material status change (busy <-> idle <-> retry).
    case RealEvent.status:
      return "worker_status_changed"
    // Failure: provider/tool settlement failure.
    case RealEvent.stepFailed:
      return "worker_failed"
    case RealEvent.toolFailed:
      return "worker_tool_failure"
    // Terminal evidence: a step completed or compaction settled.
    case RealEvent.stepEnded:
    case RealEvent.compactionEnded:
      return "worker_terminal_evidence"
    // Provider retry loop is a real stall signal.
    case RealEvent.retried:
      return "worker_stalled"
    // Human-interaction blockers.
    case RealEvent.permissionAsked:
      return "worker_blocked_permission"
    case RealEvent.questionAsked:
      return "worker_blocked_question"
    // A cleared gate is a material status change back to unblocked.
    case RealEvent.permissionReplied:
    case RealEvent.questionReplied:
    case RealEvent.questionRejected:
    case RealEvent.paused:
      return "worker_status_changed"
    default:
      return undefined
  }
}

export function isLowLevelEvent(type: string): boolean {
  return LOW_LEVEL_EVENT_TYPES.has(type)
}

/**
 * Evidence-based stall detection (plan §19.1). Never uses elapsed wall-clock.
 * Evidence considered:
 * - repeated tool failure pattern;
 * - repeated identical action cycle.
 * Interaction gates are reported separately (blocked_permission/blocked_question).
 */
export function stallEvidence(activity: ChildActivity | undefined): string | undefined {
  if (!activity) return undefined
  if (activity.consecutiveToolFailures >= STALL_TOOL_FAILURE_THRESHOLD) {
    return `repeated tool failure x${activity.consecutiveToolFailures}`
  }
  const recent = activity.recent
  if (recent.length >= STALL_IDENTICAL_CYCLE_THRESHOLD) {
    const window = recent.slice(-STALL_IDENTICAL_CYCLE_THRESHOLD)
    if (window.every((item) => item === window[0])) {
      return `repeated identical action cycle (${window[0]} x${STALL_IDENTICAL_CYCLE_THRESHOLD})`
    }
  }
  return undefined
}

type ClassificationInput = {
  readonly runtime: RuntimeOwnership
  readonly sessionStatus: WorkerRuntime
  readonly backgroundStatus: "running" | "completed" | "error" | "cancelled" | undefined
  readonly hasPermission: boolean
  readonly hasQuestion: boolean
  readonly activity: ChildActivity | undefined
}

export function classifyWorker(input: ClassificationInput): {
  state: WorkerState
  evidenceBased: boolean
  note?: string
} {
  if (input.hasPermission) return { state: "blocked_permission", evidenceBased: true, note: "pending permission" }
  if (input.hasQuestion) return { state: "blocked_question", evidenceBased: true, note: "pending question" }

  switch (input.backgroundStatus) {
    case "completed":
      return { state: "completed", evidenceBased: true, note: "job completed" }
    case "error":
      return { state: "failed", evidenceBased: true, note: "job failed" }
    case "cancelled":
      return { state: "cancelled", evidenceBased: true, note: "job cancelled" }
    default:
      break
  }

  if (input.runtime === "unknown_runtime") {
    return {
      state: "unknown_runtime",
      evidenceBased: true,
      note: "no live process-local execution registered",
    }
  }

  if (input.sessionStatus.type === "busy" || input.sessionStatus.type === "retry") {
    const stalled = stallEvidence(input.activity)
    if (stalled) return { state: "stalled", evidenceBased: true, note: stalled }
    return input.sessionStatus.type === "retry"
      ? { state: "working", evidenceBased: true, note: "provider retry in progress" }
      : { state: "working", evidenceBased: false }
  }

  const stalled = stallEvidence(input.activity)
  if (stalled) return { state: "stalled", evidenceBased: true, note: stalled }
  return { state: "idle_with_pending_work", evidenceBased: false }
}

const make = Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const permission = yield* Permission.Service
    const question = yield* Question.Service
    const ingress = yield* SessionIngress.Service
    const scope = yield* Scope.Scope

    const state = yield* InstanceState.make<State>(
      Effect.fn("SubagentSupervision.state")(function* () {
        const s: State = {
          byChild: new Map(),
          childIndexByGroup: new Map(),
          activity: new Map(),
          cohorts: new Map(),
          scope,
        }
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            // Registrations are process-local; teardown drops them but never
            // touches durable metadata (plan §50, Invariant 5).
            const cohorts = Array.from(s.cohorts.values())
            s.byChild.clear()
            s.childIndexByGroup.clear()
            s.activity.clear()
            s.cohorts.clear()
            yield* Effect.forEach(
              cohorts,
              (cohort) => (cohort.debounceFiber ? Fiber.interrupt(cohort.debounceFiber).pipe(Effect.ignore) : Effect.void),
              { discard: true },
            )
          }),
        )
        return s
      }),
    )

    const data = Effect.fnUntraced(function* () {
      return yield* InstanceState.get(state)
    })

    const touchActivity = (s: State, childSessionID: string, marker: string, failed: boolean) => {
      const previous = s.activity.get(childSessionID)
      const recent = [...(previous?.recent ?? []), marker].slice(-MAX_RECENT_ACTIVITY)
      const consecutive = failed ? (previous?.consecutiveToolFailures ?? 0) + 1 : 0
      s.activity.set(childSessionID, { recent, consecutiveToolFailures: consecutive })
    }

    const workerSnapshot = Effect.fn("SubagentSupervision.workerSnapshot")(function* (
      registration: LiveRegistration,
      runtime: RuntimeOwnership,
    ) {
      const s = yield* data()
      const [liveStatus, bgJob, pendingPermissions, pendingQuestions] = yield* Effect.all(
        [
          runtime === "live"
            ? status.get(SessionID.make(registration.childSessionID))
            : Effect.succeed({ type: "idle" as const }),
          runtime === "live" ? background.get(registration.childSessionID) : Effect.succeed(undefined),
          permission.list().pipe(Effect.catchCause(() => Effect.succeed([] as const))),
          question.list().pipe(Effect.catchCause(() => Effect.succeed([] as const))),
        ],
        { concurrency: 4 },
      )
      const sessionStatus: WorkerRuntime =
        runtime !== "live"
          ? { type: "none" }
          : liveStatus.type === "busy"
            ? { type: "busy" }
            : liveStatus.type === "retry"
              ? { type: "retry", attempt: liveStatus.attempt }
              : { type: "idle" }
      const classified = classifyWorker({
        runtime,
        sessionStatus,
        backgroundStatus: bgJob?.status,
        hasPermission: pendingPermissions.some((item) => item.sessionID === registration.childSessionID),
        hasQuestion: pendingQuestions.some((item) => item.sessionID === registration.childSessionID),
        activity: s.activity.get(registration.childSessionID),
      })
      return {
        sessionID: registration.childSessionID,
        supervisorSessionID: registration.supervisorSessionID,
        supervisionGroupID: registration.supervisionGroupID,
        mode: registration.mode,
        description: registration.description,
        createdFromMessageID: registration.createdFromMessageID,
        runtime,
        sessionStatus,
        state: classified.state,
        evidenceBased: classified.evidenceBased,
        ...(classified.note ? { note: classified.note } : {}),
      } satisfies WorkerSnapshot
    })

    /**
     * Reuse the surviving durable supervision envelope to reconstruct a cohort
     * after restart. Live process-local execution is NOT reconstructed; every
     * reconstructed worker is reported `unknown_runtime` (plan §9, §44-45).
     */
    const reconstruct = Effect.fn("SubagentSupervision.reconstruct")(function* (input: {
      supervisorSessionID?: string
      supervisionGroupID?: string
    }) {
      const s = yield* data()
      const liveByChild = new Set(s.byChild.keys())
      const registrations = new Map<string, LiveRegistration>()

      for (const registration of s.byChild.values()) {
        if (input.supervisionGroupID && registration.supervisionGroupID !== input.supervisionGroupID) continue
        registrations.set(registration.childSessionID, registration)
      }

      if (input.supervisorSessionID) {
        const children = yield* sessions.children(SessionID.make(input.supervisorSessionID)).pipe(
          Effect.catchCause(() => Effect.succeed([] as const)),
        )
        for (const child of children.slice(0, MAX_COHORT_WORKERS)) {
          const envelope = SubagentSupervisionMetadata.taskDelegation(child.metadata)
          if (!envelope) continue
          if (input.supervisionGroupID && envelope.supervisionGroupID !== input.supervisionGroupID) continue
          if (registrations.has(child.id)) continue
          registrations.set(child.id, {
            supervisorSessionID: envelope.supervisorSessionID,
            childSessionID: child.id,
            supervisionGroupID: envelope.supervisionGroupID,
            mode: envelope.mode,
            description: envelope.description,
            createdFromMessageID: envelope.createdFromMessageID,
          })
        }
      }

      return { liveByChild, registrations }
    })

    const snapshot: Interface["snapshot"] = Effect.fn("SubagentSupervision.snapshot")(function* (input) {
      const { liveByChild, registrations } = yield* reconstruct(input ?? {})
      const workers: WorkerSnapshot[] = []
      let group = input?.supervisionGroupID ?? ""
      for (const registration of Array.from(registrations.values()).slice(0, MAX_COHORT_WORKERS)) {
        if (!group) group = registration.supervisionGroupID
        workers.push(yield* workerSnapshot(registration, liveByChild.has(registration.childSessionID) ? "live" : "unknown_runtime"))
      }
      const supervisorSessionID = input?.supervisorSessionID ?? workers[0]?.supervisorSessionID ?? ""
      return { supervisorSessionID, supervisionGroupID: group, workers, bounded: true }
    })

    const registrations: Interface["registrations"] = Effect.fn("SubagentSupervision.registrations")(function* () {
      const s = yield* data()
      const out: WorkerSnapshot[] = []
      for (const registration of s.byChild.values()) {
        out.push(yield* workerSnapshot(registration, "live"))
      }
      return out
    })

    // -----------------------------------------------------------------------
    // Registration / adoption / relinquish
    // -----------------------------------------------------------------------

    const registerLive = (s: State, registration: LiveRegistration) => {
      s.byChild.set(registration.childSessionID, registration)
      const index = s.childIndexByGroup.get(registration.supervisionGroupID) ?? new Set<string>()
      index.add(registration.childSessionID)
      s.childIndexByGroup.set(registration.supervisionGroupID, index)
      if (!s.cohorts.has(registration.supervisionGroupID)) {
        s.cohorts.set(registration.supervisionGroupID, {
          debounceFiber: undefined,
          pendingTriggers: new Set(),
          wakes: 0,
        })
      }
    }

    const register: Interface["register"] = Effect.fn("SubagentSupervision.register")(function* (input) {
      registerLive(yield* data(), {
        supervisorSessionID: input.supervisorSessionID,
        childSessionID: input.childSessionID,
        supervisionGroupID: input.supervisionGroupID,
        mode: "supervisor",
        description: input.description,
        createdFromMessageID: input.createdFromMessageID,
      })
    })

    // Adoption is identical to registration for supervision identity: the child
    // already exists; we only establish active oversight. It never restarts the
    // child (plan §22.1).
    const adopt: Interface["adopt"] = Effect.fn("SubagentSupervision.adopt")(function* (input) {
      registerLive(yield* data(), {
        supervisorSessionID: input.supervisorSessionID,
        childSessionID: input.childSessionID,
        supervisionGroupID: input.supervisionGroupID,
        mode: "supervisor",
        description: input.description,
        createdFromMessageID: input.createdFromMessageID,
      })
    })

    const dropLive = Effect.fnUntraced(function* (s: State, childSessionID: string) {
      const registration = s.byChild.get(childSessionID)
      s.byChild.delete(childSessionID)
      s.activity.delete(childSessionID)
      if (!registration) return
      const index = s.childIndexByGroup.get(registration.supervisionGroupID)
      index?.delete(childSessionID)
      if (index && index.size === 0) {
        s.childIndexByGroup.delete(registration.supervisionGroupID)
        const cohort = s.cohorts.get(registration.supervisionGroupID)
        if (cohort?.debounceFiber) {
          const fiber = cohort.debounceFiber
          cohort.debounceFiber = undefined
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
        }
        s.cohorts.delete(registration.supervisionGroupID)
      }
    })

    const unregister: Interface["unregister"] = Effect.fn("SubagentSupervision.unregister")(function* (childSessionID) {
      yield* dropLive(yield* data(), childSessionID)
    })

    const relinquish: Interface["relinquish"] = Effect.fn("SubagentSupervision.relinquish")(function* (input) {
      yield* dropLive(yield* data(), input.childSessionID)
    })

    // -----------------------------------------------------------------------
    // Coalescing wake engine
    // -----------------------------------------------------------------------

    const wakeSupervisor: Interface["wakeSupervisor"] = Effect.fn("SubagentSupervision.wakeSupervisor")(function* (
      input,
    ) {
      const payload = [
        "<supervision_event>",
        `Supervised workers in cohort ${input.supervisionGroupID} changed.`,
        `triggers: ${input.triggers.join(", ")}`,
        "Inspect the cohort (session children) and decide whether to steer, audit, or integrate.",
        "</supervision_event>",
      ].join("\n")
      yield* ingress.publish({
        id: `sup-${input.supervisionGroupID}-${Date.now()}`,
        kind: "monitor",
        sessionID: SessionID.make(input.supervisorSessionID),
        jobID: `supervision:${input.supervisionGroupID}`,
        sequenceFrom: 1,
        sequenceTo: 1,
        description: "supervised workers changed",
        createdAt: Date.now(),
        trust: "untrusted-external-data",
        payload,
      })
    })

    const flushCohort = Effect.fn("SubagentSupervision.flushCohort")(function* (supervisionGroupID: string) {
      const s = yield* data()
      const cohort = s.cohorts.get(supervisionGroupID)
      if (!cohort) return
      const triggers = Array.from(cohort.pendingTriggers)
      cohort.pendingTriggers.clear()
      cohort.debounceFiber = undefined
      if (triggers.length === 0) return
      const registration = Array.from(s.byChild.values()).find(
        (item) => item.supervisionGroupID === supervisionGroupID,
      )
      if (!registration) return
      cohort.wakes++
      yield* wakeSupervisor({
        supervisorSessionID: registration.supervisorSessionID,
        supervisionGroupID,
        triggers,
      })
      yield* Effect.logInfo("supervision wake emitted", {
        group: supervisionGroupID,
        triggers,
      })
    })

    const scheduleFlush = Effect.fn("SubagentSupervision.scheduleFlush")(function* (supervisionGroupID: string) {
      const s = yield* data()
      const cohort = s.cohorts.get(supervisionGroupID)
      if (!cohort || cohort.debounceFiber) return
      cohort.debounceFiber = yield* Effect.sleep(`${DEBOUNCE_MS} millis`).pipe(
        Effect.andThen(flushCohort(supervisionGroupID)),
        Effect.forkIn(s.scope, { startImmediately: true }),
      )
    })

    const childChanged: Interface["childChanged"] = Effect.fn("SubagentSupervision.childChanged")(function* (input) {
      const s = yield* data()
      const registration = s.byChild.get(input.childSessionID)
      if (!registration) return

      // Record evidence for conservative stall classification.
      if (input.trigger === "worker_tool_failure") {
        touchActivity(s, input.childSessionID, "tool.failed", true)
      } else if (input.trigger === "worker_terminal_evidence") {
        touchActivity(s, input.childSessionID, "step.ended", false)
      }

      // Only meaningful triggers participate in a coalesced wake. Low-level
      // chatter is recorded but never schedules a wake, so a burst of
      // read/grep/read produces ZERO wakes (plan §17.1, §41).
      if (!isMeaningfulTrigger(input.trigger)) return

      const cohort = s.cohorts.get(registration.supervisionGroupID)
      if (!cohort) return
      cohort.pendingTriggers.add(input.trigger)
      yield* scheduleFlush(registration.supervisionGroupID)
    })

    const wakeCount: Interface["wakeCount"] = Effect.fn("SubagentSupervision.wakeCount")(function* (
      supervisionGroupID,
    ) {
      const s = yield* data()
      return s.cohorts.get(supervisionGroupID)?.wakes ?? 0
    })

    // -----------------------------------------------------------------------
    // Live event loop
    // -----------------------------------------------------------------------
    //
    // Subscribe to the process-wide event stream but only act on child Sessions
    // we actually supervise. Meaningful lifecycle events become triggers;
    // low-level chatty events only update local evidence memory.
    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        const trigger = triggerForEvent(event)
        const lowLevel = LOW_LEVEL_EVENT_TYPES.has(event.type)
        // This is a process-wide listener over events from every workspace.
        // Reject unrelated/global events before looking up InstanceState: a
        // host Goal automation event carries sessionID but may have no
        // InstanceRef, and must not defect-detach this listener for the rest of
        // the sidecar lifetime. This also keeps unrelated session traffic out
        // of the per-instance supervision path.
        if (!trigger && !lowLevel) return
        const payload = event.data as { readonly sessionID?: unknown }
        if (typeof payload.sessionID !== "string") return
        const childSessionID = payload.sessionID
        const s = yield* data()
        if (!s.byChild.has(childSessionID)) return

        if (!trigger) {
          // Low-level chatter: record tool names for cycle detection only.
          if (event.type === "session.next.tool.called" || event.type === "session.next.tool.success") {
            const tool =
              "tool" in (event.data as Record<string, unknown>) &&
              typeof (event.data as Record<string, unknown>).tool === "string"
                ? ((event.data as Record<string, unknown>).tool as string)
                : "tool"
            touchActivity(s, childSessionID, tool, false)
          }
          return
        }
        yield* childChanged({ childSessionID, trigger }).pipe(Effect.catchCause(() => Effect.void))
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    return {
      register,
      unregister,
      adopt,
      relinquish,
      snapshot,
      registrations,
      childChanged,
      wakeSupervisor,
      wakeCount,
    } satisfies Interface
  })

/**
 * The implementation value structurally satisfies BOTH the rich `Interface` and
 * the narrow frozen `SupervisorRegistry`. The node is published under
 * `SupervisorRegistryTag` so Task delegation's `Effect.serviceOption` seam
 * resolves it, and the richer surface is available via {@link service} below.
 */
export const layer: Layer.Layer<SupervisorRegistry> = Layer.effect(
  SupervisorRegistryTag,
  make as Effect.Effect<Interface, never, never>,
)

/**
 * Resolve the rich supervision surface. The published tag is the narrow
 * delegation seam; the runtime value is the full service, so this is a
 * sound narrow-to-wide view rather than a second registration.
 */
export const service: Effect.Effect<Interface> = Effect.flatMap(
  Effect.serviceOption(SupervisorRegistryTag),
  (option) =>
    Option.isSome(option) ? Effect.succeed(option.value as unknown as Interface) : Effect.die("SubagentSupervision not provided"),
)

export const node = LayerNode.make({
  service: SupervisorRegistryTag,
  layer,
  deps: [
    EventV2Bridge.node,
    SessionStatus.node,
    Session.node,
    BackgroundJob.node,
    Permission.node,
    Question.node,
    SessionIngress.node,
  ],
})

export * as SubagentSupervision from "./subagent-supervision"
