/**
 * LACE v14.7 optional V1 native request observer.
 *
 * Calls the existing LLMClient.compile EXACTLY ONCE, then observes the
 * already-produced provider-native body. The returned stream uses that exact
 * prepared request; observation never influences provider dispatch.
 *
 * The OpenFork session owner supplies trusted scope; no auth/session IDs are
 * reconstructed from HTTP headers and no raw prompts are persisted.
 *
 * This is a candidate adapter, not activated in Session LLM dispatch.
 */
import type { LLMRequest } from "@opencode-ai/llm"
import type { LLMClientShape } from "@opencode-ai/llm/route"
import {
  createRequestWitnessObserver,
  type WitnessObservation,
  type WitnessProtocol,
  type CompiledRequestInput,
} from "@opencode-ai/llm/cache-request-witness"
import { Effect } from "effect"

export interface LaceNativeOwner {
  readonly owner: string
  readonly session: string
}

export type LaceCompileObservation =
  | { readonly status: "observed"; readonly observation: WitnessObservation }
  | { readonly status: "unsupported-protocol" | "invalid-identity" | "observation-unavailable" }

const knownProtocol = (value: string): value is WitnessProtocol =>
  value === "openai-responses" || value === "openai-chat" || value === "anthropic-messages"

export function createLaceNativeObserver(capacity = 128) {
  const observer = createRequestWitnessObserver(capacity)
  return {
    /** Read-only wrapper around the existing single request compilation. */
    compile: <Body = unknown>(
      client: LLMClientShape,
      request: LLMRequest,
      owner: LaceNativeOwner,
    ) =>
      Effect.gen(function* () {
        const compiled = yield* client.compile<Body>(request)
        const p = compiled.prepared
        let outcome: LaceCompileObservation
        // Fail OPEN only for telemetry: invalid scope MUST NOT cause the
        // observer to hash or retain a value under a synthetic owner.
        if (!owner.owner || !owner.session) {
          outcome = { status: "invalid-identity" }
        } else if (!knownProtocol(p.protocol)) {
          outcome = { status: "unsupported-protocol" }
        } else {
          try {
            // Source provider/model/route from the actual compiled request.
            // Session/workspace/account authority must come from V1.
            const observation = observer.observe({
              owner: owner.owner,
              session: owner.session,
              provider: String(p.model.provider),
              model: String(p.model.id),
              runtime: "native",
              route: p.route,
              protocol: p.protocol,
              body: p.body as Record<string, unknown>,
            } satisfies CompiledRequestInput)
            outcome = { status: "observed", observation }
          } catch {
            outcome = { status: "observation-unavailable" }
          }
        }
        return { ...compiled, lace: outcome }
      }),
    count: observer.size,
    clear: observer.clear,
  }
}

export * as LaceNativeObserver from "./lace-native-observer"
