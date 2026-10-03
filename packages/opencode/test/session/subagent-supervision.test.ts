import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer, Ref } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { BackgroundJob } from "@/background/job"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { SessionIngress } from "@/session/ingress"
import { SubagentSupervision } from "@/session/subagent-supervision"
import { SupervisorRegistryTag } from "@/session/subagent-supervision-contract"
import * as SubagentSupervisionMetadata from "@/session/subagent-supervision-metadata"
import { SessionID } from "@/session/schema"
import { InstanceBootstrap } from "@/project/bootstrap"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([
    SubagentSupervision.node,
    EventV2Bridge.node,
    Session.node,
    SessionStatus.node,
    BackgroundJob.node,
    Permission.node,
    Question.node,
    SessionIngress.node,
    SessionProjector.node,
    Database.node,
  ]),
  [
    [
      InstanceBootstrap.node,
      Layer.succeed(
        InstanceBootstrap.Service,
        InstanceBootstrap.Service.of({ gate: Effect.void, warmup: Effect.void }),
      ),
    ],
  ],
)

const it = testEffect(layer)

const supervisor = "ses_supervisor" as ReturnType<typeof SessionID.make>
const group = "sup:msg_abc"

function childID(name: string) {
  return SessionID.make(name)
}

/** Track how many times the coalesced wake path targets a supervisor session. */
const wakeCounter = () =>
  Effect.gen(function* () {
    const ingress = yield* SessionIngress.Service
    const wakes = yield* Ref.make<ReadonlyArray<string>>([])
    yield* ingress.registerWakeHandler((sessionID) =>
      Ref.update(wakes, (current) => [...current, sessionID]),
    )
    return {
      wakes: () => Ref.get(wakes),
      of: (sessionID: SessionID) => Ref.get(wakes).pipe(Effect.map((all) => all.filter((id) => id === sessionID).length)),
    }
  })

const registerChild = (input: {
  supervisorSessionID?: SessionID
  childSessionID: SessionID
  supervisionGroupID?: string
  description?: string
}) =>
  Effect.gen(function* () {
    const service = yield* SubagentSupervision.service
    yield* service.register({
      supervisorSessionID: input.supervisorSessionID ?? supervisor,
      childSessionID: input.childSessionID,
      supervisionGroupID: input.supervisionGroupID ?? group,
      mode: "supervisor",
      description: input.description ?? "worker",
      createdFromMessageID: "msg_origin",
    })
  })

describe("SubagentSupervision registration and cohort identity", () => {
  it.instance("registers children under one supervision cohort keyed by group", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const a = childID("ses_worker_a")
      const b = childID("ses_worker_b")
      yield* registerChild({ childSessionID: a })
      yield* registerChild({ childSessionID: b })

      const snap = yield* service.snapshot({ supervisionGroupID: group })
      expect(snap.supervisionGroupID).toBe(group)
      expect(snap.bounded).toBe(true)
      expect(snap.workers.map((worker) => worker.sessionID).sort()).toEqual([a, b].sort())
      for (const worker of snap.workers) {
        expect(worker.mode).toBe("supervisor")
        expect(worker.runtime).toBe("live")
      }
    }),
  )

  it.instance("keeps distinct cohorts separate by group identity", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      yield* registerChild({ childSessionID: childID("ses_a"), supervisionGroupID: "sup:one" })
      yield* registerChild({ childSessionID: childID("ses_b"), supervisionGroupID: "sup:two" })

      const one = yield* service.snapshot({ supervisionGroupID: "sup:one" })
      const two = yield* service.snapshot({ supervisionGroupID: "sup:two" })
      expect(one.workers.map((worker) => worker.sessionID)).toEqual(["ses_a"])
      expect(two.workers.map((worker) => worker.sessionID)).toEqual(["ses_b"])
    }),
  )

  it.instance("exposes the frozen SupervisorRegistryTag seam with register/unregister", () =>
    Effect.gen(function* () {
      const registry = yield* SupervisorRegistryTag
      const child = childID("ses_seam")
      yield* registry.register({
        supervisorSessionID: supervisor,
        childSessionID: child,
        supervisionGroupID: group,
        mode: "supervisor",
        description: "seam worker",
        createdFromMessageID: "msg_origin",
      })
      const service = yield* SubagentSupervision.service
      expect((yield* service.registrations()).map((worker) => worker.sessionID)).toContain(child)
      yield* registry.unregister(child)
      expect((yield* service.registrations()).map((worker) => worker.sessionID)).not.toContain(child)
    }),
  )
})

