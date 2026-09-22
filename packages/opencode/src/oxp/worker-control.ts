import { Context, Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Node } from "@opencode-ai/core/effect/app-node"
import type { OxpRuntimeV1 } from "./runtime-v1"

export type Target = OxpRuntimeV1.Target

export interface ModelSelection {
  readonly providerID: string
  readonly modelID: string
  readonly accountID?: string
  readonly variant?: string
}

export interface Identity {
  readonly producer: "oxp"
  readonly principalRef: string
}

export interface Origin extends Identity {
  readonly invocationRef: string
  readonly rootRef: string
  readonly agent: string
  readonly model: ModelSelection
  readonly nestedDelegation: boolean
  readonly parentWorkerID?: string
}

export interface StartInput {
  readonly title: string
  readonly prompt: string
  readonly agent: string
  readonly model: ModelSelection
  readonly origin: Origin
}

export interface ContinueInput {
  readonly workerID: string
  readonly prompt: string
  readonly identity: Identity
  readonly invocationRef: string
  readonly nestedDelegation: boolean
  readonly expectedModel?: ModelSelection
  readonly expectedAgent?: string
}

export interface SetSelectionInput {
  readonly workerID: string
  readonly identity: Identity
  readonly model: ModelSelection
  readonly expectedModel?: ModelSelection
}

export type State =
  | "running"
  | "completed"
  | "error"
  | "cancelled"
  | "recoverable"
  | "idle"

export interface Snapshot {
  readonly workerID: string
  readonly state: State
  readonly generation?: number
  readonly result?: string
  readonly error?: string
  readonly startedAt?: number
  readonly completedAt?: number
  readonly recovered: boolean
}

export interface SelectionChange {
  readonly workerID: string
  readonly previousModel: ModelSelection
  readonly model: ModelSelection
  readonly changed: boolean
  readonly state: State
  readonly generation?: number
}

export interface BatchStartInput {
  readonly name: string
  readonly ownerRef: string
  readonly workers: readonly StartInput[]
}

export interface BatchStartResult {
  readonly batchID: string
  readonly workerIDs: readonly string[]
}

export class InvalidWorker extends Error {
  override readonly name = "OxpDelegatedWorkerInvalid"
  constructor(message = "Delegated worker is unavailable to this OXP principal") {
    super(message)
  }
}

export class SelectionUnavailable extends Error {
  override readonly name = "OxpDelegatedWorkerSelectionUnavailable"
  constructor(
    readonly explicitAccount: boolean,
    message: string,
  ) {
    super(message)
  }
}

export class StartCommitted extends Error {
  override readonly name = "OxpDelegatedWorkerStartCommitted"
  constructor(
    readonly workerID: string,
    message = "Delegated worker Session committed before execution setup failed",
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
  }
}

export class ContinueCommitted extends Error {
  override readonly name = "OxpDelegatedWorkerContinueCommitted"
  constructor(
    readonly workerID: string,
    message = "Delegated worker continuation committed before execution setup failed",
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
  }
}

export class BatchCommitted extends Error {
  override readonly name = "OxpDelegatedBatchCommitted"
  constructor(
    readonly workerIDs: readonly string[],
    readonly batchID?: string,
    message = "Delegated batch mutation partially committed before failure",
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
  }
}

export interface Interface {
  readonly resolveSelection: (
    target: Target,
    input: {
      readonly agent?: string
      readonly model?: ModelSelection
    },
  ) => Effect.Effect<
    { readonly agent: string; readonly model: ModelSelection },
    Error
  >
  readonly start: (
    target: Target,
    input: StartInput,
  ) => Effect.Effect<{ readonly workerID: string }, Error>
  readonly continue: (
    target: Target,
    input: ContinueInput,
  ) => Effect.Effect<Snapshot, Error>
  readonly setSelection: (
    target: Target,
    input: SetSelectionInput,
  ) => Effect.Effect<SelectionChange, Error>
  readonly wait: (
    target: Target,
    input: {
      readonly workerID: string
      readonly identity: Identity
      readonly timeoutMs?: number
    },
  ) => Effect.Effect<Snapshot, Error>
  readonly result: (
    target: Target,
    input: {
      readonly workerID: string
      readonly identity: Identity
    },
  ) => Effect.Effect<Snapshot, Error>
  readonly cancel: (
    target: Target,
    input: {
      readonly workerID: string
      readonly identity: Identity
    },
  ) => Effect.Effect<Snapshot, Error>
  readonly batchStart: (
    target: Target,
    input: BatchStartInput,
  ) => Effect.Effect<BatchStartResult, Error>
  readonly batchContinue: (
    target: Target,
    input: {
      readonly identity: Identity
      readonly items: readonly ContinueInput[]
    },
  ) => Effect.Effect<readonly Snapshot[], Error>
  readonly batchWait: (
    target: Target,
    input: {
      readonly identity: Identity
      readonly workerIDs: readonly string[]
      readonly timeoutMs?: number
    },
  ) => Effect.Effect<readonly Snapshot[], Error>
  readonly batchCancel: (
    target: Target,
    input: {
      readonly identity: Identity
      readonly workerIDs: readonly string[]
    },
  ) => Effect.Effect<readonly Snapshot[], Error>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/OxpWorkerRuntimeControl",
) {}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

export * as OxpWorkerControl from "./worker-control"
