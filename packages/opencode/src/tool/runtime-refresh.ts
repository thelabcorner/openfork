import { Effect, Schema } from "effect"
import { MAX_ACCEPT_WITHIN_MS, MIN_ACCEPT_WITHIN_MS, OxpRuntimeRefresh } from "@/oxp/runtime-refresh"
import * as Tool from "./tool"

type Metadata = {
  action: string
  state?: string
  changed?: boolean
  trialID?: string
  runtimeID?: string
}

const RuntimeID = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const TrialID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const AcceptWithinMs = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(MIN_ACCEPT_WITHIN_MS),
  Schema.isLessThanOrEqualTo(MAX_ACCEPT_WITHIN_MS),
)

const Parameters = Schema.Struct({
  action: Schema.Literals(["status", "refresh", "accept", "rollback"]).annotate({
    description:
      "status reads the host runtime-refresh state; refresh stages a trial of the artifact already built into this backend; accept keeps the activated candidate; rollback restores the previous backend.",
  }),
  expectedRuntimeID: Schema.optional(RuntimeID).annotate({
    description: "refresh: the exact runtimeID from a prior status call; a stale observation fails closed.",
  }),
  trialID: Schema.optional(TrialID).annotate({
    description: "accept/rollback: the trial id from status after a staged refresh.",
  }),
  acceptWithinMs: Schema.optional(AcceptWithinMs).annotate({
    description: "refresh: acceptance window before automatic rollback (default 120000; 15000-300000).",
  }),
})

/**
 * Local exposure of the desktop host's transactional runtime-refresh owner.
 *
 * This drives the same controller the OXP `runtime.refresh` capability uses:
 * it swaps serving to the artifact already built into this host through the
 * host-owned HTTP backend transition. It fails closed when no host controller
 * is installed (for example a bare CLI server), and it never rebuilds the
 * artifact itself - a stale build stays stale until the sidecar is rebuilt.
 */
export const RuntimeRefreshTool = Tool.define<typeof Parameters, Metadata, never>(
  "runtime_refresh",
  Effect.gen(function* () {
    return {
      description: [
        "Transactional runtime refresh for the running OpenFork backend.",
        "status reports whether this host installed a refresh controller plus the current runtime and trial state.",
        "refresh starts a trial of the backend artifact already built into this host; the desktop host transitions HTTP serving to the candidate and auto-acknowledges the published candidate state, while the previous backend is restored automatically if the trial is not accepted before acceptWithinMs.",
        "accept/rollback resolve a staged trial by id.",
        "This surface fails closed when the host has no refresh controller. It activates an existing build only; rebuild the sidecar artifact first with bun script/build-node.ts when source changed.",
      ].join(" "),
      parameters: Parameters,
      execute: (input, ctx) =>
        Effect.gen(function* () {
          const resource = `runtime:${input.action}`
          yield* ctx.ask({
            permission: "runtime.refresh",
            patterns: [resource],
            always: [resource],
            metadata: { action: input.action, resource },
          })

          if (input.action === "status") {
            const status = yield* Effect.promise(() => OxpRuntimeRefresh.status())
            const metadata: Metadata = {
              action: input.action,
              state: status.state,
              ...(status.runtimeID === undefined ? {} : { runtimeID: status.runtimeID }),
              ...(status.trial === undefined ? {} : { trialID: status.trial.id }),
            }
            return { title: `Runtime ${status.state}`, output: JSON.stringify(status, null, 2), metadata }
          }

          const params: OxpRuntimeRefresh.Input = {
            action: input.action,
            ...(input.expectedRuntimeID === undefined ? {} : { expectedRuntimeID: input.expectedRuntimeID }),
            ...(input.trialID === undefined ? {} : { trialID: input.trialID }),
            ...(input.acceptWithinMs === undefined ? {} : { acceptWithinMs: input.acceptWithinMs }),
          }
          const refreshed = yield* OxpRuntimeRefresh.execute(params).pipe(
            Effect.mapError((error) => new Error(error.message)),
          )

          // The OXP host arms a scheduled v2 trial only after the response that
          // scheduled it has egressed. A native tool call has no separate OXP
          // response to protect, and the desktop host stays alive across the
          // HTTP backend transition, so arm immediately instead of leaving the
          // trial to expire unarmed.
          if (refreshed.afterResponse) yield* Effect.promise(() => Promise.resolve(refreshed.afterResponse!()))

          const result = refreshed.structured as OxpRuntimeRefresh.RuntimeMutationResult | undefined
          const metadata: Metadata = {
            action: input.action,
            ...(result === undefined ? {} : { changed: result.changed, state: result.status.state }),
            ...(result?.status.runtimeID === undefined ? {} : { runtimeID: result.status.runtimeID }),
            ...(result?.status.trial === undefined ? {} : { trialID: result.status.trial.id }),
          }
          return { title: refreshed.title ?? `Runtime ${input.action}`, output: refreshed.output, metadata }
        }),
    }
  }),
)
