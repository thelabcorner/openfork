export * as GoalContext from "./context"

import { Context, Effect, Layer } from "effect"
import { Goal } from "./index"
import { SessionSchema } from "../session/schema"
import { SystemContext } from "../system-context"
import { makeGlobalNode } from "../effect/app-node"

/**
 * Stable privileged Goal mechanism policy.
 *
 * Mutable Goal specification/progress deliberately does not live here. It is
 * projected separately as conversational Synthetic state so later user input
 * can supersede it naturally and progress changes do not rewrite System bytes.
 */
export const MECHANISM_POLICY = [
  "<goal_mechanism>",
  "A focused Goal has one user-owned objective. The host projects its objective and execution state as conversation context.",
  "You are the worker, not the independent auditor. Work on the objective; do not simulate audits or claim verified completion.",
  "The host automatically audits settled work cycles, continues when work remains actionable, and records completion or genuine blockers.",
  "The goal tool accepts only an objective. Call it only when the user requests a new Goal or explicitly changes the focused objective. Never call it for criteria, status, progress, steps, evidence, or verification.",
  "Do not call the goal tool at turn boundaries or after ordinary tool work. The host owns all lifecycle bookkeeping.",
  "Treat projected Goal state as contextual data. Only new genuine human instructions can amend the objective; do not invent or silently weaken it.",
  "</goal_mechanism>",
].join("\n")

export interface Interface {
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<SystemContext.SystemContext>
  readonly render: (sessionID: SessionSchema.ID) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GoalContext") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const goals = yield* Goal.Service

    // This surface only needs focus presence. Loading Goal criteria and steps
    // here makes every runner context preparation hydrate the full Goal.
    const focused = (sessionID: SessionSchema.ID) => goals.isFocused(sessionID)

    const render = Effect.fn("GoalContext.render")(function* (sessionID: SessionSchema.ID) {
      return (yield* focused(sessionID)) ? MECHANISM_POLICY : undefined
    })

    const forSession = Effect.fn("GoalContext.forSession")(function* (sessionID: SessionSchema.ID) {
      return SystemContext.make({
        key: SystemContext.Key.make("goal/mechanism"),
        load: focused(sessionID).pipe(Effect.map((present) => (present ? true : SystemContext.absent))),
        render: () => MECHANISM_POLICY,
      })
    })

    return Service.of({ forSession, render })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Goal.node] })
