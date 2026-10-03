import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmSchema } from "@opencode-ai/core/swarm/schema"
import { SwarmMemberTool, Parameters } from "../../src/tool/swarm-member"
import { ToolExposure } from "../../src/tool/exposure"
import { ExternalToolCoverage } from "../../src/exchange/tool-coverage"
import { toolMayMutateWorkspace } from "../../src/tool/registry"
import { Tool } from "../../src/tool/tool"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { Truncate } from "../../src/tool/truncate"
import { InstanceRef } from "../../src/effect/instance-ref"
import { SessionID, MessageID } from "../../src/session/schema"
import { it } from "../lib/effect"

const PROJECT = "prj_lane2"
const OTHER_PROJECT = "prj_other"
const SESSION = SessionID.make("ses_worker_1")

const calls: Array<{ op: string; args: any }> = []

const swarmInfo = (id: string, name: string, projectID = PROJECT) => ({
  id,
  projectID,
  directory: "C:/repo",
  name,
  status: "active",
  policy: {},
  revision: 3,
  time: { created: Date.now(), updated: Date.now() },
})

const member = (id: string, name: string, swarmID: string, lifecycle = "active") => ({
  id,
  swarmID,
  kind: "managed_worker",
  name,
  role: "researcher",
  lifecycle,
  sessionID: SESSION,
  bindingGeneration: 1,
  workspacePolicy: "shared-read",
  time: { created: Date.now(), updated: Date.now() },
})

const authority = (swarmID: string, memberID: string) => ({
  swarmID,
  member: member(memberID, "alpha", swarmID),
  task: { id: "tsk_1", swarmID, title: "Verify the thing", status: "working" },
  run: { id: "trun_1", taskID: "tsk_1", status: "running" },
  lease: { taskID: "tsk_1", generation: 7, state: "active" },
  token: {
    swarmID,
    taskID: "tsk_1",
    generation: 7,
    memberID,
    sessionID: SESSION,
    bindingGeneration: 1,
    processOwner: "proc_1",
  },
})

/**
 * `Layer.mock` keeps the stub honest: a Core call the facade is not supposed to
 * make surfaces as an UnimplementedError defect instead of silently returning
 * undefined and letting a wrong assertion pass.
 */
