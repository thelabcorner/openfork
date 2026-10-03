import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { MessageV2 } from "../session/message-v2"
import type { Permission } from "../permission"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { ToolExposure } from "./exposure"
import type { Agent } from "@/agent/agent"

interface Metadata {
  [key: string]: any
}

// TODO: remove this hack
export type DynamicDescription = (agent: Agent.Info) => Effect.Effect<string>

/**
 * Raised when the LLM calls a tool with arguments that fail the parameter
 * schema. This is the canonical "rewrite the input" tool error: the typed
 * error class makes it matchable upstream, and its `message` getter produces
 * the model-facing prose that the AI SDK feeds back as the tool result.
 */
export class InvalidArgumentsError extends Schema.TaggedErrorClass<InvalidArgumentsError>()(
  "ToolInvalidArgumentsError",
  {
    tool: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return `The ${this.tool} tool was called with invalid arguments: ${this.detail}.\nPlease rewrite the input so it satisfies the expected schema.`
  }
}

export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: unknown }
  messages: SessionV1.WithParts[]
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
  ask(input: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">): Effect.Effect<void>
}

/**
 * Expected tool failure: an operation that legitimately refuses, is denied, or
 * cannot complete. It is recoverable and provider-visible, so it must survive
 * from the leaf all the way to provider delivery instead of being erased or
 * promoted to a defect on the way. Genuine defects stay in the defect channel
 * and are deliberately not typed here.
 */
export type Failure = unknown

export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  /**
   * Structured semantic payload for host/internal composition. `output` remains
   * the only provider projection, so this value is never model-facing text and
   * is deliberately exempt from the harness-owned `tool_output` bound.
   */
  data?: unknown
  attachments?: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[]
}

/**
 * Raw semantic invocation of one tool: decoded input -> typed expected failure
 * -> structured result. It performs no provider projection and no `orDie`, so
 * an internal caller keeps both the leaf's expected failure channel and its
 * structured payload intact. This is the seam the capability invocation
 * gateway calls; `Def.execute` is derived from it rather than replacing it.
 */
export type SemanticInvoke<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> = (args: Schema.Schema.Type<Parameters>, ctx: Context) => Effect.Effect<ExecuteResult<M>, Failure>

/**
 * Authoring shape: what a tool module declares. Expected failures are erased at
 * the type level on purpose in the old shape; here they are part of the
 * contract, and provider delivery is the layer that turns them into defects.
 */
export interface DefWithoutID<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  description: string
  parameters: Parameters
  jsonSchema?: JSONSchema7
  /**
   * Provider exposure policy. Lazy tools remain registered internally but are
   * omitted from the provider tool manifest and reached through the stable
   * `tool` broker instead. This avoids invalidating prompt/tool-prefix caches
   * merely because a low-frequency capability is needed mid-conversation.
   */
  exposure?: "default" | "lazy"
  execute(args: Schema.Schema.Type<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>, Failure>
  formatValidationError?(error: unknown): string
}

/**
 * A tool definition as consumed by the provider/tool loop. `execute` is
 * provider delivery: the semantic result projected through the harness-owned
 * model-facing bound and then turned into a defect. Behavior here is unchanged.
 */
export interface Def<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> extends Omit<DefWithoutID<Parameters, M>, "execute"> {
  id: string
  execute(args: Schema.Schema.Type<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>>
}

/**
 * A `Tool.init`-produced definition. The semantic executor is structurally
 * present rather than optionally probed, so an internal caller cannot silently
 * fall back to provider delivery and lose truncation/exit-gate authority.
 * Raw hand-built `Tool.Def` values (the lazy broker, plugin tools) have no
 * semantic seam until their owner adopts one.
 */
export interface InitializedDef<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> extends Def<Parameters, M> {
  semantic: SemanticInvoke<Parameters, M>
}

export interface Info<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  init: () => Effect.Effect<InitializedDef<Parameters, M>>
}

type Init<Parameters extends Schema.Decoder<unknown>, M extends Metadata> =
  | DefWithoutID<Parameters, M>
  | (() => Effect.Effect<DefWithoutID<Parameters, M>>)

