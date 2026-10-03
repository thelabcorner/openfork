import { afterAll, describe, expect, test } from "bun:test"
import { Effect, ManagedRuntime, Option } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { OxpSessionControl } from "@/oxp/session-control"
import { OxpSessionControlV1 } from "@/oxp/session-control-v1"
import { Session } from "@/session/session"
import { Goal } from "@opencode-ai/core/goal"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const llmRuntime = ManagedRuntime.make(TestLLMServer.layer)
const controlRuntime = ManagedRuntime.make(OxpSessionControlV1.layer)

afterAll(async () => {
  await controlRuntime.dispose()
  await llmRuntime.dispose()
})

const isTitleRequest = (hit: { body: Record<string, unknown> }) => {
  const tools = hit.body.tools
  return Array.isArray(tools) && JSON.stringify(tools).includes("generated_title")
}

const response = (text: string) => reply().text(text).stop().item()

const isGoalAuditorRequest = (hit: { body: Record<string, unknown> }) => {
  const tools = hit.body.tools
  return Array.isArray(tools) && JSON.stringify(tools).includes("audit_verdict")
}

const inInstance = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
  InstanceStore.Service.use((instances) => instances.provide({ directory }, effect))

const assistantText = (messages: readonly SessionV1.WithParts[]) => {
  const assistant = [...messages].reverse().find((message) => message.info.role === "assistant")
  if (!assistant) return undefined
  return assistant.parts
    .filter((part): part is Extract<(typeof assistant.parts)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
}

describe("OxpSessionControlV1 supervised turn lifetime", () => {
  test("translates native host-owned delegated-worker rejection into the portable control error", async () => {
    const llm = await llmRuntime.runPromise(TestLLMServer)
    const tmp = await tmpdir({ config: testProviderConfig(llm.url) })
    try {
      const origin = {
        producer: "oxp",
        principalRef: "oxp:session-control-host-owned",
        invocationRef: "oxp-inv:session-control-host-owned",
        rootRef: "root-session-control-host-owned",
        agent: "build",
        model: {
          providerID: "test",
          modelID: "test-model",
        },
        nestedDelegation: false,
      } as const
      const session = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Session.Service.use((sessions) =>
            sessions.create({
              title: "OXP host-owned adapter projection",
              metadata: SessionMetadataOwnership.delegatedWorker(origin),
            }),
          ),
        ),
      )
      const target: OxpSessionControl.Target = {
        directory: tmp.path,
        sessionID: session.id,
      }

      const error = await controlRuntime.runPromise(
        OxpSessionControl.Service.use((control) =>
          control.send(target, {
            actorRef: "oxp:test-session-control",
            text: "must remain producer-owned",
          }),
        ).pipe(Effect.flip),
      )

      expect(error).toBeInstanceOf(OxpSessionControl.HostOwned)
      expect(error).toMatchObject({
        sessionID: session.id,
        kind: "delegated_worker",
      })
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("archive and delete reuse the native Session lifecycle", async () => {
    const tmp = await tmpdir()
    try {
      const seeded = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Session.Service.use((sessions) =>
            Effect.gen(function* () {
              const archived = yield* sessions.create({ title: "OXP lifecycle archive" })
              const parent = yield* sessions.create({ title: "OXP lifecycle delete" })
              const child = yield* sessions.create({ title: "OXP lifecycle child", parentID: parent.id })
              return { archived, parent, child }
            }),
          ),
        ),
      )

      await controlRuntime.runPromise(
        OxpSessionControl.Service.use((control) =>
          control.archive({ directory: tmp.path, sessionID: seeded.archived.id }),
        ),
      )

      const archived = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Session.Service.use((sessions) => sessions.get(seeded.archived.id)),
        ),
      )
      expect(archived.time.archived).toBeNumber()

      await controlRuntime.runPromise(
        OxpSessionControl.Service.use((control) =>
          control.unarchive({ directory: tmp.path, sessionID: seeded.archived.id }),
        ),
      )
      const unarchived = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Session.Service.use((sessions) => sessions.get(seeded.archived.id)),
        ),
      )
      expect(unarchived.time.archived).toBeUndefined()

      await controlRuntime.runPromise(
        OxpSessionControl.Service.use((control) =>
          control.delete({ directory: tmp.path, sessionID: seeded.parent.id }),
        ),
      )

      const deleted = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Session.Service.use((sessions) =>
            Effect.all(
              [
                sessions.get(seeded.parent.id).pipe(Effect.option),
                sessions.get(seeded.child.id).pipe(Effect.option),
              ],
              { concurrency: "unbounded" },
            ),
          ),
        ),
      )
      expect(Option.isNone(deleted[0])).toBe(true)
      expect(Option.isNone(deleted[1])).toBe(true)
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("send returns while its supervised turn survives the control request", async () => {
    const llm = await llmRuntime.runPromise(TestLLMServer)
    await llmRuntime.runPromise(
      llm.pushMatch((hit) => !isTitleRequest(hit), response("session control send result")),
    )

    const tmp = await tmpdir({ config: testProviderConfig(llm.url) })
    try {
      const session = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Session.Service.use((sessions) => sessions.create({ title: "OXP Session send scope" })),
        ),
      )
      const target: OxpSessionControl.Target = {
        directory: tmp.path,
        sessionID: session.id,
      }

      const admitted = await controlRuntime.runPromise(
        OxpSessionControl.Service.use((control) =>
          control.send(target, {
            actorRef: "oxp:test-session-control",
            text: "produce the send result",
          }),
        ),
      )

      expect(admitted.paused).toBe(false)
      expect(admitted.admittedMessageID.length).toBeGreaterThan(0)

      const text = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Session.Service.use((sessions) =>
            pollWithTimeout(
              Effect.gen(function* () {
                const messages = yield* sessions.messages({ sessionID: session.id })
                const text = assistantText(messages)
                return text?.includes("session control send result") ? text : undefined
              }),
              "OXP Session send fiber did not outlive the control request",
              "20 seconds",
            ),
          ),
        ),
      )

      expect(text).toContain("session control send result")
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  }, 60_000)

  test("resume drains a paused admitted turn on the layer-owned scope", async () => {
    const llm = await llmRuntime.runPromise(TestLLMServer)
    await llmRuntime.runPromise(
      llm.pushMatch((hit) => !isTitleRequest(hit), response("session control resume result")),
    )

    const tmp = await tmpdir({ config: testProviderConfig(llm.url) })
    try {
      const session = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Session.Service.use((sessions) => sessions.create({ title: "OXP Session resume scope" })),
        ),
      )
      const target: OxpSessionControl.Target = {
        directory: tmp.path,
        sessionID: session.id,
      }

      await controlRuntime.runPromise(
        OxpSessionControl.Service.use((control) => control.pause(target)),
      )

      const admitted = await controlRuntime.runPromise(
        OxpSessionControl.Service.use((control) =>
          control.send(target, {
            actorRef: "oxp:test-session-control",
            text: "produce the resume result",
          }),
        ),
      )
      expect(admitted.paused).toBe(true)

      await controlRuntime.runPromise(
        OxpSessionControl.Service.use((control) => control.resume(target)),
      )

      const text = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Session.Service.use((sessions) =>
            pollWithTimeout(
              Effect.gen(function* () {
                const messages = yield* sessions.messages({ sessionID: session.id })
                const text = assistantText(messages)
                return text?.includes("session control resume result") ? text : undefined
              }),
              "OXP Session resume fiber did not survive the control request",
              "20 seconds",
            ),
          ),
        ),
      )

      expect(text).toContain("session control resume result")
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  }, 60_000)

  test("request_verification dispatches the native independent auditor instead of stranding verifying state", async () => {
    const llm = await llmRuntime.runPromise(TestLLMServer)
    const tmp = await tmpdir({ config: testProviderConfig(llm.url) })
    try {
      const session = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Session.Service.use((sessions) => sessions.create({ title: "OXP Goal verification dispatch" })),
        ),
      )
      const target: OxpSessionControl.Target = {
        directory: tmp.path,
        sessionID: session.id,
      }

      // auditGoal requires a durable worker prompt so it can recover worker
      // model/source provenance independently of the OXP caller. Seed one
      // ordinary worker turn before creating/focusing the Goal.
      await llmRuntime.runPromise(
        llm.pushMatch((hit) => !isTitleRequest(hit) && !isGoalAuditorRequest(hit), response("seed worker turn")),
      )
      const worker = await controlRuntime.runPromise(
        OxpSessionControl.Service.use((control) =>
          control.turn(target, {
            actorRef: "oxp:test-goal-verification",
            text: "seed a worker prompt before verification",
          }),
        ),
      )
      expect(worker.resultMessageID).toBeDefined()

      const seeded = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Goal.Service.use((goals) =>
            Effect.gen(function* () {
              const created = yield* goals.create({
                projectID: session.projectID,
                title: "Verify through OXP",
                objective: "Prove OXP request_verification launches the native auditor.",
                criteria: ["The independent auditor runs"],
                auditorPolicy: {
                  model: {
                    providerID: ProviderV2.ID.make("test"),
                    id: ModelV2.ID.make("test-model"),
                  },
                },
              })
              const active = yield* goals.transition({
                id: created.goal.id,
                expectedRevision: created.goal.revision,
                action: "start",
              })
              yield* goals.focus({ goalID: active.goal.id, sessionID: session.id })
              return {
                revision: active.goal.revision,
                criterionID: active.criteria[0]!.id,
              }
            }),
          ),
        ),
      )

      await llmRuntime.runPromise(
        llm.pushMatch(
          isGoalAuditorRequest,
          reply()
            .tool("audit_verdict", {
              decision: "complete",
              rationale: "The OXP verification request reached the independent auditor.",
              progressMade: true,
              criteria: [
                {
                  criterionID: seeded.criterionID,
                  status: "passed",
                  evidence: "independent auditor executed",
                },
              ],
            })
            .item(),
        ),
      )

      const dispatched = await controlRuntime.runPromise(
        OxpSessionControl.Service.use((control) =>
          control.goal(target, {
            action: "request_verification",
            expectedRevision: seeded.revision,
          }),
        ),
      )

      // Dispatch is asynchronous and must not synthesize the legacy
      // active -> verifying transition itself.
      expect(dispatched.goal.goal.status).toBe("active")

      const settled = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Goal.Service.use((goals) =>
            pollWithTimeout(
              Effect.gen(function* () {
                const focused = yield* goals.focused(session.id)
                return focused?.detail.goal.status === "completed" ? focused.detail : undefined
              }),
              "OXP request_verification did not dispatch the independent auditor",
              // This is an eventual-dispatch correctness assertion, not a
              // latency SLO. Full-suite AppRuntime/filesystem contention can
              // exceed 20s while the same local auditor path remains healthy.
              "40 seconds",
            ),
          ),
        ),
      )

      expect(settled.goal.status).toBe("completed")
      expect(settled.goal.auditorRuns).toBe(1)
      expect(settled.criteria[0]?.status).toBe("passed")

      // Recovery compatibility: older OXP builds could strand a Goal by applying
      // the lifecycle transition without dispatching the auditor. The fixed
      // adapter must accept that already-verifying state and route it through the
      // same native requestGoalAudit owner.
      const strandedSession = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Session.Service.use((sessions) => sessions.create({ title: "OXP stranded verifying recovery" })),
        ),
      )
      const strandedTarget: OxpSessionControl.Target = {
        directory: tmp.path,
        sessionID: strandedSession.id,
      }
      await llmRuntime.runPromise(
        llm.pushMatch((hit) => !isTitleRequest(hit) && !isGoalAuditorRequest(hit), response("seed stranded worker turn")),
      )
      await controlRuntime.runPromise(
        OxpSessionControl.Service.use((control) =>
          control.turn(strandedTarget, {
            actorRef: "oxp:test-goal-verification-recovery",
            text: "seed worker prompt for stranded verification recovery",
          }),
        ),
      )

      const stranded = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Goal.Service.use((goals) =>
            Effect.gen(function* () {
              const created = yield* goals.create({
                projectID: strandedSession.projectID,
                title: "Recover stranded verification",
                objective: "Dispatch an auditor for an already-verifying Goal.",
                criteria: ["The orphaned verifying Goal is audited"],
                auditorPolicy: {
                  model: {
                    providerID: ProviderV2.ID.make("test"),
                    id: ModelV2.ID.make("test-model"),
                  },
                },
              })
              const active = yield* goals.transition({
                id: created.goal.id,
                expectedRevision: created.goal.revision,
                action: "start",
              })
              yield* goals.focus({ goalID: active.goal.id, sessionID: strandedSession.id })
              const verifying = yield* goals.transition({
                id: active.goal.id,
                expectedRevision: active.goal.revision,
                action: "request_verification",
              })
              return {
                revision: verifying.goal.revision,
                criterionID: verifying.criteria[0]!.id,
              }
            }),
          ),
        ),
      )
      await llmRuntime.runPromise(
        llm.pushMatch(
          isGoalAuditorRequest,
          reply()
            .tool("audit_verdict", {
              decision: "complete",
              rationale: "The previously stranded verifying Goal reached the independent auditor.",
              progressMade: true,
              criteria: [
                {
                  criterionID: stranded.criterionID,
                  status: "passed",
                  evidence: "orphaned verifying state recovered",
                },
              ],
            })
            .item(),
        ),
      )
      const recoveredDispatch = await controlRuntime.runPromise(
        OxpSessionControl.Service.use((control) =>
          control.goal(strandedTarget, {
            action: "request_verification",
            expectedRevision: stranded.revision,
          }),
        ),
      )
      expect(recoveredDispatch.goal.goal.status).toBe("verifying")
      const recovered = await AppRuntime.runPromise(
        inInstance(
          tmp.path,
          Goal.Service.use((goals) =>
            pollWithTimeout(
              Effect.gen(function* () {
                const focused = yield* goals.focused(strandedSession.id)
                return focused?.detail.goal.status === "completed" ? focused.detail : undefined
              }),
              "OXP request_verification did not recover the already-verifying Goal",
              "40 seconds",
            ),
          ),
        ),
      )
      expect(recovered.goal.auditorRuns).toBe(1)
      expect(recovered.criteria[0]?.status).toBe("passed")
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  }, 120_000)
})