const swarmLayer = (input: {
  readonly bound?: ReadonlyArray<any>
  readonly infos?: Record<string, any>
  readonly details?: Record<string, any>
  readonly authority?: any
  readonly inbox?: ReadonlyArray<any>
  readonly page?: any
}) =>
  Layer.mock(SwarmV2.Service, {
    membersForSession: (sessionID: any) =>
      Effect.sync(() => {
        calls.push({ op: "membersForSession", args: { sessionID } })
        return input.bound ?? []
      }),
    info: (id: any) =>
      Effect.sync(() => {
        calls.push({ op: "info", args: { id } })
        return input.infos?.[id] ?? swarmInfo(id, "swarm")
      }),
    get: (id: any) =>
      Effect.sync(() => {
        calls.push({ op: "get", args: { id } })
        return input.details?.[id] ?? { swarm: swarmInfo(id, "swarm"), members: [], tasks: [] }
      }),
    sessionTaskAuthority: (request: any) => {
      calls.push({ op: "sessionTaskAuthority", args: request })
      if (input.authority) return Effect.succeed(input.authority)
      return Effect.fail(
        new SwarmSchema.ConflictError({
          code: "swarm.session_task_authority_missing",
          reason: `Session ${request.sessionID} does not own one active running task in Swarm ${request.swarmID}.`,
        }),
      )
    },
    settleTask: (request: any) =>
      Effect.sync(() => {
        calls.push({ op: "settleTask", args: request })
        return {
          task: { id: "tsk_1", title: "Verify the thing", status: request.settlement.type === "completed" ? "completed" : "failed" },
          run: { id: "trun_1", status: "completed" },
        } as any
      }),
    summary: (id: any) =>
      Effect.sync(() => {
        calls.push({ op: "summary", args: { id } })
        return {
          swarm: swarmInfo(id, "swarm"),
          memberCount: 2,
          boundMemberCount: 2,
          readyTaskCount: 0,
          workingTaskCount: 1,
          pendingDeliveryCount: 0,
        } as any
      }),
    memberInbox: (request: any) =>
      Effect.sync(() => {
        calls.push({ op: "memberInbox", args: request })
        return (input.inbox ?? []) as any
      }),
    enqueueMessage: (request: any) =>
      Effect.sync(() => {
        calls.push({ op: "enqueueMessage", args: request })
        return {
          message: {
            id: "msg_1",
            swarmID: request.swarmID,
            senderMemberID: request.senderMemberID,
            body: request.body,
            kind: request.kind,
            priority: "normal",
            replyExpected: true,
            createdAt: Date.now(),
          },
          deliveries: [{ id: "dlv_1", recipientMemberID: "mbr_peer" }],
        } as any
      }),
    putBlackboard: (request: any) =>
      Effect.sync(() => {
        calls.push({ op: "putBlackboard", args: request })
        return { id: "bb_1", swarmID: request.swarmID, key: request.key, value: request.value, version: 1, authorMemberID: request.authorMemberID } as any
      }),
    blackboard: (request: any) =>
      Effect.sync(() => {
        calls.push({ op: "blackboard", args: request })
        return []
      }),
    blackboardPage: (request: any) =>
      Effect.sync(() => {
        calls.push({ op: "blackboardPage", args: request })
        return (input.page ?? { items: [], more: false }) as any
      }),
    publishDeliverable: (request: any) =>
      Effect.sync(() => {
        calls.push({ op: "publishDeliverable", args: request })
        return { id: "dlv_pub", swarmID: request.swarmID, memberID: request.memberID, summary: request.summary, refs: request.refs, files: request.files } as any
      }),
  })

const truncate = Layer.succeed(
  Truncate.Service,
  Truncate.Service.of({
    cleanup: () => Effect.void,
    write: () => Effect.succeed("unused"),
    writer: () =>
      Effect.succeed({
        outputPath: "unused.br",
        write: () => Effect.void,
        close: Effect.void,
        healthy: () => true,
      }),
    output: (text) => Effect.succeed({ content: text, truncated: false as const }),
    limits: () => Effect.succeed({ maxLines: 2_000, maxBytes: 50 * 1024 }),
  }),
)

const instance = Effect.provideService(InstanceRef, {
  directory: "C:/repo",
  worktree: "C:/repo",
  project: { id: PROJECT },
} as any)

function ctx(sessionID: SessionID = SESSION): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make("msg_assistant"),
    agent: "worker",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function run(input: any, layer: ReturnType<typeof swarmLayer>, sessionID = SESSION) {
  return Effect.gen(function* () {
    const tool = yield* (yield* SwarmMemberTool).init()
    return yield* tool.execute(input, ctx(sessionID))
  }).pipe(instance, Effect.provide(Layer.mergeAll(layer, truncate)))
}

/**
 * The facade surfaces refusals as defects so a worker cannot mistake a
 * bookkeeping failure for a successful settlement. Assert on the rendered
 * defect text rather than a typed failure channel.
 */
function refusal(effect: Effect.Effect<unknown, unknown, never>) {
  return Effect.gen(function* () {
    const exit = yield* effect.pipe(Effect.exit)
    if (Exit.isSuccess(exit)) return yield* Effect.fail(new Error("expected the call to be refused"))
    return Cause.prettyErrors(exit.cause)
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .join("\n")
  })
}

const ACTIVE_ONE = () =>
  swarmLayer({
    bound: [member("mbr_alpha", "alpha", "swr_1")],
    infos: { swr_1: swarmInfo("swr_1", "verify-swarm") },
    authority: authority("swr_1", "mbr_alpha"),
  })