export type InferParameters<T> =
  T extends Info<infer P, any>
    ? Schema.Schema.Type<P>
    : T extends Effect.Effect<Info<infer P, any>, any, any>
      ? Schema.Schema.Type<P>
      : never
export type InferMetadata<T> =
  T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

export type InferDef<T> =
  T extends Info<infer P, infer M>
    ? Def<P, M>
    : T extends Effect.Effect<Info<infer P, infer M>, any, any>
      ? Def<P, M>
      : never

function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadata>(
  id: string,
  init: Init<Parameters, Result>,
  truncate: Truncate.Interface,
) {
  return () =>
    Effect.gen(function* () {
      const toolInfo = (typeof init === "function" ? { ...(yield* init()) } : { ...init }) as DefWithoutID<
        Parameters,
        Result
      >
      // Builtin lazy exposure is fork-owned policy, not a per-adapter guess.
      // Explicit custom/tool-local exposure remains valid; the shared policy
      // guarantees known builtin lazy tools cannot accidentally become eager.
      toolInfo.exposure ??= ToolExposure.lazyExposure(id)
      // Compile the parser closure once per tool init; `decodeUnknownEffect`
      // allocates a new closure per call, so hoisting avoids re-closing it for
      // every LLM tool invocation.
      const decode = Schema.decodeUnknownEffect(toolInfo.parameters)
      const execute = toolInfo.execute
      const formatValidationError = toolInfo.formatValidationError

      // The single decoded-input boundary, and the only place a tool's raw
      // semantics exist. No truncation and no `orDie`: an expected failure stays
      // an expected failure, and `data` stays structured.
      const semantic: SemanticInvoke<Parameters, Result> = (args, ctx) =>
        Effect.gen(function* () {
          const decoded = yield* decode(args).pipe(
            Effect.mapError(
              (error) =>
                new InvalidArgumentsError({
                  tool: id,
                  detail: formatValidationError ? formatValidationError(error) : String(error),
                }),
            ),
          )
          return yield* execute(decoded as Schema.Schema.Type<Parameters>, ctx)
        })

      return {
        ...toolInfo,
        id,
        semantic,
        // Provider delivery derives from the same semantic executor, so the
        // harness-owned model-facing bound is applied exactly once, at the outer
        // boundary, no matter which entry point invoked the tool.
        execute: ((args: unknown, ctx: Context) => {
          const attrs = {
            "tool.name": id,
            "session.id": ctx.sessionID,
            "message.id": ctx.messageID,
            ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
          }
          return Effect.gen(function* () {
            const result = yield* semantic(args as Schema.Schema.Type<Parameters>, ctx)
            // Producer/domain truncation (for example grep hit caps or SQLite row
            // paging) is not authority to bypass the harness's final model-facing
            // output bound. Every tool result crosses this boundary exactly once.
            const projected = yield* truncate.output(result.output)
            return {
              ...result,
              output: projected.content,
              metadata: Truncate.mergeMetadata(result.metadata, projected),
            }
          }).pipe(Effect.orDie, Effect.withSpan("Tool.execute", { attributes: attrs }))
        }) as Def<Parameters, Result>["execute"],
      } satisfies InitializedDef<Parameters, Result>
    })
}

export function define<
  Parameters extends Schema.Decoder<unknown>,
  Result extends Metadata,
  R,
  ID extends string = string,
>(
  id: ID,
  init: Effect.Effect<Init<Parameters, Result>, never, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service> & { id: ID } {
  return Object.assign(
    Effect.gen(function* () {
      const resolved = yield* init
      const truncate = yield* Truncate.Service
      return { id, init: wrap(id, resolved, truncate) }
    }),
    { id },
  )
}

export function init<P extends Schema.Decoder<unknown>, M extends Metadata>(
  info: Info<P, M>,
): Effect.Effect<InitializedDef<P, M>> {
  return Effect.gen(function* () {
    const initialized = yield* info.init()
    return {
      ...initialized,
      id: info.id,
    }
  })
}

export * as Tool from "./tool"
