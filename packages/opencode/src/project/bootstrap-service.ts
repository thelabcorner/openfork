import { Context, Effect } from "effect"

export interface Interface {
  /**
   * Fast, request-gating half (config + plugin + toolReload). InstanceStore
   * unblocks queued instance loads as soon as this completes; handlers may run
   * before `warmup` finishes. Keep it fast — nothing speculative belongs here.
   */
  readonly gate: Effect.Effect<void>
  /**
   * Non-gating half: eager per-service materialization (lsp/shareNext/format/
   * vcs/snapshot/project). Services also materialize lazily via
   * `InstanceState.get` on first use (single-flighted by ScopedCache), so a
   * slow init here delays warm caches, never requests.
   */
  readonly warmup: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceBootstrap") {}

export * as InstanceBootstrap from "./bootstrap-service"
