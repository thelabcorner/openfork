import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionID = SessionSchema.ID.make("ses_route_intent_roundtrip")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/route-intent"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "route-intent",
      directory: "/route-intent",
      title: "route intent",
      version: "test",
      agent: "build",
      model: { providerID: "opencode", id: "space-bunny-free", variant: "default" },
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const model = {
  id: Model.ID.make("space-bunny-free"),
  providerID: Provider.ID.make("opencode"),
}

const admit = (
  id: string,
  routeIntent: ProviderRouteIntent.Info,
) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    return yield* SessionInput.admitSynthetic(db, events, {
      id: SessionMessage.ID.make(id),
      sessionID,
      content: SessionInput.SyntheticContent.make({ text: id }),
      origin: SessionInput.SyntheticOrigin.make({
        producer: "scheduled-task.test",
        actor: { type: "host" },
        ref: id,
      }),
      execution: {
        agent: "build",
        model,
        routeIntent,
      },
      admissionClass: "host",
      delivery: "queue",
    })
  })

describe("SessionInput SyntheticExecution route intent", () => {
  it.effect("durably round-trips Auto, Public, and account route intent", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const intents = [
        ProviderRouteIntent.Info.make({ kind: "auto" }),
        ProviderRouteIntent.Info.make({ kind: "public" }),
        ProviderRouteIntent.Info.make({ kind: "account", accountID: "acct-a", pin: "soft" }),
      ] as const

      for (const [index, intent] of intents.entries()) {
        const id = SessionMessage.ID.make(`msg_route_intent_${index}`)
        yield* admit(String(id), intent)
        const stored = yield* SessionInput.findEntry(db, id)
        expect(stored?.item.type).toBe("synthetic")
        if (stored?.item.type !== "synthetic") continue
        expect(stored.item.execution?.routeIntent).toEqual(intent)
        expect(stored.item.execution?.model).toEqual(model)
      }
    }),
  )

  it.effect("preserves route intent after Synthetic promotion", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_route_intent_promoted")
      const intent = ProviderRouteIntent.Info.make({ kind: "public" })

      yield* admit(String(id), intent)
      const cutoff = yield* EventV2.latestSequence(db, sessionID)
      yield* SessionInput.promoteLane(db, events, sessionID, { admissionClass: "host", delivery: "queue" }, cutoff)

      const stored = yield* SessionInput.findEntry(db, id)
      expect(stored?.promotedSeq).toBeDefined()
      expect(stored?.item.type).toBe("synthetic")
      if (stored?.item.type !== "synthetic") return
      expect(stored.item.execution?.routeIntent).toEqual(intent)
    }),
  )

  it.effect("rejects an idempotent replay that changes only route intent", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_route_intent_replay")

      const base = {
        id,
        sessionID,
        content: SessionInput.SyntheticContent.make({ text: "same content" }),
        origin: SessionInput.SyntheticOrigin.make({
          producer: "scheduled-task.test",
          actor: { type: "host" as const },
          ref: "same-ref",
        }),
        admissionClass: "host" as const,
        delivery: "queue" as const,
      }

      const first = yield* SessionInput.admitSynthetic(db, events, {
        ...base,
        execution: {
          agent: "build",
          model,
          routeIntent: ProviderRouteIntent.Info.make({ kind: "public" }),
        },
      })
      const identical = yield* SessionInput.admitSynthetic(db, events, {
        ...base,
        execution: {
          agent: "build",
          model,
          routeIntent: ProviderRouteIntent.Info.make({ kind: "public" }),
        },
      })
      expect(identical.admittedSeq).toBe(first.admittedSeq)

      const replay = yield* SessionInput.admitSynthetic(db, events, {
        ...base,
        execution: {
          agent: "build",
          model,
          routeIntent: ProviderRouteIntent.Info.make({ kind: "auto" }),
        },
      }).pipe(Effect.exit)

      expect(Exit.isFailure(replay)).toBe(true)
      if (Exit.isFailure(replay)) expect(String(replay.cause)).toContain("SessionInput.LifecycleConflict")
    }),
  )
})
