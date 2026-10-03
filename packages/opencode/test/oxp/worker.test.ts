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
import { OxpModelCatalog } from "@/oxp/model-catalog"
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
const resolutionInputs: unknown[] = []
let beforeGuard: (() => Promise<void>) | undefined
let afterCommit: (() => void) | undefined
let batchStartError: Error | undefined
let resolveSelectionError: Error | undefined
let blockResolveSelectionUntilAbort = false
let blockWaitUntilAbort = false
let blockBatchWaitUntilAbort = false

const waitForAbort = (target: OxpWorkerControl.Target) =>
  Effect.tryPromise({
    try: () =>
      new Promise<never>((_resolve, reject) => {
        const signal = target.signal
        if (!signal) {
          reject(new Error("expected runtime target AbortSignal"))
          return
        }
        if (signal.aborted) {
          reject(new DOMException("aborted", "AbortError"))
          return
        }
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        )
      }),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("wait cancellation failed"),
  })

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
    resolveSelection: (target, input) => {
      resolutionInputs.push(input)
      if (blockResolveSelectionUntilAbort) return waitForAbort(target)
      return resolveSelectionError
        ? Effect.fail(resolveSelectionError)
        : Effect.succeed({
            agent: input.agent ?? "build",
            model: input.model ?? MODEL,
          })
    },
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
    setSelection: (target, input) =>
      Effect.gen(function* () {
        yield* guard(target)
        calls.push({ action: "set_selection", target, input })
        afterCommit?.()
        return {
          workerID: input.workerID,
          previousModel: MODEL,
          model: input.model,
          changed:
            JSON.stringify(input.model) !== JSON.stringify(MODEL),
          state: "completed" as const,
        }
      }),
    wait: (target, input) =>
      Effect.gen(function* () {
        calls.push({ action: "wait", target, input })
        if (blockWaitUntilAbort) return yield* waitForAbort(target)
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
      Effect.gen(function* () {
        calls.push({ action: "batch_wait", target, input })
        if (blockBatchWaitUntilAbort) return yield* waitForAbort(target)
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

const modelCatalogLayer = Layer.succeed(
  OxpModelCatalog.Service,
  OxpModelCatalog.Service.of({
    list: (_target) =>
      Effect.succeed({
        models: [
          {
            providerID: "opencode-go",
            providerName: "OpenCode Go",
            modelID: "deepseek-v4.1-flash",
            name: "DeepSeek V4.1 Flash",
            family: "deepseek",
            status: "active",
            variants: ["high", "max"],
          },
          {
            providerID: "workbuddy",
            providerName: "WorkBuddy",
            modelID: "deepseek-r2",
            name: "DeepSeek R2",
            status: "active",
            variants: ["thinking"],
          },
        ],
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
    [OxpModelCatalog.node, modelCatalogLayer],
  ],
)
const it = testEffect(layer)

beforeEach(async () => {
  calls.length = 0
  resolutionInputs.length = 0
  beforeGuard = undefined
  afterCommit = undefined
  batchStartError = undefined
  resolveSelectionError = undefined
  blockResolveSelectionUntilAbort = false
  blockWaitUntilAbort = false
  blockBatchWaitUntilAbort = false
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
  yield* config.setWorkerDefaultModel(MODEL)
  yield* config.setWorkerDefaultAgent(root.id, "build")
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
    "discovers the authoritative provider model and variant catalog without a separate bridge",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const workers = yield* OxpWorker.Service

      const result = yield* workers.execute({
        action: "model_catalog",
        rootID: root.id,
        providerID: "opencode-go",
      })

      expect(result.structured).toEqual({
        rootID: root.id,
        rootAlias: "workspace",
        workdir: "/workspace",
        providerID: "opencode-go",
        configuredDefaultModel: MODEL,
        total: 1,
        returned: 1,
        truncated: false,
        models: [
          {
            providerID: "opencode-go",
            providerName: "OpenCode Go",
            modelID: "deepseek-v4.1-flash",
            name: "DeepSeek V4.1 Flash",
            family: "deepseek",
            status: "active",
            variants: ["high", "max"],
          },
        ],
      })
    }),
  )

  it.live(
    "fails model discovery closed instead of silently substituting an unavailable model",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const workers = yield* OxpWorker.Service

      const error = yield* workers
        .execute({
          action: "model_catalog",
          rootID: root.id,
          providerID: "opencode-go",
          modelID: "does-not-exist",
        })
        .pipe(Effect.flip)

      expect(error._tag).toBe("OXP_NOT_FOUND")
      expect(error.message).toContain("do not substitute another model")
    }),
  )

  it.live(
    "starts with exact provider/account/agent selection and preserves external invocation lineage",
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
    "anchors start and batch_start to one verified nested workdir and rejects escapes",
    Effect.gen(function* () {
      const { roots, root, directory } = yield* prepare()
      const workers = yield* OxpWorker.Service
      const nested = path.join(directory, "nested", "repo")
      yield* Effect.promise(() => fs.mkdir(nested, { recursive: true }))
      const resolved = yield* roots.resolvePath("nested/repo", { rootID: root.id })

      const started = yield* workers.execute({
        action: "start",
        rootID: root.id,
        workdir: "nested/repo",
        prompt: "Work in the nested repository",
      })
      expect(started.structured).toMatchObject({
        workerID: "ses_oxp_worker_started",
        workdir: resolved.virtualPath,
      })
      expect(calls.at(-1)).toMatchObject({
        action: "start",
        target: { directory: resolved.path },
      })

      const batch = yield* workers.execute({
        action: "batch_start",
        rootID: root.id,
        workdir: "nested/repo",
        workers: [{ prompt: "first" }, { prompt: "second" }],
      })
      expect(batch.structured).toMatchObject({
        batchID: "grp_oxp_worker_batch",
        workdir: resolved.virtualPath,
      })
      expect(calls.at(-1)).toMatchObject({
        action: "batch_start",
        target: { directory: resolved.path },
      })

      const file = path.join(directory, "not-a-directory.txt")
      yield* Effect.promise(() => fs.writeFile(file, "x"))
      const beforeInvalid = calls.length
      const notDirectory = yield* workers
        .execute({
          action: "start",
          rootID: root.id,
          workdir: "not-a-directory.txt",
          prompt: "must not start",
        })
        .pipe(Effect.flip)
      expect(notDirectory._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(calls).toHaveLength(beforeInvalid)

      const traversal = yield* workers
        .execute({
          action: "start",
          rootID: root.id,
          workdir: "../outside",
          prompt: "must not escape",
        })
        .pipe(Effect.flip)
      expect(traversal._tag).toBe("OXP_PATH_ESCAPE")
      expect(calls).toHaveLength(beforeInvalid)

      const outside = path.join(suite, "outside")
      const link = path.join(directory, "escape-link")
      yield* Effect.promise(async () => {
        await fs.mkdir(outside, { recursive: true })
        await fs.symlink(
          outside,
          link,
          process.platform === "win32" ? "junction" : "dir",
        )
      })
      const linkedEscape = yield* workers
        .execute({
          action: "start",
          rootID: root.id,
          workdir: "escape-link",
          prompt: "must not follow an escaping link",
        })
        .pipe(Effect.flip)
      expect(linkedEscape._tag).toBe("OXP_PATH_ESCAPE")
      expect(calls).toHaveLength(beforeInvalid)

      const volatile = path.join(directory, "volatile")
      yield* Effect.promise(() => fs.mkdir(volatile))
      beforeGuard = () => fs.rm(volatile, { recursive: true, force: true })
      const disappeared = yield* workers
        .execute({
          action: "start",
          rootID: root.id,
          workdir: "volatile",
          prompt: "must revalidate the directory at commit",
        })
        .pipe(Effect.flip)
      beforeGuard = undefined
      expect(disappeared._tag).toBe("OXP_CONFLICT")
      expect(disappeared.detail).toContain("disappeared before commit")
      expect(calls).toHaveLength(beforeInvalid)
    }),
  )

  it.live(
    "materializes configured OXP defaults before native resolution and preserves explicit overrides",
    Effect.gen(function* () {
      const { roots, root } = yield* prepare()
      const workers = yield* OxpWorker.Service

      yield* workers.execute({
        action: "start",
        rootID: root.id,
        prompt: "Use configured OXP defaults",
      })
      expect(resolutionInputs.at(-1)).toEqual({
        model: MODEL,
        agent: "build",
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
      expect(resolutionInputs.at(-1)).toEqual({
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
        prompt: "Explicit selection needs no OXP allowlist or default on a new root",
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
    "preserves explicit Public route intent through OXP wire admission and native worker control",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const workers = yield* OxpWorker.Service
      const publicModel = {
        providerID: "workbuddy",
        modelID: "deepseek-v4.1-flash",
        variant: "max",
        routeIntent: { kind: "public" as const },
      }

      yield* workers.execute({
        action: "start",
        rootID: root.id,
        prompt: "Stay on the explicit Public route",
        model: publicModel,
        agent: "build",
      })

      expect(resolutionInputs.at(-1)).toEqual({
        model: publicModel,
        agent: "build",
      })
      expect(calls.at(-1)).toMatchObject({
        action: "start",
        input: {
          model: publicModel,
          origin: {
            model: publicModel,
            agent: "build",
          },
        },
      })
      expect((calls.at(-1)?.input as { model?: { accountID?: string } })?.model?.accountID).toBeUndefined()
    }),
  )

  it.live(
    "fails closed before native fallback when an omitted OXP selection has no configured default",
    Effect.gen(function* () {
      const { config, root } = yield* prepare()
      const workers = yield* OxpWorker.Service

      yield* config.setWorkerDefaultModel(undefined)
      resolutionInputs.length = 0
      const noModel = yield* workers
        .execute({
          action: "start",
          rootID: root.id,
          prompt: "Do not consult Provider.defaultModel",
        })
        .pipe(Effect.flip)
      expect(noModel._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(noModel.detail).toContain("default model")
      expect(resolutionInputs).toEqual([])

      yield* config.setWorkerDefaultModel(MODEL)
      yield* config.setWorkerDefaultAgent(root.id, undefined)
      const noAgent = yield* workers
        .execute({
          action: "start",
          rootID: root.id,
          prompt: "Do not consult Agent.defaultInfo",
        })
        .pipe(Effect.flip)
      expect(noAgent._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(noAgent.detail).toContain("default agent")
      expect(resolutionInputs).toEqual([])
    }),
  )

  it.live(
    "preserves actionable missing-runtime dependency identity from native selection",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const workers = yield* OxpWorker.Service
      resolveSelectionError = new Error(
        "Service not found: @opencode/v2/SessionExecutionOwner",
      )

      const error = yield* workers
        .execute({
          action: "start",
          rootID: root.id,
          prompt: "exercise native dependency projection",
        })
        .pipe(Effect.flip)

      expect(error._tag).toBe("OXP_DEPENDENCY_UNAVAILABLE")
      expect(error.detail).toContain("@opencode/v2/SessionExecutionOwner")
      expect(error.metadata).toMatchObject({
        dependency: "@opencode/v2/SessionExecutionOwner",
        nativeError: "Error",
      })
      expect(calls).toEqual([])
    }),
  )

  it.live(
    "resolves each batch worker independently from configured OXP defaults plus explicit overrides",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const workers = yield* OxpWorker.Service

      yield* workers.execute({
        action: "batch_start",
        rootID: root.id,
        workers: [
          { prompt: "use configured defaults" },
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
        undefined,
        undefined,
        ["ses_committed_a"],
        ["ses_committed_b"],
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
        workersResidual: 1,
        residualWorkerID0: "ses_committed_a",
        workersCompensated: 1,
        compensatedWorkerID0: "ses_committed_b",
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
        workers: Array<{
          workerID: string
          location: unknown
          execution: { generation: number; owned: boolean; running?: boolean }
        }>
      }
      expect(listData.workers.map((item) => item.workerID)).toEqual([
        workerID,
      ])
      expect(listData.workers[0]?.location).toEqual({
        rootID: root.id,
        path: "/" + root.alias,
      })
      expect(listData.workers[0]?.execution).toMatchObject({
        generation: 0,
        owned: false,
      })
      expect(listData.workers[0]?.execution).not.toHaveProperty("running")

      const got = yield* workers.execute({
        action: "get",
        workerID,
      })
      expect(got.structured).toMatchObject({
        workerID,
        model: MODEL,
        agent: "build",
        execution: { generation: 0, owned: false },
      })
      expect((got.structured as { execution: object }).execution).not.toHaveProperty("running")
      expect(JSON.stringify(listed)).not.toContain(directory)
      expect(JSON.stringify(got)).not.toContain(directory)
      expect(calls).toEqual([])
    }),
  )

  it.live(
    "rebinds an existing worker model/account/variant through explicit set_selection",
    Effect.gen(function* () {
      const { config, root, directory } = yield* prepare()
      const workers = yield* OxpWorker.Service
      const connector = (yield* config.get()).connector.id
      const workerID = yield* seedWorker({
        directory,
        rootID: root.id,
        principalRef: "oxp:" + connector,
      })

      const result = yield* workers.execute({
        action: "set_selection",
        workerID,
        model: MODEL_2,
        expectedModel: MODEL,
      })

      expect(result.structured).toMatchObject({
        workerID,
        previousModel: MODEL,
        model: MODEL_2,
        changed: true,
        state: "completed",
        appliesTo: "next_turn",
      })
      expect(result.mutation).toEqual({ attempted: true, committed: true })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        action: "set_selection",
        input: {
          workerID,
          model: MODEL_2,
          expectedModel: MODEL,
        },
      })
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
          {
            workerID: batch.workerIDs[0],
            prompt: "continue a",
            model: { ...MODEL, accountID: "Team Key 2" },
          },
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
              expectedModel: { ...MODEL, accountID: "Team Key 2" },
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

  it.live(
    "cancels worker wait through the runtime signal without cancelling the durable worker",
    Effect.gen(function* () {
      const { config, root, directory } = yield* prepare()
      const workers = yield* OxpWorker.Service
      const connector = (yield* config.get()).connector.id
      const workerID = yield* seedWorker({
        directory,
        rootID: root.id,
        principalRef: "oxp:" + connector,
      })
      blockWaitUntilAbort = true
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20)

      const error = yield* workers
        .execute(
          {
            action: "wait",
            workerID,
            timeoutMs: 30_000,
          },
          controller.signal,
        )
        .pipe(Effect.flip)
      clearTimeout(timer)

      expect(error._tag).toBe("OXP_CANCELLED")
      expect(calls.map((call) => call.action)).toEqual(["wait"])
      expect(calls[0]?.target.signal).toBe(controller.signal)
    }),
  )

  it.live(
    "cancels pre-commit worker selection resolution without committing a worker",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const workers = yield* OxpWorker.Service
      blockResolveSelectionUntilAbort = true
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20)

      const error = yield* workers
        .execute(
          {
            action: "start",
            rootID: root.id,
            prompt: "must not commit after transport cancellation",
          },
          controller.signal,
        )
        .pipe(Effect.flip)
      clearTimeout(timer)

      expect(error._tag).toBe("OXP_CANCELLED")
      expect(calls).toEqual([])
      expect(resolutionInputs).toHaveLength(1)
    }),
  )

  it.live(
    "cancels batch wait through the runtime signal without cancelling batch members",
    Effect.gen(function* () {
      const { config, root, directory } = yield* prepare()
      const workers = yield* OxpWorker.Service
      const principalRef = "oxp:" + (yield* config.get()).connector.id
      const batch = yield* seedBatch({
        directory,
        rootID: root.id,
        principalRef,
      })
      blockBatchWaitUntilAbort = true
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20)

      const error = yield* workers
        .execute(
          {
            action: "batch_wait",
            batchID: batch.batchID,
            timeoutMs: 30_000,
          },
          controller.signal,
        )
        .pipe(Effect.flip)
      clearTimeout(timer)

      expect(error._tag).toBe("OXP_CANCELLED")
      expect(calls.map((call) => call.action)).toEqual(["batch_wait"])
      expect(calls[0]?.target.signal).toBe(controller.signal)
    }),
  )
})
