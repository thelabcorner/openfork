import { Context, Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Node } from "@opencode-ai/core/effect/app-node"
import type { OxpRuntimeV1 } from "./runtime-v1"

export type Target = OxpRuntimeV1.SessionTarget
export type PermissionReply = "once" | "always" | "reject"

export interface PermissionRequest {
  readonly type: "permission"
  readonly id: string
  readonly permission: string
  readonly patterns: readonly string[]
  readonly externalDirectory: boolean
  readonly tool?: {
    readonly messageID: string
    readonly callID: string
  }
}

export interface QuestionRequest {
  readonly type: "question"
  readonly id: string
  readonly questions: readonly {
    readonly question: string
    readonly header: string
    readonly options: readonly {
      readonly label: string
      readonly description: string
    }[]
    readonly multiple?: boolean
    readonly custom?: boolean
  }[]
  readonly tool?: {
    readonly messageID: string
    readonly callID: string
  }
}

export interface Snapshot {
  readonly permissions: readonly PermissionRequest[]
  readonly questions: readonly QuestionRequest[]
}

export class RequestNotFound extends Error {
  override readonly name = "OxpNativeRequestNotFound"
  constructor() {
    super("Native Session request is not available to OXP supervision")
  }
}

export class ExternalDirectoryBlocked extends Error {
  override readonly name = "OxpExternalDirectoryBlocked"
  constructor() {
    super(
      "OXP cannot approve a native external_directory request outside the approved root boundary",
    )
  }
}

export interface Interface {
  readonly list: (target: Target) => Effect.Effect<Snapshot, Error>
  readonly replyPermission: (
    target: Target,
    input: {
      readonly requestID: string
      readonly reply: PermissionReply
      readonly message?: string
      readonly actorRef: string
    },
  ) => Effect.Effect<void, Error>
  readonly answerQuestion: (
    target: Target,
    input: {
      readonly requestID: string
      readonly answers: readonly (readonly string[])[]
      readonly details?: readonly string[]
      readonly actorRef: string
    },
  ) => Effect.Effect<void, Error>
  readonly rejectQuestion: (
    target: Target,
    input: {
      readonly requestID: string
      readonly actorRef: string
    },
  ) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/OxpRequestRuntimeControl",
) {}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

export * as OxpRequestControl from "./request-control"