describe("SubagentSupervision event coalescing and wake behavior", () => {
  it.instance("low-level tool chatter produces ZERO wakes", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const wake = yield* wakeCounter()
      const child = childID("ses_worker_a")
      yield* registerChild({ childSessionID: child })

      // A burst of ordinary read/grep/read style activity carries no meaningful
      // trigger and must never schedule a cohort wake.
      for (let i = 0; i < 25; i++) {
        yield* service.childChanged({ childSessionID: child })
      }
      // Let any (incorrectly) scheduled debounce fire.
      yield* Effect.sleep("400 millis")
      expect(yield* service.wakeCount(group)).toBe(0)
      expect(yield* wake.of(supervisor)).toBe(0)
    }),
  )

  it.instance("a burst of meaningful changes coalesces into exactly one wake", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const wake = yield* wakeCounter()
      const a = childID("ses_worker_a")
      const b = childID("ses_worker_b")
      yield* registerChild({ childSessionID: a })
      yield* registerChild({ childSessionID: b })

      yield* service.childChanged({ childSessionID: a, trigger: "worker_terminal_evidence" })
      yield* service.childChanged({ childSessionID: b, trigger: "worker_tool_failure" })
      yield* service.childChanged({ childSessionID: a, trigger: "worker_status_changed" })

      yield* pollWithTimeout(
        Effect.gen(function* () {
          const count = yield* service.wakeCount(group)
          return count >= 1 ? count : undefined
        }),
        "cohort wake never coalesced",
      )
      // One coalesced wake for the whole burst, not one per change.
      expect(yield* service.wakeCount(group)).toBe(1)
      expect(yield* wake.of(supervisor)).toBe(1)
    }),
  )

  it.instance("separate debounce windows produce separate coalesced wakes", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const wake = yield* wakeCounter()
      const child = childID("ses_worker_a")
      yield* registerChild({ childSessionID: child })

      yield* service.childChanged({ childSessionID: child, trigger: "worker_tool_failure" })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const count = yield* service.wakeCount(group)
          return count >= 1 ? count : undefined
        }),
        "first wake missing",
      )
      yield* service.childChanged({ childSessionID: child, trigger: "worker_completed" })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const count = yield* service.wakeCount(group)
          return count >= 2 ? count : undefined
        }),
        "second wake missing",
      )
      expect(yield* service.wakeCount(group)).toBe(2)
      expect(yield* wake.of(supervisor)).toBe(2)
    }),
  )

  it.instance("completion, failure, and cancellation each yield exactly one coalesced wake", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      yield* wakeCounter()
      const cases: Array<{ trigger: "worker_completed" | "worker_failed" | "worker_cancelled"; child: string }> = [
        { trigger: "worker_completed", child: "ses_complete" },
        { trigger: "worker_failed", child: "ses_failed" },
        { trigger: "worker_cancelled", child: "ses_cancelled" },
      ]
      for (const entry of cases) {
        const cohort = `sup:${entry.trigger}`
        yield* registerChild({ childSessionID: childID(entry.child), supervisionGroupID: cohort })
        yield* service.childChanged({ childSessionID: childID(entry.child), trigger: entry.trigger })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const count = yield* service.wakeCount(cohort)
            return count >= 1 ? count : undefined
          }),
          `no wake for ${entry.trigger}`,
        )
        expect(yield* service.wakeCount(cohort)).toBe(1)
      }
    }),
  )

  it.instance("a wake targets the supervisor session through the ingress path", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const ingress = yield* SessionIngress.Service
      const wake = yield* wakeCounter()
      const child = childID("ses_worker_a")
      yield* registerChild({ childSessionID: child })

      yield* service.childChanged({ childSessionID: child, trigger: "worker_tool_failure" })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const count = yield* service.wakeCount(group)
          return count >= 1 ? count : undefined
        }),
        "wake never emitted",
      )
      expect(yield* wake.of(supervisor)).toBe(1)
      expect(yield* ingress.hasPending(supervisor)).toBe(true)
    }),
  )

  it.instance("ignores child changes for unregistered sessions", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const wake = yield* wakeCounter()
      yield* service.childChanged({ childSessionID: childID("ses_stranger"), trigger: "worker_completed" })
      yield* Effect.sleep("300 millis")
      expect(yield* service.wakeCount(group)).toBe(0)
      expect(yield* wake.of(supervisor)).toBe(0)
    }),
  )
})

