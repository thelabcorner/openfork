import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { OxpError } from "@/oxp/error"
import { OxpWorker } from "@/oxp/worker"
import { OxpWorkerControl } from "@/oxp/worker-control"
import { OxpWorkerControlV1 } from "@/oxp/worker-control-v1"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { DelegatedWorker } from "@/session/delegated-worker"
import { SessionGroup } from "@/session/group"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { testEffect } from "../lib/effect"

const WORKER_ID = SessionID.make("ses_delegated_worker_terminal")

const ORIGIN = {
  producer: "oxp",
  principalRef: "oxp:test-connector",
  invocationRef: "oxp-inv:test",
  rootRef: "root_test",
  agent: "build",
  model: { providerID: "test", modelID: "test-model" },
  nestedDelegation: false,
} as const

const identity = {
  producer: "oxp",
  principalRef: ORIGIN.principalRef,
} as const

const workerSession = {
  id: WORKER_ID,
  title: "Delegated worker",
  metadata: SessionMetadataOwnership.delegatedWorker(ORIGIN),
}

let pendingPermissions: PermissionV1.Request[] = []
let pendingQuestions: Question.Request[] = []
let permissionListOverride: (() => PermissionV1.Request[]) | undefined
let nestedDelegation = false
let executionOwnerID: string | undefined
const extraSessions = new Map<string, Record<string, unknown>>()
let loopOverride:
  | ((sessionID: SessionID) => Effect.Effect<SessionV1.WithParts>)
  | undefined

const layers = Layer.mergeAll(
  Layer.mock(Agent.Service, {
    list: () =>
      Effect.succeed([{ name: "build", hidden: false, permission: [] } as any]),
  }),
  Layer.mock(Provider.Service, {
    resolveAccountID: (_providerID, accountID) => Effect.succeed(accountID),
    getModel: () =>
      Effect.succeed({
        id: "test-model",
        providerID: "test",
        name: "Test Model",
        family: "test",
      } as any),
  }),
  Layer.mock(Session.Service, {
    get: (sessionID) =>
      Effect.succeed(
        (extraSessions.get(String(sessionID)) ?? {
          ...workerSession,
          metadata: SessionMetadataOwnership.delegatedWorker({
            ...ORIGIN,
            nestedDelegation,
          }),
        }) as any,
      ),
    create: () => Effect.succeed(workerSession as any),
    messages: () =>
      Effect.succeed([
        {
          info: { id: "msg_terminal", role: "user", time: { created: 1 } },
          parts: [],
        } as any,
      ]),
  }),
  Layer.mock(SessionPrompt.Service, {
    hostPrompt: () =>
      Effect.succeed({
        info: { id: "msg_terminal", role: "user", time: { created: 1 } },
        parts: [],
      } as any),
    loop: (input) =>
      loopOverride ? loopOverride(input.sessionID) : Effect.never,
    cancel: () => Effect.void,
  }),
  Layer.effect(BackgroundJob.Service, CoreBackgroundJob.make),
  Layer.mock(SessionExecutionOwner.Service, {
    snapshot: (sessionID) =>
      Effect.succeed({
        sessionID,
        generation: executionOwnerID ? 1 : 0,
        ...(executionOwnerID
          ? {
              ownerID: executionOwnerID as any,
              acquiredAt: 1,
            }
          : {}),
      }),
  }),
  Layer.mock(Permission.Service, {
    list: () =>
      Effect.sync(() =>
        permissionListOverride
          ? permissionListOverride()
          : pendingPermissions,
      ),
  }),
  Layer.mock(Question.Service, {
    list: () => Effect.succeed(pendingQuestions),
  }),
)

const it = testEffect(layers)

