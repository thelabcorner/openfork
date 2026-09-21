import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import {
  SessionGroupMemberTable,
  SessionGroupTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { OxpConfig } from "@/oxp/config"
import { OxpAgentCatalog } from "@/oxp/agent-catalog"
import { OxpRoot } from "@/oxp/root"
import { OxpWorker } from "@/oxp/worker"
import { OxpWorkerControl } from "@/oxp/worker-control"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-worker-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")

const MODEL = {
  providerID: "workbuddy",
  modelID: "deepseek-v4.1-flash",
  accountID: "wb-explicit",
  variant: "max",
} as const

const MODEL_2 = {
  providerID: "workbuddy",
  modelID: "deepseek-r2",
  accountID: "wb-explicit",
  variant: "thinking",
} as const

type Call = {
  readonly action: string
  readonly target: OxpWorkerControl.Target
  readonly input?: unknown
}

const calls: Call[] = []
let beforeGuard: (() => Promise<void>) | undefined
let afterCommit: (() => void) | undefined
let batchStartError: Error | undefined

const guard = (target: OxpWorkerControl.Target) =>
  Effect.tryPromise({
    try: async () => {
      await beforeGuard?.()
      await target.commitGuard?.()
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("test commit guard failed"),
  })

const snapshot = (
  workerID: string,
  state: OxpWorkerControl.State = "completed",
): OxpWorkerControl.Snapshot => ({
  workerID,
  state,
  recovered: false,
})

const controlLayer = Layer.succeed(
  OxpWorkerControl.Service,
  OxpWorkerControl.Service.of({
    resolveSelection: (_target, input) =>
      Effect.succeed({
        agent: input.agent ?? "build",
        model: input.model ?? MODEL,
      }),
    start: (target, input) =>
      Effect.gen(function* () {
        yield* guard(target)
        calls.push({ action: "start", target, input })
        afterCommit?.()
        return { workerID: "ses_oxp_worker_started" }
      }),
    continue: (target, input) =>
      Effect.gen(function* () {
        yield* guard(target)
        calls.push({ action: "continue", target, input })
        afterCommit?.()
        return snapshot(input.workerID, "running")
      }),
    wait: (target, input) =>
      Effect.sync(() => {
        calls.push({ action: "wait", target, input })
        return snapshot(input.workerID)
      }),
    result: (target, input) =>
      Effect.sync(() => {
        calls.push({ action: "result", target, input })
        return snapshot(input.workerID)
      }),
    cancel: (target, input) =>
      Effect.gen(function* () {
        yield* guard(target)
        calls.push({ action: "cancel", target, input })
        afterCommit?.()
        return snapshot(input.workerID, "cancelled")
      }),
    batchStart: (target, input) =>
      Effect.gen(function* () {
        yield* guard(target)
        calls.push({ action: "batch_start", target, input })
        if (batchStartError) return yield* Effect.fail(batchStartError)
        afterCommit?.()
        return {
          batchID: "grp_oxp_worker_batch",
          workerIDs: input.workers.map(
            (_, index) => `ses_oxp_batch_${index + 1}`,
          ),
        }
      }),
    batchContinue: (target, input) =>
      Effect.gen(function* () {
        yield* guard(target)
        calls.push({ action: "batch_continue", target, input })
        afterCommit?.()
        return input.items.map((item) => snapshot(item.workerID, "running"))
      }),
    batchWait: (target, input) =>
      Effect.sync(() => {
        calls.push({ action: "batch_wait", target, input })
        return input.workerIDs.map((workerID) => snapshot(workerID))
      }),
    batchCancel: (target, input) =>
      Effect.gen(function* () {
        yield* guard(target)
        calls.push({ action: "batch_cancel", target, input })
        afterCommit?.()
        return input.workerIDs.map((workerID) =>
          snapshot(workerID, "cancelled"),
        )
      }),
  }),
)

const agentCatalogLayer = Layer.succeed(
  OxpAgentCatalog.Service,
  OxpAgentCatalog.Service.of({
    list: (_target) =>
      Effect.succeed({
        agents: [
          { id: "build", mode: "primary" as const },
          { id: "review", mode: "all" as const },
        ],
        nativeDefaultAgent: "build",
      }),
  }),
)

const layer = AppNodeBuilder.build(
  LayerNode.group([
    OxpWorker.node,
    OxpRoot.node,
    OxpConfig.node,
    Database.node,
  ]),
  [
    [Global.node, Global.layerWith({ config: configDir, state: stateDir })],
    [OxpWorkerControl.node, controlLayer],
    [OxpAgentCatalog.node, agentCatalogLayer],
  ],
)
const it = testEffect(layer)

beforeEach(async () => {
  calls.length = 0
  beforeGuard = undefined
  afterCommit = undefined
  batchStartError = undefined
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})

afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

const prepare = Effect.fnUntraced(function* (nestedDelegation = false) {
  const config = yield* OxpConfig.Service
  const roots = yield* OxpRoot.Service
  const directory = path.join(suite, "workspace")
  yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
  const root = yield* roots.approve(directory)
  yield* config.setEnabled(true)
  yield* config.setGrant({
    delegation: "spawn",
    nestedDelegation,
  })
  return { config, roots, root, directory }
})

const seedWorker = Effect.fnUntraced(function* (input: {
  readonly directory: string
  readonly rootID: string
  readonly principalRef: string
  readonly id?: string
}) {
  const { db } = yield* Database.Service
  const id = SessionSchema.ID.make(input.id ?? "ses_oxp_durable_worker")
  const now = Date.now()
  yield* db
    .insert(ProjectTable)
    .values({
      id: Project.ID.global,
      worktree: AbsolutePath.make(input.directory),
      sandboxes: [],
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id,
      project_id: Project.ID.global,
      slug: String(id),
      directory: input.directory,
      title: "Durable OXP Worker",
      version: "test",
      agent: "build",
      model: {
        providerID: MODEL.providerID,
        id: MODEL.modelID,
        accountID: MODEL.accountID,
        variant: MODEL.variant,
      },
      metadata: SessionMetadataOwnership.delegatedWorker({
        producer: "oxp",
        principalRef: input.principalRef,
        invocationRef: "oxp-inv:test",
        rootRef: input.rootID,
        agent: "build",
        model: MODEL,
        nestedDelegation: false,
      }),
      time_created: now,
      time_updated: now,
    })
    .run()
    .pipe(Effect.orDie)
  return id
})

const seedBatch = Effect.fnUntraced(function* (input: {
  readonly directory: string
  readonly rootID: string
  readonly principalRef: string
}) {
  const { db } = yield* Database.Service
  const first = yield* seedWorker({
    ...input,
    id: "ses_oxp_batch_member_a",
  })
  const second = yield* seedWorker({
    ...input,
    id: "ses_oxp_batch_member_b",
  })
  const batchID = "grp_oxp_durable_batch"
  const ownerRef =
    "oxp-batch:" +
    input.principalRef +
    ":" +
    input.rootID +
    ":test-invocation"
  const now = Date.now()
  yield* db
    .insert(SessionGroupTable)
    .values({
      id: batchID,
      name: "Durable OXP Batch",
      position: 0,
      kind: "delegation",
      owner_ref: ownerRef,
      policy: {
        autoAddDescendants: false,
        lockAdded: true,
        autoDeleteWhenEmpty: true,
      },
      time_created: now,
      time_updated: now,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionGroupMemberTable)
    .values([
      {
        group_id: batchID,
        session_id: first,
        locked: true,
        origin: "delegation",
        origin_ref: ownerRef,
        position: 0,
        time_added: now,
      },
      {
        group_id: batchID,
        session_id: second,
        locked: true,
        origin: "delegation",
        origin_ref: ownerRef,
        position: 1,
        time_added: now + 1,
      },
    ])
    .run()
    .pipe(Effect.orDie)
  return { batchID, workerIDs: [first, second] as const }
})

describe("OxpWorker", () => {
  it.live(
    "starts with exact provider/account/agent policy and preserves external invocation lineage",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const workers = yield* OxpWorker.Service

      const result = yield* workers.execute({
        action: "start",
        rootID: root.id,
        prompt: "Do the delegated work",
        model: MODEL,
        agent: "build",
      })

      expect(result.structured).toMatchObject({
        workerID: "ses_oxp_worker_started",
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        action: "start",
        input: {
          model: MODEL,
          agent: "build",
          origin: {
            rootRef: root.id,
            model: MODEL,
            agent: "build",
            nestedDelegation: false,
          },
        },
      })
      expect(
        (calls[0]?.input as OxpWorkerControl.StartInput).origin.invocationRef,
      ).toMatch(/^oxp-inv:/)
    }),
  )

  it.live(
    "uses native live defaults when omitted and preserves explicit model/agent preferences",
    Effect.gen(function* () {
      const { roots, root } = yield* prepare()
      const workers = yield* OxpWorker.Service

      yield* workers.execute({
        action: "start",
        rootID: root.id,
        prompt: "Use native defaults",
      })
      expect(calls.at(-1)).toMatchObject({
        action: "start",
        input: {
          model: MODEL,
          agent: "build",
          origin: { model: MODEL, agent: "build" },
        },
      })

      yield* workers.execute({
        action: "start",
        rootID: root.id,
        prompt: "Honor explicit preferences",
        model: MODEL_2,
        agent: "review",
      })
      expect(calls.at(-1)).toMatchObject({
        action: "start",
        input: {
          model: MODEL_2,
          agent: "review",
          origin: { model: MODEL_2, agent: "review" },
        },
      })

      const secondDir = path.join(suite, "workspace-two")
      yield* Effect.promise(() => fs.mkdir(secondDir, { recursive: true }))
      const second = yield* roots.approve(secondDir)
      yield* workers.execute({
        action: "start",
        rootID: second.id,
        prompt: "No selection preauthorization required on a new root",
        model: MODEL_2,
        agent: "review",
      })
      expect(calls.at(-1)).toMatchObject({
        action: "start",
        input: { model: MODEL_2, agent: "review" },
      })
    }),
  )

  it.live(
    "resolves each batch worker independently from native defaults plus explicit overrides",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const workers = yield* OxpWorker.Service

      yield* workers.execute({
        action: "batch_start",
        rootID: root.id,
        workers: [
          { prompt: "use native defaults" },
          { prompt: "use explicit selection", model: MODEL_2, agent: "review" },
        ],
      })
      expect(calls.at(-1)).toMatchObject({
        action: "batch_start",
        input: {
          workers: [
            { model: MODEL, agent: "build", origin: { model: MODEL, agent: "build" } },
            { model: MODEL_2, agent: "review", origin: { model: MODEL_2, agent: "review" } },
          ],
        },
      })
    }),
  )

  it.live(
    "admits 1/3/6 concurrent worker starts through independent commit guards",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const workers = yield* OxpWorker.Service

      for (const count of [1, 3, 6] as const) {
        calls.length = 0
        const results = yield* Effect.all(
          Array.from({ length: count }, (_, index) =>
            workers.execute({
              action: "start",
              rootID: root.id,
              prompt: `Concurrent worker ${index + 1}`,
            }),
          ),
          { concurrency: "unbounded" },
        )
        expect(results).toHaveLength(count)
        expect(calls).toHaveLength(count)
        expect(
          calls.every(
            (call) =>
              call.action === "start" &&
              (call.input as OxpWorkerControl.StartInput).model.providerID === MODEL.providerID &&
              (call.input as OxpWorkerControl.StartInput).model.modelID === MODEL.modelID,
          ),
        ).toBe(true)
      }
    }),
  )

  it.live(
    "requires nestedDelegation independently from ordinary spawn authority",
    Effect.gen(function* () {
      const { root } = yield* prepare(false)
      const workers = yield* OxpWorker.Service

      const denied = yield* workers
        .execute({
          action: "start",
          rootID: root.id,
          prompt: "Nested-capable worker",
          nestedDelegation: true,
        })
        .pipe(Effect.flip)

      expect(denied._tag).toBe("OXP_AUTH_DENIED")
      expect(calls).toEqual([])

      const allowed = yield* workers.execute({
        action: "start",
        rootID: root.id,
        prompt: "Ordinary worker",
      })
      expect(allowed.structured).toMatchObject({
        workerID: "ses_oxp_worker_started",
      })
    }),
  )

  it.live(
    "fails closed when delegation grant is revoked at the final commit barrier",
    Effect.gen(function* () {
      const { config, root } = yield* prepare()
      const workers = yield* OxpWorker.Service
      beforeGuard = () =>
        Effect.runPromise(
          config
            .setGrant({ delegation: "disabled" })
            .pipe(Effect.asVoid),
        )

      const error = yield* workers
        .execute({
          action: "start",
          rootID: root.id,
          prompt: "Must not commit",
        })
        .pipe(Effect.flip)

      expect(error._tag).toBe("OXP_AUTH_REVOKED")
      expect(calls).toEqual([])
    }),
  )

  it.live(
    "fails closed when approved-root authority is removed at the final commit barrier",
    Effect.gen(function* () {
      const { roots, root } = yield* prepare()
      const workers = yield* OxpWorker.Service
      beforeGuard = () => Effect.runPromise(roots.remove(root.id))

      const error = yield* workers
        .execute({
          action: "start",
          rootID: root.id,
          prompt: "Must not commit after root removal",
        })
        .pipe(Effect.flip)

      expect(error._tag).toBe("OXP_AUTH_REVOKED")
      expect(calls).toEqual([])
    }),
  )


  it.live(
    "preserves the committed worker SessionID when caller cancellation arrives after start commit",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const workers = yield* OxpWorker.Service
      const controller = new AbortController()
      afterCommit = () => controller.abort()

      const error = yield* workers
        .execute(
          {
            action: "start",
            rootID: root.id,
            prompt: "Commit then cancel transport wait",
          },
          controller.signal,
        )
        .pipe(Effect.flip)

      expect(error._tag).toBe("OXP_CANCELLED")
      expect(error.metadata).toMatchObject({
        workerID: "ses_oxp_worker_started",
        committed: true,
      })
      expect(calls).toHaveLength(1)
    }),
  )

  it.live(
    "surfaces every committed worker handle and group handle from a partial batch-start failure",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const workers = yield* OxpWorker.Service
      batchStartError = new OxpWorkerControl.BatchCommitted(
        ["ses_committed_a", "ses_committed_b"],
        "grp_committed",
      )

      const error = yield* workers
        .execute({
          action: "batch_start",
          rootID: root.id,
          workers: [{ prompt: "first" }, { prompt: "second" }],
        })
        .pipe(Effect.flip)

      expect(error._tag).toBe("OXP_DEPENDENCY_UNAVAILABLE")
      expect(error.metadata).toMatchObject({
        committed: true,
        workersCommitted: 2,
        workerID0: "ses_committed_a",
        workerID1: "ses_committed_b",
        batchID: "grp_committed",
      })
    }),
  )

  it.live(
    "lists and gets durable delegated workers without entering the Tier-3 control port",
    Effect.gen(function* () {
      const { config, root, directory } = yield* prepare()
      const workers = yield* OxpWorker.Service
      const connector = (yield* config.get()).connector.id
      const workerID = yield* seedWorker({
        directory,
        rootID: root.id,
        principalRef: "oxp:" + connector,
      })

      const listed = yield* workers.execute({ action: "list" })
      const listData = listed.structured as {
        workers: Array<{ workerID: string; location: unknown }>
      }
      expect(listData.workers.map((item) => item.workerID)).toEqual([
        workerID,
      ])
      expect(listData.workers[0]?.location).toEqual({
        rootID: root.id,
        path: "/" + root.alias,
      })

      const got = yield* workers.execute({
        action: "get",
        workerID,
      })
      expect(got.structured).toMatchObject({
        workerID,
        model: MODEL,
        agent: "build",
      })
      expect(JSON.stringify(listed)).not.toContain(directory)
      expect(JSON.stringify(got)).not.toContain(directory)
      expect(calls).toEqual([])
    }),
  )

  it.live(
    "uses durable delegation groups for batch discovery and routes wait/continue/cancel through native worker control",
    Effect.gen(function* () {
      const { config, root, directory } = yield* prepare()
      const workers = yield* OxpWorker.Service
      const principalRef = "oxp:" + (yield* config.get()).connector.id
      const batch = yield* seedBatch({
        directory,
        rootID: root.id,
        principalRef,
      })

      const listed = yield* workers.execute({ action: "batch_list" })
      expect(
        (
          listed.structured as {
            batches: Array<{ batchID: string; workerIDs: readonly string[] }>
          }
        ).batches,
      ).toEqual([
        expect.objectContaining({
          batchID: batch.batchID,
          workerIDs: [...batch.workerIDs],
        }),
      ])
      const got = yield* workers.execute({
        action: "batch_get",
        batchID: batch.batchID,
      })
      expect(got.structured).toMatchObject({
        batchID: batch.batchID,
        workerIDs: [...batch.workerIDs],
      })
      expect(calls).toEqual([])

      const waited = yield* workers.execute({
        action: "batch_wait",
        batchID: batch.batchID,
        timeoutMs: 10,
      })
      expect(waited.structured).toMatchObject({
        batchID: batch.batchID,
      })
      expect(calls.at(-1)).toMatchObject({
        action: "batch_wait",
        input: {
          workerIDs: [...batch.workerIDs],
          timeoutMs: 10,
        },
      })

      calls.length = 0
      const continued = yield* workers.execute({
        action: "batch_continue",
        batchID: batch.batchID,
        continuations: [
          { workerID: batch.workerIDs[0], prompt: "continue a" },
          { workerID: batch.workerIDs[1], prompt: "continue b" },
        ],
      })
      expect(continued.mutation).toEqual({
        attempted: true,
        committed: true,
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        action: "batch_continue",
        input: {
          items: [
            {
              workerID: batch.workerIDs[0],
              prompt: "continue a",
              nestedDelegation: false,
            },
            {
              workerID: batch.workerIDs[1],
              prompt: "continue b",
              nestedDelegation: false,
            },
          ],
        },
      })
      const continueInput = calls[0]?.input as Parameters<
        OxpWorkerControl.Interface["batchContinue"]
      >[1]
      expect(
        continueInput.items.every((item) =>
          item.invocationRef.startsWith("oxp-inv:"),
        ),
      ).toBe(true)

      calls.length = 0
      const cancelled = yield* workers.execute({
        action: "batch_cancel",
        batchID: batch.batchID,
      })
      expect(cancelled.mutation).toEqual({
        attempted: true,
        committed: true,
      })
      expect(calls).toEqual([
        expect.objectContaining({
          action: "batch_cancel",
          input: expect.objectContaining({
            workerIDs: [...batch.workerIDs],
          }),
        }),
      ])
    }),
  )
})
