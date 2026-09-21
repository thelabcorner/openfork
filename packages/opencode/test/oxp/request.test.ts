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
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { OxpConfig } from "@/oxp/config"
import { OxpRequest } from "@/oxp/request"
import { OxpRequestControl } from "@/oxp/request-control"
import { OxpRoot } from "@/oxp/root"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-request-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const approvedID = SessionSchema.ID.make("ses_oxp_request_approved")
const outsideID = SessionSchema.ID.make("ses_oxp_request_outside")

type Call =
  | { action: "list"; target: OxpRequestControl.Target }
  | {
      action: "reply_permission"
      target: OxpRequestControl.Target
      input: Parameters<OxpRequestControl.Interface["replyPermission"]>[1]
    }
  | {
      action: "answer_question"
      target: OxpRequestControl.Target
      input: Parameters<OxpRequestControl.Interface["answerQuestion"]>[1]
    }
  | {
      action: "reject_question"
      target: OxpRequestControl.Target
      input: Parameters<OxpRequestControl.Interface["rejectQuestion"]>[1]
    }

const calls: Call[] = []

const guarded = <A>(
  target: OxpRequestControl.Target,
  effect: Effect.Effect<A, Error>,
) =>
  Effect.tryPromise({
    try: () => target.commitGuard?.() ?? Promise.resolve(),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("test commit guard failed"),
  }).pipe(Effect.andThen(effect))

const controlLayer = Layer.succeed(
  OxpRequestControl.Service,
  OxpRequestControl.Service.of({
    list: (target) =>
      Effect.sync(() => {
        calls.push({ action: "list", target })
        return {
          permissions: [
            {
              type: "permission" as const,
              id: "per_oxp",
              permission: "bash",
              patterns: ["git status"],
              externalDirectory: false,
            },
            {
              type: "permission" as const,
              id: "per_external",
              permission: "external_directory",
              patterns: [],
              externalDirectory: true,
            },
          ],
          questions: [
            {
              type: "question" as const,
              id: "que_oxp",
              questions: [
                {
                  question: "Proceed?",
                  header: "Confirm",
                  options: [{ label: "Yes", description: "Continue" }],
                },
              ],
            },
          ],
        }
      }),
    replyPermission: (target, input) =>
      guarded(
        target,
        Effect.gen(function* () {
          calls.push({ action: "reply_permission", target, input })
          if (input.requestID === "per_external" && input.reply !== "reject") {
            return yield* Effect.fail(
              new OxpRequestControl.ExternalDirectoryBlocked(),
            )
          }
        }),
      ),
    answerQuestion: (target, input) =>
      guarded(
        target,
        Effect.sync(() => {
          calls.push({ action: "answer_question", target, input })
        }),
      ),
    rejectQuestion: (target, input) =>
      guarded(
        target,
        Effect.sync(() => {
          calls.push({ action: "reject_question", target, input })
        }),
      ),
  }),
)

const layer = AppNodeBuilder.build(
  LayerNode.group([OxpRequest.node, OxpRoot.node, OxpConfig.node, Database.node]),
  [
    [Global.node, Global.layerWith({ config: configDir, state: stateDir })],
    [OxpRequestControl.node, controlLayer],
  ],
)
const it = testEffect(layer)

beforeEach(async () => {
  calls.length = 0
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})
afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