describe("delegated worker terminal state", () => {
  it.live("cancel stays terminal for wait and result", () =>
    Effect.gen(function* () {
      const worker = yield* DelegatedWorker.make
      const session = yield* worker.start({
        title: "Delegated worker",
        prompt: "do work",
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        origin: ORIGIN,
      })

      const running = yield* worker.snapshot(session.id, identity)
      expect(running.state).toBe("running")

      const cancelled = yield* worker.cancel({
        sessionID: session.id,
        identity,
      })
      expect(cancelled.state).toBe("cancelled")

      const waited = yield* worker.wait({
        sessionID: session.id,
        identity,
        timeout: 1_000,
      })
      expect(waited.state).toBe("cancelled")

      const result = yield* worker.result({
        sessionID: session.id,
        identity,
      })
      expect(result.state).toBe("cancelled")
    }),
  )

  it.live("surfaces native permission and question waits as blocked", () =>
    Effect.gen(function* () {
      pendingPermissions = []
      pendingQuestions = []
      const release = yield* Deferred.make<void>()
      loopOverride = (sessionID) =>
        Effect.gen(function* () {
          pendingPermissions = [
            {
              id: PermissionV1.ID.make("per_blocked_worker"),
              sessionID,
              permission: "bash",
              patterns: ["git status"],
              metadata: {},
              always: [],
            },
          ]
          pendingQuestions = [
            {
              id: QuestionID.ascending("que_blocked_worker"),
              sessionID,
              questions: [
                {
                  question: "Proceed?",
                  header: "Proceed",
                  options: [
                    {
                      label: "Yes",
                      description: "Continue the delegated work",
                    },
                  ],
                },
              ],
            },
          ]
          yield* Deferred.await(release)
          return {
            info: { id: "msg_resumed", role: "assistant" },
            parts: [{ type: "text", text: "resumed" }],
          } as any
        })
      const worker = yield* DelegatedWorker.make
      const session = yield* worker.start({
        title: "Delegated worker",
        prompt: "do work",
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        origin: ORIGIN,
      })

      const blocked = yield* worker.wait({
        sessionID: session.id,
        identity,
        timeout: 5_000,
      })
      expect(blocked.state).toBe("blocked")
      expect(blocked.blockedBy).toEqual([
        {
          type: "permission",
          id: "per_blocked_worker",
          sessionID: session.id,
          permission: "bash",
          externalDirectory: false,
        },
        {
          type: "question",
          id: "que_blocked_worker",
          sessionID: session.id,
          questionCount: 1,
        },
      ])

      pendingPermissions = []
      pendingQuestions = []
      yield* Deferred.succeed(release, undefined)
      const resumed = yield* worker.wait({
        sessionID: session.id,
        identity,
        timeout: 5_000,
      })
      expect(resumed.state).toBe("completed")
      expect(resumed.result).toBe("resumed")
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          pendingPermissions = []
          pendingQuestions = []
          permissionListOverride = undefined
          loopOverride = undefined
        }),
      ),
    ),
  )

  it.live("keeps terminal job state authoritative over stale blocker data", () =>
    Effect.gen(function* () {
      pendingPermissions = []
      pendingQuestions = []
      const worker = yield* DelegatedWorker.make
      const session = yield* worker.start({
        title: "Delegated worker",
        prompt: "do work",
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        origin: ORIGIN,
      })

      pendingPermissions = [
        {
          id: PermissionV1.ID.make("per_stale_after_cancel"),
          sessionID: session.id,
          permission: "bash",
          patterns: ["git status"],
          metadata: {},
          always: [],
        },
      ]
      const blocked = yield* worker.snapshot(session.id, identity)
      expect(blocked.state).toBe("blocked")

      const cancelled = yield* worker.cancel({
        sessionID: session.id,
        identity,
      })
      expect(cancelled.state).toBe("cancelled")
      expect(cancelled.blockedBy).toBeUndefined()
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          pendingPermissions = []
          pendingQuestions = []
          permissionListOverride = undefined
          loopOverride = undefined
        }),
      ),
    ),
  )

  it.live("reconfirms blocker presence before projecting blocked", () =>
    Effect.gen(function* () {
      pendingPermissions = []
      pendingQuestions = []
      const worker = yield* DelegatedWorker.make
      const session = yield* worker.start({
        title: "Delegated worker",
        prompt: "do work",
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        origin: ORIGIN,
      })

      const stale: PermissionV1.Request = {
        id: PermissionV1.ID.make("per_resolved_during_snapshot"),
        sessionID: session.id,
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: [],
      }
      let reads = 0
      permissionListOverride = () => {
        reads += 1
        return reads === 1 ? [stale] : []
      }

      const current = yield* worker.snapshot(session.id, identity)
      expect(reads).toBe(2)
      expect(current.state).toBe("running")
      expect(current.blockedBy).toBeUndefined()

      yield* worker.cancel({ sessionID: session.id, identity })
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          pendingPermissions = []
          pendingQuestions = []
          permissionListOverride = undefined
          loopOverride = undefined
        }),
      ),
    ),
  )

  it.live("does not leak a transient running result when a blocker resolves during wait", () =>
    Effect.gen(function* () {
      pendingPermissions = []
      pendingQuestions = []
      const worker = yield* DelegatedWorker.make
      loopOverride = () =>
        Effect.sleep(25).pipe(
          Effect.as({
            info: { id: "msg_race_complete", role: "assistant" },
            parts: [{ type: "text", text: "completed after blocker race" }],
          } as any),
        )
      const session = yield* worker.start({
        title: "Delegated worker",
        prompt: "do work",
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        origin: ORIGIN,
      })
      const stale: PermissionV1.Request = {
        id: PermissionV1.ID.make("per_wait_race"),
        sessionID: session.id,
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: [],
      }
      let reads = 0
      permissionListOverride = () => {
        reads += 1
        return reads === 1 ? [stale] : []
      }

      const waited = yield* worker.wait({
        sessionID: session.id,
        identity,
        timeout: 5_000,
      })
      expect(waited.state).toBe("completed")
      expect(waited.result).toBe("completed after blocker race")
      expect(reads).toBeGreaterThanOrEqual(2)
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          pendingPermissions = []
          pendingQuestions = []
          permissionListOverride = undefined
          nestedDelegation = false
          executionOwnerID = undefined
          extraSessions.clear()
          loopOverride = undefined
        }),
      ),
    ),
  )

  it.live("surfaces blockers owned by nested descendant Sessions with the owning sessionID", () =>
    Effect.gen(function* () {
      nestedDelegation = true
      const childID = SessionID.make("ses_nested_blocked_child")
      extraSessions.set(String(childID), {
        id: childID,
        title: "Nested child",
        parentID: WORKER_ID,
      })
      pendingQuestions = [
        {
          id: QuestionID.ascending("que_nested_blocked_child"),
          sessionID: childID,
          questions: [
            {
              question: "Continue nested work?",
              header: "Nested",
              options: [{ label: "Continue", description: "Resume child" }],
            },
          ],
        },
      ]

      const worker = yield* DelegatedWorker.make
      const current = yield* worker.snapshot(WORKER_ID, identity)
      expect(current.state).toBe("blocked")
      expect(current.blockedBy).toEqual([
        {
          type: "question",
          id: "que_nested_blocked_child",
          sessionID: childID,
          questionCount: 1,
        },
      ])
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          pendingPermissions = []
          pendingQuestions = []
          permissionListOverride = undefined
          nestedDelegation = false
          executionOwnerID = undefined
          extraSessions.clear()
          loopOverride = undefined
        }),
      ),
    ),
  )

  it.live("treats a durable owner without a live delegated job as recoverable rather than running forever", () =>
    Effect.gen(function* () {
      executionOwnerID = "runtime_stale_owner"
      const worker = yield* DelegatedWorker.make
      const current = yield* worker.snapshot(WORKER_ID, identity)
      expect(current.state).toBe("recoverable")
      expect(current.recovered).toBe(true)
      expect(current.generation).toBe(1)
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          pendingPermissions = []
          pendingQuestions = []
          permissionListOverride = undefined
          nestedDelegation = false
          executionOwnerID = undefined
          extraSessions.clear()
          loopOverride = undefined
        }),
      ),
    ),
  )
})

