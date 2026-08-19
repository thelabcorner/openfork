export * as BrokerClient from "./broker-client"

import { BrowserHostBroker, BrowserOperationFailedError, type BrowserErrorClass } from "@opencode-ai/core/browser/host-broker"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Session } from "@/session/session"
import type { MessageID, SessionID } from "@/session/schema"
import {
  OperationOutput,
  toBrowserError,
  type OperationInputOf,
  type OperationName,
  type OperationOutputOf,
} from "./shared"

/**
 * BrokerClient — the sidecar (agent-loop) side of the BrowserHostBroker.
 *
 * Builds a typed `BrokerRequest` from a tool invocation (resolving the
 * session's workspace/directory for the stickiness key and forwarding the
 * tool's abort signal), dispatches it through the core `BrowserHostBroker`
 * service, and returns the operation's success object validated against the
 * per-operation output schema. A payload error arm (or a broker-detected
 * transport/control failure) is mapped onto a typed `BrowserErrorClass` with
 * model-facing prose — never a raw exception.
 */

export interface RunInput<Name extends OperationName = OperationName> {
  readonly sessionID: SessionID
  readonly messageID: MessageID
  readonly toolCallID?: string
  /** Optional: the broker is authoritative for tab defaulting — when omitted it
   * resolves the session's most-recently-active owned tab (or fast-fails with
   * BrowserTabNotFound), and fills `tabId` on the forwarded envelope. */
  readonly tabId?: string
  readonly operation: Name
  readonly input: OperationInputOf<Name>
  readonly timeoutMs: number
  readonly abort: AbortSignal
}

export interface RunSuccess<Name extends OperationName> {
  readonly requestId: string
  readonly result: OperationOutputOf<Name>
  readonly elapsedMs: number
  readonly snapshotAfter?: BrowserHostBroker.SnapshotRef
}

export interface Interface {
  readonly run: <Name extends OperationName>(
    input: RunInput<Name>,
  ) => Effect.Effect<RunSuccess<Name>, BrowserErrorClass>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BrokerClient") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const broker = yield* BrowserHostBroker.Service
    const session = yield* Session.Service

    const run = Effect.fn("BrokerClient.run")(function* <Name extends OperationName>(input: RunInput<Name>) {
      // Resolve the session's location so the broker can compute the stickiness
      // key (`${sessionID}@${workspaceID ?? sha1(directory)}#${windowID}`).
      const info = yield* session.get(input.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const workspaceId = info?.workspaceID
      const directory = info?.directory

      const response = yield* broker.dispatch(
        {
          sessionId: input.sessionID,
          ...(workspaceId ? { workspaceId } : {}),
          ...(directory ? { directory } : {}),
          messageId: input.messageID,
          ...(input.toolCallID ? { toolCallId: input.toolCallID } : {}),
          ...(input.tabId ? { tabId: input.tabId } : {}),
          operation: { name: input.operation, input: input.input },
          timeoutMs: input.timeoutMs,
        },
        // Abort propagation: the broker races the forward against this signal,
        // fires the host's abort endpoint and fails with BrowserControlInterrupted.
        { signal: input.abort },
      )

      if (!response.ok) return yield* Effect.fail(toBrowserError(response.error))

      // Cast erases the schema's DecodingServices requirement (suspended A11yNode
      // schemas are not statically never) — runtime decoding is unchanged.
      const result = yield* Schema.decodeUnknownEffect(OperationOutput[input.operation] as Schema.Decoder<unknown, never>)(
        response.result,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new BrowserOperationFailedError({
              message: `The browser host returned a result for ${input.operation} that does not match the expected schema: ${String(cause)}`,
              retryable: true,
              details: String(cause),
            }),
        ),
        // The generic indexed decode's inferred Type is a distinct (but identical)
        // declaration from OperationOutputOf under tsgo; pin it with the canonical alias.
        Effect.map((value) => value as OperationOutputOf<Name>),
      )
      return {
        requestId: response.requestId,
        result,
        elapsedMs: response.elapsedMs,
        snapshotAfter: response.snapshotAfter,
      }
    })

    return Service.of({ run })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [BrowserHostBroker.node, Session.node],
})