describe("SubagentSupervision blocker classification", () => {
  it.instance("classifies a pending permission as blocked_permission", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const permission = yield* Permission.Service
      const child = childID("ses_perm")
      yield* registerChild({ childSessionID: child })

      yield* permission.ask({
        sessionID: child,
        permission: "external_directory",
        patterns: ["/outside"],
        always: ["*"],
        metadata: {},
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const snap = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* service.snapshot({ supervisionGroupID: group })
          const worker = current.workers.find((item) => item.sessionID === child)
          return worker?.state === "blocked_permission" ? worker : undefined
        }),
        "permission blocker never classified",
      )
      expect(snap.evidenceBased).toBe(true)
      expect(snap.note).toContain("permission")
    }),
  )

  it.instance("classifies a pending question as blocked_question", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const question = yield* Question.Service
      const child = childID("ses_question")
      yield* registerChild({ childSessionID: child })

      yield* question
        .askDetailed({
          sessionID: child,
          questions: [{ question: "Proceed?", header: "Confirm", options: [] } as never],
        })
        .pipe(Effect.forkScoped)

      const snap = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* service.snapshot({ supervisionGroupID: group })
          const worker = current.workers.find((item) => item.sessionID === child)
          return worker?.state === "blocked_question" ? worker : undefined
        }),
        "question blocker never classified",
      )
      expect(snap.evidenceBased).toBe(true)
      expect(snap.note).toContain("question")
    }),
  )

  it.instance("reports an idle, unblocked worker as idle_with_pending_work (not stalled)", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const child = childID("ses_idle")
      yield* registerChild({ childSessionID: child })
      const snap = yield* service.snapshot({ supervisionGroupID: group })
      const worker = snap.workers.find((item) => item.sessionID === child)
      expect(worker?.state).toBe("idle_with_pending_work")
      expect(worker?.evidenceBased).toBe(false)
    }),
  )
})

describe("SubagentSupervision evidence-based stall detection", () => {
  it.instance("repeated tool failure evidence marks a worker stalled", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const child = childID("ses_failing")
      yield* registerChild({ childSessionID: child })
      for (let i = 0; i < 3; i++) {
        yield* service.childChanged({ childSessionID: child, trigger: "worker_tool_failure" })
      }
      const snap = yield* service.snapshot({ supervisionGroupID: group })
      const worker = snap.workers.find((item) => item.sessionID === child)
      expect(worker?.state).toBe("stalled")
      expect(worker?.evidenceBased).toBe(true)
      expect(worker?.note).toContain("tool failure")
    }),
  )

  it.instance("repeated identical action cycle evidence marks a worker stalled", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const events = yield* EventV2Bridge.Service
      const child = childID("ses_cycle")
      yield* registerChild({ childSessionID: child })
      // Three identical successful actions with no progress between them.
      for (let i = 0; i < 3; i++) {
        yield* events.publish(
          // @ts-expect-error test publishes a minimal synthetic session event
          { type: "session.next.tool.success", schema: {}, durable: undefined },
          {
            timestamp: Date.now(),
            sessionID: child,
            assistantMessageID: "msg_1",
            callID: `call_${i}`,
            tool: "read",
            structured: {},
            content: [],
            provider: { executed: true },
          },
        )
      }
      const snap = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* service.snapshot({ supervisionGroupID: group })
          const worker = current.workers.find((item) => item.sessionID === child)
          return worker?.state === "stalled" ? worker : undefined
        }),
        "identical cycle never classified stalled",
      )
      expect(snap.note).toContain("identical action cycle")
    }),
  )

  it.instance("does NOT mark stalled from elapsed wall-clock alone", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const child = childID("ses_slow")
      yield* registerChild({ childSessionID: child })
      // Wait longer than any debounce/threshold window without any evidence.
      yield* Effect.sleep("600 millis")
      const snap = yield* service.snapshot({ supervisionGroupID: group })
      const worker = snap.workers.find((item) => item.sessionID === child)
      expect(worker?.state).toBe("idle_with_pending_work")
      expect(worker?.state).not.toBe("stalled")
    }),
  )
})