const runtime = { DelegatedWorker, SessionGroup, SessionID }

function expectSelectionUnavailable(
  error: Error,
): OxpWorkerControl.SelectionUnavailable {
  if (!(error instanceof OxpWorkerControl.SelectionUnavailable)) {
    throw new Error("expected OxpDelegatedWorkerSelectionUnavailable")
  }
  return error
}

describe("delegated worker authoritative activity projection", () => {
  test("distinguishes queued, provider wait, streamed output, and tool stepping", () => {
    expect(DelegatedWorker.projectActivity({ owner: false, queued: true })).toBe("queued")
    expect(DelegatedWorker.projectActivity({ owner: true, queued: false, phase: "requesting" })).toBe("awaiting_provider")
    expect(DelegatedWorker.projectActivity({ owner: true, queued: false, phase: "generating" })).toBe("streaming")
    expect(DelegatedWorker.projectActivity({ owner: true, queued: false, phase: "tool" })).toBe("stepping")
  })
})

describe("delegated worker selection taxonomy", () => {
  test("model-only mismatch is not classified as a provider-account failure", () => {
    const mapped = OxpWorkerControlV1.mapWorkerError(
      runtime,
      new DelegatedWorker.SelectionMismatch(
        "Delegated worker is bound to a different model/account selection",
      ),
    )
    expect(mapped).toBeInstanceOf(OxpWorkerControl.SelectionUnavailable)
    expect(expectSelectionUnavailable(mapped).explicitAccount).toBe(false)
    expect(OxpWorker.mapControlError(mapped)).toBeInstanceOf(
      OxpError.InvalidArgument,
    )
  })

  test("explicit-account selection failure stays account-scoped", () => {
    const mapped = OxpWorkerControlV1.mapWorkerError(
      runtime,
      new DelegatedWorker.SelectionMismatch(
        "Requested delegated-worker provider account/model is unavailable",
        true,
      ),
    )
    expect(expectSelectionUnavailable(mapped).explicitAccount).toBe(true)
    const oxp = OxpWorker.mapControlError(mapped, "acct_1")
    expect(oxp).toBeInstanceOf(OxpError.ProviderAccountUnavailable)
    expect(oxp.metadata).toMatchObject({ accountID: "acct_1" })
  })
})

