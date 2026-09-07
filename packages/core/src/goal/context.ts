export * as GoalContext from "./context"

import { Context, Effect, Layer, Schema } from "effect"
import { Goal } from "./index"
import { SessionSchema } from "../session/schema"
import { SystemContext } from "../system-context"
import { makeGlobalNode } from "../effect/app-node"

const Snapshot = Schema.Struct({
  id: Schema.String,
  revision: Schema.Number,
  status: Schema.String,
  title: Schema.String,
  objective: Schema.String,
  blocker: Schema.NullOr(Schema.String),
  mode: Schema.String,
  criteria: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String, description: Schema.String })),
  steps: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String, title: Schema.String })),
})
type Snapshot = typeof Snapshot.Type

export interface Interface {
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<SystemContext.SystemContext>
  readonly render: (sessionID: SessionSchema.ID) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GoalContext") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const goals = yield* Goal.Service

    const observe = Effect.fn("GoalContext.observe")(function* (sessionID: SessionSchema.ID) {
      const focused = yield* goals.focused(sessionID)
      if (!focused) return undefined
      return {
        detail: focused.detail,
        snapshot: toSnapshot(focused.detail),
      }
    })

    const render = Effect.fn("GoalContext.render")(function* (sessionID: SessionSchema.ID) {
      const current = yield* observe(sessionID)
      return current ? baseline(current.snapshot, current.detail.goal.constraints) : undefined
    })

    const forSession = Effect.fn("GoalContext.forSession")(function* (sessionID: SessionSchema.ID) {
      const current = yield* observe(sessionID)
      if (!current) return SystemContext.empty
      return SystemContext.make({
        key: SystemContext.Key.make("goal/focused"),
        codec: Schema.toCodecJson(Snapshot),
        load: observe(sessionID).pipe(
          Effect.map((next) => (next ? next.snapshot : SystemContext.unavailable)),
        ),
        baseline: (value) => baseline(value, current.detail.goal.constraints),
        update: (_previous, value) => update(value),
        removed: () =>
          "The Session no longer has a focused Goal. Stop treating the previous Goal as active context unless the user focuses it again.",
      })
    })

    return Service.of({ forSession, render })
  }),
)

function toSnapshot(detail: Goal.Detail): Snapshot {
  return {
    id: detail.goal.id,
    revision: detail.goal.revision,
    status: detail.goal.status,
    title: detail.goal.title,
    objective: detail.goal.objective,
    blocker: detail.goal.blocker ?? null,
    mode: detail.goal.continuationPolicy.mode,
    criteria: detail.criteria.map((criterion) => ({
      id: criterion.id,
      status: criterion.status,
      description: criterion.description,
    })),
    steps: detail.steps.map((step) => ({ id: step.id, status: step.status, title: step.title })),
  }
}

function baseline(value: Snapshot, constraints: ReadonlyArray<string>) {
  return [
    "<focused_goal>",
    `  <id>${value.id}</id>`,
    `  <revision>${value.revision}</revision>`,
    `  <status>${value.status}</status>`,
    `  <automation>${value.mode}</automation>`,
    `  <title>${escape(value.title)}</title>`,
    `  <objective>${escape(value.objective)}</objective>`,
    ...(value.blocker ? [`  <blocker>${escape(value.blocker)}</blocker>`] : []),
    ...(constraints.length
      ? ["  <constraints>", ...constraints.map((item) => `    <constraint>${escape(item)}</constraint>`), "  </constraints>"]
      : []),
    "  <acceptance_criteria>",
    ...value.criteria.map(
      (criterion) =>
        `    <criterion id="${criterion.id}" status="${criterion.status}">${escape(criterion.description)}</criterion>`,
    ),
    "  </acceptance_criteria>",
    ...(value.steps.length
      ? [
          "  <steps>",
          ...value.steps.map((step) => `    <step id="${step.id}" status="${step.status}">${escape(step.title)}</step>`),
          "  </steps>",
        ]
      : []),
    "</focused_goal>",
    "The Goal is durable user-owned task state, not a suggestion. Work toward its objective while respecting user messages and higher-priority instructions.",
    "Use goal_read when state may have changed. Keep step/criterion state current with Goal tools. Add concrete evidence before passing criteria.",
    "Do not claim the Goal completed directly. Completion requires the verifying state, every criterion passed with evidence, then verification_pass.",
    "If genuinely blocked, record the blocker with goal_transition instead of repeatedly asking or spinning.",
  ].join("\n")
}

function update(value: Snapshot) {
  return [
    "The focused Goal state changed:",
    `Goal ${value.id} is now revision ${value.revision}, status ${value.status}, automation ${value.mode}.`,
    ...(value.blocker ? [`Blocker: ${value.blocker}`] : []),
    `Criteria: ${value.criteria.map((item) => `${item.id}=${item.status}`).join(", ") || "none"}.`,
    `Steps: ${value.steps.map((item) => `${item.id}=${item.status}`).join(", ") || "none"}.`,
    "Use goal_read for full details before making a state-sensitive Goal mutation.",
  ].join("\n")
}

function escape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Goal.node] })
