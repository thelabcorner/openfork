import * as AgentCatalog from "@opencode-ai/core/agent/catalog"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { Effect, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import * as SessionAutoShareQueue from "@/session/auto-share-queue"
import { SessionShare } from "@/share/session"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import { SessionCreateApi } from "../groups/session-create"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"

export const sessionCreateHandlers = HttpApiBuilder.group(SessionCreateApi, "sessionCreate", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const project = yield* Project.Service
    const config = yield* Config.Service
    const store = yield* InstanceStore.Service
    const share = yield* SessionShare.Service
    const flags = yield* RuntimeFlags.Service
    const autoShareQueue = yield* SessionAutoShareQueue.make({
      capacity: 32,
      run: (task: { sessionID: Session.Info["id"]; location: Session.ResolvedLocation }) =>
        store.provide(
          {
            directory: task.location.directory,
            project: task.location.project,
            worktree: task.location.worktree,
            attribution: { caller: "session-create", route: "/session", reason: "auto-share policy" },
          },
          Effect.ignore(share.share(task.sessionID)),
        ),
    })

    const create = Effect.fn("SessionAdmissionHttpApi.create")(function* (input: Session.CreateInput | undefined) {
      const route = yield* WorkspaceRouteContext
      const resolved = yield* project.fromDirectory(route.directory)
      const location = {
        directory: route.directory,
        worktree: resolved.sandbox,
        project: resolved.project,
        workspaceID: route.workspaceID,
      }

      if (input?.agent) {
        const ref = Location.Ref.make({
          directory: AbsolutePath.make(FSUtil.resolve(route.directory)),
          workspaceID: route.workspaceID,
        })
        const context = yield* AgentCatalog.MapService.contextEffect(ref)
        const agents = yield* AgentCatalog.Service.use((catalog) => catalog.list()).pipe(Effect.provideContext(context))
        if (!agents.some((agent) => agent.id === input.agent)) {
          return yield* new HttpApiError.BadRequest({})
        }
      }

      const payload = input
        ? {
            ...input,
            metadata: SessionMetadataOwnership.forPublicCreate(input.metadata),
            permission: input.permission ? [...input.permission] : undefined,
          }
        : undefined
      const created = yield* session.createForLocation(payload, location).pipe(
        Effect.catchCause(() => Effect.fail(new HttpApiError.InternalServerError({}))),
      )

      // Preserve the existing auto-share policy, but do not bootstrap an
      // Instance to discover that sharing is disabled. Only the explicit
      // auto-share flag or the Tier-2 policy projection admits share work.
      if (!created.parentID && (flags.autoShare || (yield* config.sharePolicyForLocation(location)) === "auto")) {
        const accepted = yield* autoShareQueue.offer({ sessionID: created.id, location })
        if (!accepted) {
          yield* Effect.logWarning("auto-share backlog is full; skipping best-effort share", { sessionID: created.id })
        }
      }
      return created
    })

    const createRaw = Effect.fn("SessionAdmissionHttpApi.createRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* create(undefined)

      const json = yield* Effect.try({
        try: () => JSON.parse(body) as unknown,
        catch: () => new HttpApiError.BadRequest({}),
      })
      const decoded = yield* Schema.decodeUnknownEffect(Session.CreateInput)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return yield* create(
        decoded
          ? {
              ...decoded,
              permission: decoded.permission ? [...decoded.permission] : undefined,
            }
          : undefined,
      )
    })

    return handlers.handleRaw("create", createRaw)
  }),
)