describe("delegated worker committed detail", () => {
  test("partial batch failure surfaces the member cause message", () => {
    const mapped = OxpWorker.mapControlError(
      new OxpWorkerControl.BatchCommitted(
        ["w1", "w2"],
        "grp_partial",
        undefined,
        new Error("Delegated worker is owned by another live background-job type"),
        ["w1"],
        ["w2"],
      ),
    )
    expect(mapped).toBeInstanceOf(OxpError.DependencyUnavailable)
    expect(mapped.detail).toContain("another live background-job type")
    expect(mapped.metadata).toMatchObject({
      committed: true,
      workersCommitted: 2,
      workerID0: "w1",
      workerID1: "w2",
      workersResidual: 1,
      residualWorkerID0: "w1",
      workersCompensated: 1,
      compensatedWorkerID0: "w2",
      batchID: "grp_partial",
    })
  })

  test("dependency causes keep the stable dependency detail", () => {
    const mapped = OxpWorker.mapControlError(
      new OxpWorkerControl.BatchCommitted(
        ["w1"],
        undefined,
        undefined,
        new Error("Service not found: WorkspaceRoutingMiddleware"),
      ),
    )
    expect(mapped.detail).toContain("WorkspaceRoutingMiddleware")
  })
})

describe("delegated batch durable ownership", () => {
  const target: OxpWorkerControl.Target = {
    directory: "C:\\oxp-batch-test",
    commitGuard: async () => {},
  }

  const batchInput = {
    name: "Batch ownership test",
    ownerRef: "oxp-batch:test",
    identity,
    workers: [
      {
        title: "first",
        prompt: "first",
        agent: "build",
        model: ORIGIN.model,
        origin: { ...ORIGIN, invocationRef: "oxp-inv:first" },
      },
      {
        title: "second",
        prompt: "second",
        agent: "build",
        model: ORIGIN.model,
        origin: { ...ORIGIN, invocationRef: "oxp-inv:second" },
      },
    ],
  } satisfies OxpWorkerControl.BatchStartInput

  function runtimeFor(worker: {
    start: (input: any) => Effect.Effect<any, any>
    cancel: (input: any) => Effect.Effect<any, any>
  }) {
    return {
      DelegatedWorker: {
        ...DelegatedWorker,
        make: Effect.succeed(worker),
      },
      SessionGroup,
      SessionID,
    } as any
  }

  function groupService(input: {
    events: string[]
    failCreate?: boolean
    failSecondAttach?: boolean
    failAfterSecondAttachWrite?: boolean
  }) {
    const members = new Set<string>()
    const groupID = SessionGroup.ID.make("grp_oxp_batch_ownership_test")
    return SessionGroup.Service.of({
      create: () =>
        Effect.gen(function* () {
          input.events.push("group:create")
          if (input.failCreate) {
            return yield* Effect.fail(new Error("group create failed"))
          }
          return { id: groupID } as any
        }),
      addSession: ({ sessionId }: { sessionId: string }) =>
        Effect.gen(function* () {
          input.events.push("group:add:" + sessionId)
          if (sessionId === "ses_batch_second" && input.failAfterSecondAttachWrite) {
            members.add(sessionId)
            return yield* Effect.fail(new Error("attach event failed"))
          }
          if (sessionId === "ses_batch_second" && input.failSecondAttach) {
            return yield* Effect.fail(new Error("attach failed"))
          }
          members.add(sessionId)
        }),
      getWithSessions: () =>
        Effect.succeed({
          sessions: [...members].map((id) => ({ id })),
        } as any),
      remove: () =>
        Effect.sync(() => {
          input.events.push("group:remove")
        }),
    } as any)
  }

  test("creates batch ownership before starting workers and attaches each worker before starting the next", async () => {
    const events: string[] = []
    const startGroupIDs: Array<string | undefined> = []
    let starts = 0
    const worker = {
      start: (input: { groupID?: string }) =>
        Effect.sync(() => {
          startGroupIDs.push(input.groupID)
          starts++
          const id = starts === 1 ? "ses_batch_first" : "ses_batch_second"
          events.push("worker:start:" + id)
          return { id: SessionID.make(id) }
        }),
      cancel: () => Effect.die("cancel should not run"),
    }
    const result = await Effect.runPromise(
      OxpWorkerControlV1.batchStartInRuntime(
        runtimeFor(worker),
        target,
        batchInput,
      ).pipe(
        Effect.provideService(
          SessionGroup.Service,
          groupService({ events }),
        ),
        Effect.provide(layers),
      ),
    )
    expect(result.workerIDs).toEqual([
      "ses_batch_first",
      "ses_batch_second",
    ])
    expect(startGroupIDs).toEqual([
      "grp_oxp_batch_ownership_test",
      "grp_oxp_batch_ownership_test",
    ])
    expect(events).toEqual([
      "group:create",
      "worker:start:ses_batch_first",
      "group:add:ses_batch_first",
      "worker:start:ses_batch_second",
      "group:add:ses_batch_second",
    ])
  })

  test("starts zero workers when durable batch ownership cannot be created", async () => {
    const events: string[] = []
    let starts = 0
    const worker = {
      start: () =>
        Effect.sync(() => {
          starts++
          return { id: SessionID.make("ses_must_not_start") }
        }),
      cancel: () => Effect.die("cancel should not run"),
    }
    const error = await Effect.runPromise(
      OxpWorkerControlV1.batchStartInRuntime(
        runtimeFor(worker),
        target,
        batchInput,
      ).pipe(
        Effect.provideService(
          SessionGroup.Service,
          groupService({ events, failCreate: true }),
        ),
        Effect.provide(layers),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain("group create failed")
    expect(starts).toBe(0)
    expect(events).toEqual(["group:create"])
  })

  test("attaches a StartCommitted worker so the returned batch owns every uncompensated Session", async () => {
    const events: string[] = []
    let starts = 0
    const worker = {
      start: () =>
        Effect.gen(function* () {
          starts++
          if (starts === 1) {
            events.push("worker:start:ses_batch_first")
            return { id: SessionID.make("ses_batch_first") }
          }
          events.push("worker:start:ses_batch_second")
          return yield* Effect.fail(
            new DelegatedWorker.StartCommitted(
              SessionID.make("ses_batch_second"),
              new Error("execution setup failed"),
            ),
          )
        }),
      cancel: () => Effect.die("cancel should not run"),
    }
    const error = await Effect.runPromise(
      OxpWorkerControlV1.batchStartInRuntime(
        runtimeFor(worker),
        target,
        batchInput,
      ).pipe(
        Effect.provideService(
          SessionGroup.Service,
          groupService({ events }),
        ),
        Effect.provide(layers),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(OxpWorkerControl.BatchCommitted)
    const committed = error as OxpWorkerControl.BatchCommitted
    expect(committed.workerIDs).toEqual([
      "ses_batch_first",
      "ses_batch_second",
    ])
    expect(committed.residualWorkerIDs).toEqual(committed.workerIDs)
    expect(committed.compensatedWorkerIDs).toEqual([])
    expect(events).toContain("group:add:ses_batch_second")
  })

  test("compensates a provably unowned worker and reports committed, residual, and compensated sets separately", async () => {
    const events: string[] = []
    let starts = 0
    const worker = {
      start: () =>
        Effect.sync(() => {
          starts++
          const id = starts === 1 ? "ses_batch_first" : "ses_batch_second"
          events.push("worker:start:" + id)
          return { id: SessionID.make(id) }
        }),
      cancel: ({ sessionID }: { sessionID: string }) =>
        Effect.sync(() => {
          events.push("worker:cancel:" + sessionID)
          return { sessionID }
        }),
    }
    const error = await Effect.runPromise(
      OxpWorkerControlV1.batchStartInRuntime(
        runtimeFor(worker),
        target,
        batchInput,
      ).pipe(
        Effect.provideService(
          SessionGroup.Service,
          groupService({ events, failSecondAttach: true }),
        ),
        Effect.provide(layers),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(OxpWorkerControl.BatchCommitted)
    const committed = error as OxpWorkerControl.BatchCommitted
    expect(committed.workerIDs).toEqual([
      "ses_batch_first",
      "ses_batch_second",
    ])
    expect(committed.residualWorkerIDs).toEqual(["ses_batch_first"])
    expect(committed.compensatedWorkerIDs).toEqual(["ses_batch_second"])
    expect(events).toContain("worker:cancel:ses_batch_second")
  })

  test("reports an unowned worker as residual when compensating cancellation fails", async () => {
    const events: string[] = []
    let starts = 0
    const worker = {
      start: () =>
        Effect.sync(() => {
          starts++
          const id = starts === 1 ? "ses_batch_first" : "ses_batch_second"
          events.push("worker:start:" + id)
          return { id: SessionID.make(id) }
        }),
      cancel: ({ sessionID }: { sessionID: string }) =>
        Effect.gen(function* () {
          events.push("worker:cancel:" + sessionID)
          return yield* Effect.fail(new Error("cancel failed"))
        }),
    }
    const error = await Effect.runPromise(
      OxpWorkerControlV1.batchStartInRuntime(
        runtimeFor(worker),
        target,
        batchInput,
      ).pipe(
        Effect.provideService(
          SessionGroup.Service,
          groupService({ events, failSecondAttach: true }),
        ),
        Effect.provide(layers),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(OxpWorkerControl.BatchCommitted)
    const committed = error as OxpWorkerControl.BatchCommitted
    expect(committed.workerIDs).toEqual([
      "ses_batch_first",
      "ses_batch_second",
    ])
    expect(committed.residualWorkerIDs).toEqual([
      "ses_batch_first",
      "ses_batch_second",
    ])
    expect(committed.compensatedWorkerIDs).toEqual([])
    expect(committed.message).toContain("compensating worker cancellation failed")
  })

  test("reconciles attach-after-write failure as durable ownership instead of cancelling the worker", async () => {
    const events: string[] = []
    let starts = 0
    const worker = {
      start: () =>
        Effect.sync(() => {
          starts++
          const id = starts === 1 ? "ses_batch_first" : "ses_batch_second"
          return { id: SessionID.make(id) }
        }),
      cancel: ({ sessionID }: { sessionID: string }) =>
        Effect.sync(() => {
          events.push("worker:cancel:" + sessionID)
          return { sessionID }
        }),
    }
    const error = await Effect.runPromise(
      OxpWorkerControlV1.batchStartInRuntime(
        runtimeFor(worker),
        target,
        batchInput,
      ).pipe(
        Effect.provideService(
          SessionGroup.Service,
          groupService({ events, failAfterSecondAttachWrite: true }),
        ),
        Effect.provide(layers),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(OxpWorkerControl.BatchCommitted)
    const committed = error as OxpWorkerControl.BatchCommitted
    expect(committed.residualWorkerIDs).toEqual([
      "ses_batch_first",
      "ses_batch_second",
    ])
    expect(committed.compensatedWorkerIDs).toEqual([])
    expect(events.some((event) => event.startsWith("worker:cancel:"))).toBe(false)
  })
})
