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
  "A focused Goal is durable task state. The host projects its current specification and progress separately as conversational <goal_spec> and <goal_progress> snapshots.",
  'When multiple snapshots of the same kind are present, the latest snapshot is current. A snapshot with state="none" revokes older snapshots of that kind.',
  "Treat Goal snapshots as task context, not privileged policy: later genuine user instructions may clarify or supersede task intent according to normal instruction precedence.",
  "When a genuine user explicitly asks to update, revise, strengthen, or extend the focused Goal, apply that requested specification change with the Goal update action before debating feasibility. Do not substitute Goal creation, claim that user-owned specification edits are unavailable, or silently weaken the requested acceptance bar. Feasibility is established later through work, evidence, blockers, and verification.",
  "You are the Goal worker, not the independent Goal auditor. Never simulate the auditor or issue an auditor verdict. The host runs the auditor separately after worker cycles or an explicit verification request.",
  "The host already projects the current Goal specification and progress into context. Do not call Goal status merely to refresh state you already have, and never use Goal calls as heartbeat/bookkeeping after ordinary tool work.",
  "Call Goal mutation actions only when durable Goal state materially changes. Batch meaningful step/criterion progress and evidence instead of emitting a Goal call for every edit, command, or subtask.",
  "Do not call the Goal tool merely because a turn starts or ends. Goal Mode has one host-owned execution behavior: the host independently audits settled worker cycles and continues when the auditor authorizes more work, so request_verification is not a mandatory end-of-turn ritual.",
  "A genuine new user turn automatically reactivates a focused blocked Goal. Do not spend a Goal tool call trying to clear that lifecycle state before continuing the user's work.",
  "Do not claim Goal completion directly. Completion requires the verifying state, every criterion passed with evidence, then independent verification.",
  "If genuinely blocked by missing information, credentials, permissions, external state, or a user decision, record the blocker once instead of repeatedly polling or re-blocking.",
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