describe("tool.swarm_member", () => {
  it.effect("settles a task from caller Session identity with no opaque ids", () =>
    Effect.gen(function* () {
      calls.length = 0
      const out = yield* run({ action: "done", summary: "verified" }, ACTIVE_ONE())
      const settle = calls.find((call) => call.op === "settleTask")
      expect(settle?.args.settlement).toEqual({ type: "completed", summary: "verified" })
      expect(settle?.args.runID).toBe("trun_1")
      expect(settle?.args.token.memberID).toBe("mbr_alpha")
      expect(settle?.args.token.generation).toBe(7)
      expect(out.metadata).toMatchObject({ action: "done", permission: "swarm.task", taskId: "tsk_1" })
    }),
  )

  it.effect("omits the successful result key when the worker supplies no summary", () =>
    Effect.gen(function* () {
      calls.length = 0
      yield* run({ action: "done" }, ACTIVE_ONE())
      const settle = calls.find((call) => call.op === "settleTask")
      expect(settle?.args.settlement).toEqual({ type: "completed" })
    }),
  )

  it.effect("never exposes opaque swarm/member/task identity to the model", () =>
    Effect.sync(() => {
      // Assert against the provider-visible JSON manifest, not the internal
      // schema object: this is exactly what the model can supply.
      const manifest = ToolJsonSchema.fromSchema(Parameters as never) as Record<string, any>
      const fields = Object.keys(manifest.properties ?? {})
      expect(fields).not.toContain("swarmId")
      expect(fields).not.toContain("memberId")
      expect(fields).not.toContain("taskId")
      expect(fields).not.toContain("runId")
      expect(fields).not.toContain("leaseToken")
      expect(fields).not.toContain("bindingGeneration")
      expect(fields).toContain("action")
    }),
  )

  it.effect("is always visible while the coordinator surface stays lazy", () =>
    Effect.sync(() => {
      expect(ToolExposure.loadPolicy("swarm_member")).toBe("default")
      expect(ToolExposure.lazyExposure("swarm_member")).toBeUndefined()
      expect(ToolExposure.loadPolicy("swarm")).toBe("lazy")
      expect(() => ExternalToolCoverage.assertNativeCovered(["swarm_member"])).not.toThrow()
      // Domain-only collaboration never takes a workspace snapshot.
      expect(toolMayMutateWorkspace("swarm_member", { action: "shared.put" })).toBe(false)
    }),
  )

  it.effect("fails closed when the caller has no running task authority", () =>
    Effect.gen(function* () {
      calls.length = 0
      const layer = swarmLayer({
        bound: [member("mbr_alpha", "alpha", "swr_1")],
        infos: { swr_1: swarmInfo("swr_1", "verify-swarm") },
      })
      const message = yield* refusal(run({ action: "done" }, layer))
      expect(message).toContain("active running task")
      expect(message).toContain("swarm_member status")
      expect(calls.some((call) => call.op === "settleTask")).toBe(false)
    }),
  )

  it.effect("requires a typed failureKind for fail", () =>
    Effect.gen(function* () {
      calls.length = 0
      const message = yield* refusal(run({ action: "fail" }, ACTIVE_ONE()))
      expect(message).toContain("failureKind is required")
      expect(calls.some((call) => call.op === "settleTask")).toBe(false)
    }),
  )

  it.effect("status diagnoses an admitted assignment instead of failing", () =>
    Effect.gen(function* () {
      const layer = swarmLayer({
        bound: [member("mbr_alpha", "alpha", "swr_1")],
        infos: { swr_1: swarmInfo("swr_1", "verify-swarm") },
      })
      const out = yield* run({ action: "status" }, layer)
      expect(out.output).toContain('"task": null')
      expect(out.output).toContain("admitted")
    }),
  )

  it.effect("refuses a non-member Session instead of trusting model identity", () =>
    Effect.gen(function* () {
      calls.length = 0
      const message = yield* refusal(run({ action: "done" }, swarmLayer({ bound: [] })))
      expect(message).toContain("not a Swarm member")
      expect(calls.some((call) => call.op === "settleTask")).toBe(false)
    }),
  )

  it.effect("never resolves a cross-project binding", () =>
    Effect.gen(function* () {
      calls.length = 0
      const layer = swarmLayer({
        bound: [member("mbr_alpha", "alpha", "swr_foreign")],
        infos: { swr_foreign: swarmInfo("swr_foreign", "foreign", OTHER_PROJECT) },
        authority: authority("swr_foreign", "mbr_alpha"),
      })
      const message = yield* refusal(run({ action: "done" }, layer))
      expect(message).toContain("not a Swarm member in the current project")
      expect(calls.some((call) => call.op === "settleTask")).toBe(false)
    }),
  )

  it.effect("requires a roster name when one Session is in several Swarms", () =>
    Effect.gen(function* () {
      const layer = swarmLayer({
        bound: [member("mbr_a", "alpha", "swr_1"), member("mbr_b", "beta", "swr_2")],
        infos: { swr_1: swarmInfo("swr_1", "alpha-swarm"), swr_2: swarmInfo("swr_2", "beta-swarm") },
        authority: authority("swr_2", "mbr_b"),
      })

      calls.length = 0
      const ambiguous = yield* refusal(run({ action: "done" }, layer))
      expect(ambiguous).toContain("multiple Swarms")
      expect(ambiguous).toContain("alpha-swarm")
      expect(calls.some((call) => call.op === "settleTask")).toBe(false)

      calls.length = 0
      const settled = yield* run({ action: "done", swarmName: "beta-swarm" }, layer)
      expect(calls.find((call) => call.op === "settleTask")?.args.token.memberID).toBe("mbr_b")
      expect(settled.metadata).toMatchObject({ memberId: "mbr_b" })
    }),
  )

  it.effect("refuses to mutate Swarm state for a stopped member but still allows status", () =>
    Effect.gen(function* () {
      calls.length = 0
      const layer = swarmLayer({
        bound: [member("mbr_alpha", "alpha", "swr_1", "stopped")],
        infos: { swr_1: swarmInfo("swr_1", "verify-swarm") },
        authority: authority("swr_1", "mbr_alpha"),
      })
      const message = yield* refusal(run({ action: "shared.put", key: "k", value: { a: 1 } }, layer))
      expect(message).toContain("stopped")
      expect(calls.some((call) => call.op === "putBlackboard")).toBe(false)

      // Reads stay open so a stopped member can diagnose itself; only the
      // mutating intents are lifecycle-gated.
      const inbox = yield* run({ action: "inbox" }, layer)
      expect(inbox.metadata).toMatchObject({ action: "inbox", count: 0 })
      const shared = yield* run({ action: "shared.get", key: "k" }, layer)
      expect(shared.metadata).toMatchObject({ action: "shared.get", count: 0 })
      expect(calls.some((call) => call.op === "putBlackboard")).toBe(false)

      const status = yield* run({ action: "status" }, layer)
      expect(status.output).toContain('"lifecycle": "stopped"')
    }),
  )

  it.effect("bounds a keyless shared.get read and states its truncation", () =>
    Effect.gen(function* () {
      calls.length = 0
      const layer = swarmLayer({
        bound: [member("mbr_alpha", "alpha", "swr_1")],
        infos: { swr_1: swarmInfo("swr_1", "verify-swarm") },
        page: {
          items: [
            {
              swarmID: "swr_1",
              key: "findings",
              value: { count: 1 },
              contentType: "application/json",
              version: 2,
              authorMemberID: "mbr_alpha",
            },
          ],
          more: true,
          nextKey: "findings",
        },
      })

      const paged = yield* run({ action: "shared.get" }, layer)
      expect(calls.find((call) => call.op === "blackboardPage")?.args).toMatchObject({
        swarmID: "swr_1",
        limit: 50,
      })
      // A keyless read must never degrade into a whole-board read.
      expect(calls.some((call) => call.op === "blackboard")).toBe(false)
      expect(paged.metadata).toMatchObject({ count: 1 })
      expect(paged.output).toContain('"truncated": true')
      expect(paged.output).toContain("findings")

      calls.length = 0
      const exact = yield* run({ action: "shared.get", key: "findings" }, layer)
      expect(calls.find((call) => call.op === "blackboard")?.args).toMatchObject({
        swarmID: "swr_1",
        key: "findings",
      })
      expect(calls.some((call) => call.op === "blackboardPage")).toBe(false)
      expect(exact.output).not.toContain('"truncated"')
    }),
  )

  it.effect("derives sender/author identity from the caller Session", () =>
    Effect.gen(function* () {
      calls.length = 0
      const layer = swarmLayer({
        bound: [member("mbr_alpha", "alpha", "swr_1")],
        infos: { swr_1: swarmInfo("swr_1", "verify-swarm") },
        details: {
          swr_1: {
            swarm: swarmInfo("swr_1", "verify-swarm"),
            members: [member("mbr_alpha", "alpha", "swr_1"), member("mbr_peer", "beta", "swr_1")],
            tasks: [],
          },
        },
      })
      yield* run({ action: "send", to: "beta", body: "finding: reproducible" }, layer)
      expect(calls.find((call) => call.op === "enqueueMessage")?.args.senderMemberID).toBe("mbr_alpha")
      expect(calls.find((call) => call.op === "enqueueMessage")?.args.target).toEqual({
        type: "member",
        memberID: "mbr_peer",
      })

      yield* run({ action: "shared.put", key: "notes", value: { ok: true } }, layer)
      expect(calls.find((call) => call.op === "putBlackboard")?.args.authorMemberID).toBe("mbr_alpha")
    }),
  )

  it.effect("rejects an unknown peer name rather than guessing a recipient", () =>
    Effect.gen(function* () {
      calls.length = 0
      const layer = swarmLayer({
        bound: [member("mbr_alpha", "alpha", "swr_1")],
        infos: { swr_1: swarmInfo("swr_1", "verify-swarm") },
        details: { swr_1: { swarm: swarmInfo("swr_1", "verify-swarm"), members: [member("mbr_alpha", "alpha", "swr_1")], tasks: [] } },
      })
      const message = yield* refusal(run({ action: "send", to: "nobody", body: "hi" }, layer))
      expect(message).toContain("existing member name")
      expect(calls.some((call) => call.op === "enqueueMessage")).toBe(false)
    }),
  )

  it.effect("reads the member inbox through the delivery-scoped projection", () =>
    Effect.gen(function* () {
      calls.length = 0
      const layer = swarmLayer({
        bound: [member("mbr_alpha", "alpha", "swr_1")],
        infos: { swr_1: swarmInfo("swr_1", "verify-swarm") },
        inbox: [
          {
            message: {
              id: "msg_1",
              swarmID: "swr_1",
              senderMemberID: "mbr_peer",
              senderSessionID: "ses_peer",
              senderBindingGeneration: 1,
              kind: "finding",
              body: "look at this",
              priority: "normal",
              replyExpected: true,
              createdAt: Date.now(),
            },
            delivery: {
              id: "dlv_1",
              messageID: "msg_1",
              recipientMemberID: "mbr_alpha",
              state: "pending",
              sessionInputID: "msg_input",
              claimGeneration: 0,
              attemptCount: 1,
            },
          },
        ],
      })
      const out = yield* run({ action: "inbox", limit: 5 }, layer)
      expect(calls.find((call) => call.op === "memberInbox")?.args).toMatchObject({
        swarmID: "swr_1",
        memberID: "mbr_alpha",
        limit: 5,
      })
      expect(out.metadata).toMatchObject({ count: 1 })
      expect(out.output).toContain("attempts=1")
    }),
  )
})
