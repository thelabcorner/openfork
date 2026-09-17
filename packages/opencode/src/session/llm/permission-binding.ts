import type { Effect } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { EffectBridge } from "@/effect/bridge"

export interface Askable {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
}

/**
 * Bind a permission service to the instance/workspace context captured by an
 * EffectBridge.
 *
 * The Claude runtime executes permission checks from plain async SDK
 * callbacks, so a bare `Effect.runPromise(permission.ask(...))` runs with an
 * empty context. `Permission.Service.ask` resolves per-directory state through
 * `InstanceState`, whose `InstanceRef` then defaults to `undefined` and dies
 * before any ruleset is evaluated. The bridge restores the caller's instance
 * context so the ask can actually evaluate and reach the user instead of being
 * misreported as a denial.
 */
export function bindPermission(permission: Askable, bridge: EffectBridge.Shape): Askable {
  return {
    ask: (input) => bridge.run(permission.ask(input)),
  }
}

export * as PermissionBinding from "./permission-binding"