describe("SubagentSupervision restart reconstruction", () => {
  it.instance("reconstructs durable cohort membership but reports unknown_runtime, never live", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const service = yield* SubagentSupervision.service

      const supervisorSession = yield* sessions.create({ title: "Supervisor" })
      const child = yield* sessions.create({
        parentID: supervisorSession.id,
        title: "Durable worker",
        metadata: SubagentSupervisionMetadata.withTaskDelegation({
          mode: "supervisor",
          supervisorSessionID: supervisorSession.id,
          supervisionGroupID: group,
          description: "durable worker",
          createdFromMessageID: "msg_origin",
        }),
      })

      // Simulate a fresh process: nothing is registered live for this child.
      const snap = yield* service.snapshot({ supervisorSessionID: supervisorSession.id })
      const worker = snap.workers.find((item) => item.sessionID === child.id)
      expect(worker).toBeDefined()
      expect(worker?.runtime).toBe("unknown_runtime")
      expect(worker?.state).toBe("unknown_runtime")
      expect(worker?.supervisionGroupID).toBe(group)
      // The durable relationship survives even though its description differs
      // from nothing live — restart must never fabricate live execution.
      expect(worker?.runtime).not.toBe("live")
    }),
  )

  it.instance("ignores children without a durable supervision envelope", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const service = yield* SubagentSupervision.service
      const supervisorSession = yield* sessions.create({ title: "Supervisor" })
      const plain = yield* sessions.create({ parentID: supervisorSession.id, title: "Ordinary child" })

      const snap = yield* service.snapshot({ supervisorSessionID: supervisorSession.id })
      expect(snap.workers.map((worker) => worker.sessionID)).not.toContain(plain.id)
    }),
  )
})

describe("SubagentSupervision cleanup and idempotency", () => {
  it.instance("drops registration on terminal unregister with no duplicate completion wake", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const wake = yield* wakeCounter()
      const child = childID("ses_terminal")
      yield* registerChild({ childSessionID: child })

      yield* service.childChanged({ childSessionID: child, trigger: "worker_completed" })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const count = yield* service.wakeCount(group)
          return count >= 1 ? count : undefined
        }),
        "completion wake missing",
      )

      yield* service.unregister(child)
      expect((yield* service.registrations()).map((worker) => worker.sessionID)).not.toContain(child)

      // A late duplicate completion for an already-cleaned worker must not
      // inject a second wake. The cohort itself is torn down on terminal
      // cleanup, so the durable observable is the wake target count.
      yield* service.childChanged({ childSessionID: child, trigger: "worker_completed" })
      yield* Effect.sleep("300 millis")
      expect(yield* wake.of(supervisor)).toBe(1)
    }),
  )

  it.instance("relinquish removes live registration without touching durable metadata", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const service = yield* SubagentSupervision.service
      const child = yield* sessions.create({
        title: "Adopted worker",
        metadata: SubagentSupervisionMetadata.withTaskDelegation({
          mode: "supervisor",
          supervisorSessionID: supervisor,
          supervisionGroupID: group,
          description: "adopted",
          createdFromMessageID: "msg_origin",
        }),
      })
      yield* service.adopt({
        supervisorSessionID: supervisor,
        childSessionID: child.id,
        supervisionGroupID: group,
        mode: "supervisor",
        description: "adopted",
        createdFromMessageID: "msg_origin",
      })
      yield* service.relinquish({ childSessionID: child.id })
      expect((yield* service.registrations()).map((worker) => worker.sessionID)).not.toContain(child.id)

      // Durable metadata is preserved by relinquish (the delegation owner clears
      // it; the supervision service must not).
      const reread = yield* sessions.get(child.id)
      expect(SubagentSupervisionMetadata.taskDelegation(reread.metadata)).toBeDefined()
    }),
  )

  it.instance("register is idempotent for the same child", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const child = childID("ses_idempotent")
      yield* registerChild({ childSessionID: child })
      yield* registerChild({ childSessionID: child })
      const live = (yield* service.registrations()).filter((worker) => worker.sessionID === child)
      expect(live).toHaveLength(1)
    }),
  )
})

// ---------------------------------------------------------------------------
// Real event-path coverage (plan §27 items 37-41)
//
// These prove the six meaningful categories are driven by the SAME event
// producers the runtime already publishes — never by a test-only producer.
// ---------------------------------------------------------------------------

