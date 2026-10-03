import { Context, Effect, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Node } from "@opencode-ai/core/effect/app-node"
import type { GoalAgent } from "@opencode-ai/core/goal/agent"
import type { OxpRuntimeV1 } from "./runtime-v1"
import type { SessionTodo } from "@opencode-ai/schema/session-todo"
import type { Parameters as CheckpointParameters } from "@/tool/checkpoint"

export type Target = OxpRuntimeV1.SessionTarget

export interface ModelSelection {
  readonly providerID: string
  readonly modelID: string
  readonly accountID?: string
  readonly variant?: string
}

export interface SelectionInput {
  readonly model: ModelSelection
  readonly actorRef: string
}

export interface PromptInput {
  readonly text: string
  readonly actorRef: string
}

export interface PromptResult {
  readonly admittedMessageID: string
  readonly paused: boolean
  readonly resultMessageID?: string
}

export interface BackgroundSubagentsResult {
  readonly promoted: number
}

export type CheckpointInput = Schema.Schema.Type<typeof CheckpointParameters>

export interface CheckpointResult {
  readonly title: string
  readonly output: string
  readonly metadata: Record<string, unknown>
}

export class WaitCancelled extends Error {
  override readonly name = "OxpSessionWaitCancelled"
  constructor(readonly admittedMessageID: string) {
    super("OXP Session turn was admitted and continues, but the caller stopped waiting")
  }
}

export class SelectionUnavailable extends Error {
  override readonly name = "OxpSessionSelectionUnavailable"
  constructor(
    readonly kind: "model" | "provider-account" | "agent",
    message: string,
  ) {
    super(message)
  }
}

export class GoalRevisionConflict extends Error {
  override readonly name = "OxpSessionGoalRevisionConflict"
  constructor(
    readonly goalID: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Goal ${goalID} revision changed from ${expectedRevision} to ${actualRevision}`)
  }
}

export class GoalVerificationUnavailable extends Error {
  override readonly name = "OxpSessionGoalVerificationUnavailable"
  constructor(
    readonly goalID: string,
    readonly status: string,
  ) {
    super(`Goal ${goalID} cannot request verification while ${status}`)
  }
}

export class HostOwned extends Error {
  override readonly name = "OxpSessionHostOwned"
  constructor(
    readonly sessionID: string,
    readonly parentID: string,
    readonly kind: string,
  ) {
    super(`Session ${sessionID} is owned by the host producer ${kind}`)
  }
}

export interface Interface {
  readonly pause: (target: Target) => Effect.Effect<void, Error>
  readonly resume: (target: Target) => Effect.Effect<void, Error>
  readonly abort: (target: Target) => Effect.Effect<void, Error>
  readonly archive: (target: Target) => Effect.Effect<void, Error>
  readonly unarchive: (target: Target) => Effect.Effect<void, Error>
  readonly delete: (target: Target) => Effect.Effect<void, Error>
  readonly setSelection: (target: Target, input: SelectionInput) => Effect.Effect<void, Error>
  readonly send: (target: Target, input: PromptInput) => Effect.Effect<PromptResult, Error>
  readonly turn: (
    target: Target,
    input: PromptInput,
    signal?: AbortSignal,
  ) => Effect.Effect<PromptResult, Error>
  readonly backgroundSubagents: (
    target: Target,
  ) => Effect.Effect<BackgroundSubagentsResult, Error>
  readonly todoGet: (target: Target) => Effect.Effect<readonly SessionTodo.Info[], Error>
  readonly todoSet: (
    target: Target,
    todos: readonly SessionTodo.Info[],
  ) => Effect.Effect<readonly SessionTodo.Info[], Error>
  readonly checkpoint: (
    target: Target,
    input: CheckpointInput,
  ) => Effect.Effect<CheckpointResult, Error>
  readonly goal: (
    target: Target,
    input: GoalAgent.Input,
  ) => Effect.Effect<GoalAgent.Output, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpSessionRuntimeControl") {}

/**
 * Tier-3 host port. OXP's durable Session read plane depends only on this
 * interface, never on InstanceStore/SessionPrompt directly. The sidecar host
 * supplies the V1 implementation at composition time.
 */
export const node = LayerNode.unbound(Service, Node.tags.values.global)

export * as OxpSessionControl from "./session-control"
