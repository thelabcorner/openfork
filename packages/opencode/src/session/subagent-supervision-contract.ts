import { Context, type Effect } from "effect"

/**
 * Narrow capability seam between Task delegation (this worker) and the
 * supervision runtime (Worker 4).
 *
 * Task delegation only needs to announce lifecycle transitions for supervised
 * children. The full supervision service (event coalescing, parent wakeups,
 * cohort snapshots, blocker classification) is owned by
 * `packages/opencode/src/session/subagent-supervision.ts`, which provides the
 * layer implementing `SupervisorRegistryTag`.
 *
 * Delegation consumes this via `Effect.serviceOption`, so the Task tool
 * compiles and behaves correctly even when no supervision service is present.
 */
export interface SupervisorRegistration {
  readonly supervisorSessionID: string
  readonly childSessionID: string
  readonly supervisionGroupID: string
  readonly mode: "supervisor"
  readonly description: string
  readonly createdFromMessageID: string
}

export interface SupervisorRelinquish {
  readonly childSessionID: string
}

export interface SupervisorRegistry {
  /** Establish (or adopt) active supervision ownership of a detached child. */
  readonly register: (input: SupervisorRegistration) => Effect.Effect<void>
  /** Drop active supervision ownership without stopping the child worker. */
  readonly unregister: (childSessionID: string) => Effect.Effect<void>
  /** Adopt an already-running background/child worker into supervision. */
  readonly adopt: (input: SupervisorRegistration) => Effect.Effect<void>
  /** Relinquish supervision while leaving the worker detached. */
  readonly relinquish: (input: SupervisorRelinquish) => Effect.Effect<void>
}

/**
 * Service tag. Worker 4 provides the implementation layer:
 *
 *   export const node = LayerNode.make({ service: SupervisorRegistryTag, layer, deps: [...] })
 *
 * Delegation resolves it optionally and degrades to a no-op when absent.
 */
export const SupervisorRegistryTag = Context.Service<SupervisorRegistry>("@opencode/SubagentSupervision")

export * as SubagentSupervisionContract from "./subagent-supervision-contract"