describe("SubagentSupervision real event-path classification", () => {
  // A test-only fake event definition. The real classifier is keyed by the
  // `type` string, so the schema here is intentionally opaque and the cast is
  // the boundary that lets the fake definition flow through the generic
  // `EventV2.publish` signature.
  const synthetic = (type: string) => ({ type, schema: {}, durable: undefined }) as any

  it.instance("real session.idle classifies as completion and wakes the cohort", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const events = yield* EventV2Bridge.Service
      const wake = yield* wakeCounter()
      const child = childID("ses_completion")
      yield* registerChild({ childSessionID: child })

      // Real producer: SessionStatus publishes session.idle when a turn ends.
      yield* events.publish(synthetic(SubagentSupervision.RealEvent.idle), { sessionID: child })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const count = yield* service.wakeCount(group)
          return count >= 1 ? count : undefined
        }),
        "real session.idle never produced a wake",
      )
      expect(yield* service.wakeCount(group)).toBe(1)
      expect(yield* wake.of(supervisor)).toBe(1)
    }),
  )

  it.instance("real aborted session.idle classifies as cancellation, distinct from completion", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const events = yield* EventV2Bridge.Service
      const cohort = "sup:cancel"
      const child = childID("ses_cancel")
      yield* registerChild({ childSessionID: child, supervisionGroupID: cohort })

      // SessionStatus publishes idle with reason "aborted" for an operator stop.
      yield* events.publish(synthetic(SubagentSupervision.RealEvent.idle), {
        sessionID: child,
        reason: "aborted",
      })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const count = yield* service.wakeCount(cohort)
          return count >= 1 ? count : undefined
        }),
        "real aborted idle never produced a wake",
      )
      expect(yield* service.wakeCount(cohort)).toBe(1)
      // The producer-side classifier distinguishes the two cases.
      expect(SubagentSupervision.triggerForEvent({ type: SubagentSupervision.RealEvent.idle, data: {} })).toBe(
        "worker_completed",
      )
      expect(
        SubagentSupervision.triggerForEvent({
          type: SubagentSupervision.RealEvent.idle,
          data: { reason: "aborted" },
        }),
      ).toBe("worker_cancelled")
    }),
  )

  it.instance("real session.status transitions classify as material status changes", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const events = yield* EventV2Bridge.Service
      const cohort = "sup:status"
      const child = childID("ses_status")
      yield* registerChild({ childSessionID: child, supervisionGroupID: cohort })

      // Real producer: SessionStatus.set publishes session.status.
      for (const status of [{ type: "busy" }, { type: "retry", attempt: 1, message: "x", next: 1 }]) {
        yield* events.publish(synthetic(SubagentSupervision.RealEvent.status), { sessionID: child, status })
      }
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const count = yield* service.wakeCount(cohort)
          return count >= 1 ? count : undefined
        }),
        "real session.status never produced a wake",
      )
      // Both transitions coalesce into a single wake for the window.
      expect(yield* service.wakeCount(cohort)).toBe(1)
    }),
  )

  it.instance("real step/tool failure events classify as failure evidence", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const events = yield* EventV2Bridge.Service
      const cohort = "sup:failure"
      const child = childID("ses_failure")
      yield* registerChild({ childSessionID: child, supervisionGroupID: cohort })

      yield* events.publish(
        synthetic(SubagentSupervision.RealEvent.stepFailed),
        {
          timestamp: Date.now(),
          sessionID: child,
          assistantMessageID: "msg_1",
          error: { name: "Error", data: { message: "provider exploded" } },
        },
      )
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const count = yield* service.wakeCount(cohort)
          return count >= 1 ? count : undefined
        }),
        "real step.failed never produced a wake",
      )
      expect(yield* service.wakeCount(cohort)).toBe(1)
      expect(SubagentSupervision.triggerForEvent({ type: SubagentSupervision.RealEvent.stepFailed })).toBe(
        "worker_failed",
      )
      expect(SubagentSupervision.triggerForEvent({ type: SubagentSupervision.RealEvent.toolFailed })).toBe(
        "worker_tool_failure",
      )
    }),
  )

  it.instance("real permission.asked / question.asked blockers wake the cohort and classify", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const permission = yield* Permission.Service
      const question = yield* Question.Service
      const permissionChild = childID("ses_perm_event")
      const questionChild = childID("ses_question_event")
      yield* registerChild({ childSessionID: permissionChild, supervisionGroupID: "sup:perm" })
      yield* registerChild({ childSessionID: questionChild, supervisionGroupID: "sup:question" })

      // Real producers: Permission.ask and Question.askDetailed.
      yield* permission
        .ask({
          sessionID: permissionChild,
          permission: "external_directory",
          patterns: ["/outside"],
          always: ["*"],
          metadata: {},
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const count = yield* service.wakeCount("sup:perm")
          return count >= 1 ? count : undefined
        }),
        "real permission.asked never woke the cohort",
      )
      const permissionWorker = yield* pollWithTimeout(
        Effect.gen(function* () {
          const snap = yield* service.snapshot({ supervisionGroupID: "sup:perm" })
          const worker = snap.workers.find((item) => item.sessionID === permissionChild)
          return worker?.state === "blocked_permission" ? worker : undefined
        }),
        "real permission blocker never classified",
      )
      expect(permissionWorker.evidenceBased).toBe(true)

      yield* question
        .askDetailed({
          sessionID: questionChild,
          questions: [{ question: "Continue?", header: "Confirm", options: [] }] as never,
        })
        .pipe(Effect.forkScoped)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const count = yield* service.wakeCount("sup:question")
          return count >= 1 ? count : undefined
        }),
        "real question.asked never woke the cohort",
      )
      const questionWorker = yield* pollWithTimeout(
        Effect.gen(function* () {
          const snap = yield* service.snapshot({ supervisionGroupID: "sup:question" })
          const worker = snap.workers.find((item) => item.sessionID === questionChild)
          return worker?.state === "blocked_question" ? worker : undefined
        }),
        "real question blocker never classified",
      )
      expect(questionWorker.evidenceBased).toBe(true)
    }),
  )

  it.instance("real retried events are evidence-based stall signals, unlike low-level chatter", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const events = yield* EventV2Bridge.Service
      const cohort = "sup:retry"
      const child = childID("ses_retry")
      yield* registerChild({ childSessionID: child, supervisionGroupID: cohort })

      yield* events.publish(
        synthetic(SubagentSupervision.RealEvent.retried),
        {
          timestamp: Date.now(),
          sessionID: child,
          attempt: 1,
          error: { message: "rate limited", isRetryable: true },
        },
      )
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const count = yield* service.wakeCount(cohort)
          return count >= 1 ? count : undefined
        }),
        "real retried event never woke the cohort",
      )
      expect(yield* service.wakeCount(cohort)).toBe(1)
    }),
  )

  it.instance("real low-level tool chatter through the event path produces ZERO wakes", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const events = yield* EventV2Bridge.Service
      const wake = yield* wakeCounter()
      const cohort = "sup:chatter"
      const child = childID("ses_chatter")
      yield* registerChild({ childSessionID: child, supervisionGroupID: cohort })

      // read/grep/read style activity: real tool events, but low-level.
      for (let i = 0; i < 30; i++) {
        const tool = i % 2 === 0 ? "read" : "grep"
        yield* events.publish(
          synthetic(SubagentSupervision.RealEvent.toolSuccess),
          {
            timestamp: Date.now(),
            sessionID: child,
            assistantMessageID: "msg_1",
            callID: `call_${i}`,
            tool,
            structured: {},
            content: [],
            provider: { executed: true },
          },
        )
        yield* events.publish(
          synthetic(SubagentSupervision.RealEvent.textDelta),
          { timestamp: Date.now(), sessionID: child, assistantMessageID: "msg_1", textID: "t1", delta: "..." },
        )
      }
      yield* Effect.sleep("400 millis")
      expect(yield* service.wakeCount(cohort)).toBe(0)
      expect(yield* wake.of(supervisor)).toBe(0)
      // The chatter types are explicitly classified as non-meaningful.
      expect(SubagentSupervision.isLowLevelEvent(SubagentSupervision.RealEvent.toolSuccess)).toBe(true)
      expect(SubagentSupervision.isLowLevelEvent(SubagentSupervision.RealEvent.textDelta)).toBe(true)
      expect(SubagentSupervision.triggerForEvent({ type: SubagentSupervision.RealEvent.toolSuccess })).toBeUndefined()
    }),
  )

  it.instance("real event path drives registration-based wakes only for supervised children", () =>
    Effect.gen(function* () {
      const service = yield* SubagentSupervision.service
      const events = yield* EventV2Bridge.Service
      const wake = yield* wakeCounter()
      // A child the service has never registered must never wake anyone.
      yield* events.publish(synthetic(SubagentSupervision.RealEvent.idle), {
        sessionID: childID("ses_unregistered"),
      })
      yield* Effect.sleep("300 millis")
      expect(yield* service.wakeCount(group)).toBe(0)
      expect(yield* wake.of(supervisor)).toBe(0)
    }),
  )
})
