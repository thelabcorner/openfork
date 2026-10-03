export * as Agent from "./agent"

import { Schema } from "effect"
import { optional } from "./schema"
import { Model } from "./model"
import { Permission } from "./permission"
import { Provider } from "./provider"
import { PositiveInt, statics } from "./schema"

export const ID = Schema.String.pipe(Schema.brand("AgentV2.ID"))
export type ID = typeof ID.Type

export const Mode = Schema.Literals(["subagent", "primary", "all"]).annotate({ identifier: "Agent.Mode" })
export type Mode = typeof Mode.Type

/**
 * Shipped built-in agent identity and default exposure topology.
 *
 * This is the single shared definition of which built-ins ship and their
 * default `mode`/`hidden` values. The V1 runtime seeds its native catalog from
 * this table, while normal config overrides may still change effective
 * exposure afterward; presentation code that needs current availability must
 * therefore consume the resolved runtime catalog rather than re-deriving it
 * from these defaults.
 *
 * Shipped defaults never use `"all"`: each built-in starts single-purpose,
 * while user-defined/configured overrides remain an explicit runtime choice.
 */
export interface BuiltIn {
  readonly id: string
  readonly mode: Exclude<Mode, "all">
  readonly hidden: boolean
}

export const BuiltInTopology: readonly BuiltIn[] = [
  { id: "build", mode: "primary", hidden: false },
  { id: "plan", mode: "primary", hidden: false },
  { id: "yolo", mode: "primary", hidden: false },
  { id: "general", mode: "subagent", hidden: false },
  { id: "explore", mode: "subagent", hidden: false },
  { id: "compaction", mode: "primary", hidden: true },
  { id: "title", mode: "primary", hidden: true },
  { id: "prompt-revisor", mode: "primary", hidden: true },
  { id: "summary", mode: "primary", hidden: true },
] as const

export function builtIn(id: string): BuiltIn | undefined {
  return BuiltInTopology.find((entry) => entry.id === id)
}

export function isBuiltInID(id: string): boolean {
  return builtIn(id) !== undefined
}

/**
 * Where a catalogued agent can actually be reached.
 *
 * `mode` is the capability knob and is the same value the host enforces when a
 * delegation starts: `SubagentDelegation` refuses a `primary` agent outright, so
 * a `primary` agent is composer-only and cannot be @mentioned or delegated even
 * if a model names it directly.
 *
 * `hidden` is discoverability only. It removes an agent from the composer and
 * @mention lists but never affects `delegation`, because the Task tool resolves
 * `subagent_type` against the catalog by exact name rather than through a
 * discoverable list.
 */
export interface Exposure {
  readonly composer: boolean
  readonly mention: boolean
  readonly delegation: boolean
}

export function exposure(input: { mode: Mode; hidden: boolean }): Exposure {
  return {
    composer: input.mode !== "subagent" && !input.hidden,
    mention: input.mode !== "primary" && !input.hidden,
    delegation: input.mode !== "primary",
  }
}

export const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
]).annotate({ identifier: "Agent.Color" })
export type Color = typeof Color.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  model: Model.Ref.pipe(optional),
  request: Provider.Request,
  system: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  mode: Mode,
  hidden: Schema.Boolean,
  color: Color.pipe(optional),
  steps: PositiveInt.pipe(optional),
  permissions: Permission.Ruleset,
})
  .annotate({ identifier: "AgentV2.Info" })
  .pipe(
    statics((schema) => ({
      empty: (id: ID) =>
        schema.make({ id, request: { headers: {}, body: {} }, mode: "all", hidden: false, permissions: [] }),
    })),
  )