const seed = (approvedDir: string, outsideDir: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    yield* db
      .insert(ProjectTable)
      .values({
        id: Project.ID.global,
        worktree: AbsolutePath.make(approvedDir),
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values([
        {
          id: approvedID,
          project_id: Project.ID.global,
          slug: "approved",
          directory: approvedDir,
          title: "Approved Session",
          version: "test",
          time_created: now - 10,
          time_updated: now,
        },
        {
          id: outsideID,
          project_id: Project.ID.global,
          slug: "outside",
          directory: outsideDir,
          title: "Outside Session",
          version: "test",
          time_created: now - 10,
          time_updated: now,
        },
      ])
      .run()
      .pipe(Effect.orDie)
  })

const prepare = Effect.fnUntraced(function* () {
  const config = yield* OxpConfig.Service
  const roots = yield* OxpRoot.Service
  const approvedDir = path.join(suite, "approved")
  const outsideDir = path.join(suite, "outside")
  yield* Effect.promise(() =>
    Promise.all([
      fs.mkdir(approvedDir, { recursive: true }),
      fs.mkdir(outsideDir, { recursive: true }),
    ]),
  )
  yield* seed(approvedDir, outsideDir)
  const root = yield* roots.approve(approvedDir)
  yield* config.setEnabled(true)
  return { config, root, approvedDir }
})

describe("OxpRequest", () => {
  it.live(
    "requires requestSupervision independently from Session supervision",
    Effect.gen(function* () {
      const { config } = yield* prepare()
      const requests = yield* OxpRequest.Service
      yield* config.setGrant({
        sessionSupervision: "approved-roots",
        requestSupervision: false,
      })
      const error = yield* requests
        .execute({ action: "list", sessionID: approvedID })
        .pipe(Effect.flip)
      expect(error._tag).toBe("OXP_AUTH_DENIED")
      expect(calls).toEqual([])
    }),
  )

  it.live(
    "lists only the explicitly targeted supervised Session and attributes replies to the OXP principal",
    Effect.gen(function* () {
      const { config, root, approvedDir } = yield* prepare()
      const requests = yield* OxpRequest.Service
      yield* config.setGrant({
        sessionSupervision: "approved-roots",
        requestSupervision: true,
      })
      const connector = (yield* config.get()).connector.id

      const listed = yield* requests.execute({
        action: "list",
        sessionID: approvedID,
        rootID: root.id,
      })
      expect(listed.structured).toMatchObject({
        sessionID: approvedID,
        permissions: [
          { id: "per_oxp", externalDirectory: false },
          { id: "per_external", externalDirectory: true, patterns: [] },
        ],
        questions: [{ id: "que_oxp" }],
      })
      expect(calls[0]).toMatchObject({
        action: "list",
        target: { sessionID: approvedID, directory: approvedDir },
      })

      const replied = yield* requests.execute({
        action: "reply_permission",
        sessionID: approvedID,
        requestID: "per_oxp",
        reply: "once",
      })
      expect(replied.mutation).toEqual({ attempted: true, committed: true })
      expect(calls[1]).toMatchObject({
        action: "reply_permission",
        input: {
          requestID: "per_oxp",
          reply: "once",
          actorRef: "oxp:" + connector,
        },
      })
    }),
  )

  it.live(
    "fails external_directory approval closed while still permitting explicit rejection",
    Effect.gen(function* () {
      const { config } = yield* prepare()
      const requests = yield* OxpRequest.Service
      yield* config.setGrant({
        sessionSupervision: "approved-roots",
        requestSupervision: true,
      })

      const denied = yield* requests
        .execute({
          action: "reply_permission",
          sessionID: approvedID,
          requestID: "per_external",
          reply: "always",
        })
        .pipe(Effect.flip)
      expect(denied._tag).toBe("OXP_AUTH_DENIED")

      const rejected = yield* requests.execute({
        action: "reply_permission",
        sessionID: approvedID,
        requestID: "per_external",
        reply: "reject",
      })
      expect(rejected.mutation).toEqual({ attempted: true, committed: true })
    }),
  )

  it.live(
    "does not reveal pending requests for Sessions outside approved roots",
    Effect.gen(function* () {
      const { config } = yield* prepare()
      const requests = yield* OxpRequest.Service
      yield* config.setGrant({
        sessionSupervision: "approved-roots",
        requestSupervision: true,
      })
      const outside = yield* requests
        .execute({ action: "list", sessionID: outsideID })
        .pipe(Effect.flip)
      const missing = yield* requests
        .execute({ action: "list", sessionID: "ses_missing" })
        .pipe(Effect.flip)
      expect(outside._tag).toBe("OXP_NOT_FOUND")
      expect(missing._tag).toBe("OXP_NOT_FOUND")
      expect(outside.message).toBe(missing.message)
      expect(calls).toEqual([])
    }),
  )

  it.live(
    "propagates cancellation before entering the request runtime",
    Effect.gen(function* () {
      const { config } = yield* prepare()
      const requests = yield* OxpRequest.Service
      yield* config.setGrant({
        sessionSupervision: "approved-roots",
        requestSupervision: true,
      })
      const controller = new AbortController()
      controller.abort()
      const error = yield* requests
        .execute(
          { action: "list", sessionID: approvedID },
          controller.signal,
        )
        .pipe(Effect.flip)
      expect(error._tag).toBe("OXP_CANCELLED")
      expect(calls).toEqual([])
    }),
  )
})
