export * as SwarmProfilePreflight from "./profile-preflight"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { SwarmSchema } from "@opencode-ai/core/swarm/schema"
import { Swarm as SwarmModel } from "@opencode-ai/schema/swarm"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceRef } from "@/effect/instance-ref"
import { Provider } from "@/provider/provider"

type ProviderModel = Provider.Model

/**
 * Single owner of "can this managed-member execution profile actually run?".
 *
 * Two callers depend on this exact answer and must never disagree:
 *
 * 1. delegate creation, before the first durable Swarm write, so an invalid
 *    agent/provider/model/account/variant/requirement set leaves zero durable
 *    rows behind;
 * 2. managed member materialization, before a root Session exists, so a
 *    recovery pass cannot bind a worker the model cannot serve.
 *
 * Catalog resolution is workspace-owned (Tier 2). The check therefore runs
 * inside the caller's already-established workspace instance and verifies that
 * the explicit `directory` matches that instance rather than loading a second
 * one: there is deliberately no cwd fallback and no silent instance creation.
 *
 * It depends only on Agent/Provider and the pure `FSUtil.resolve` path helper,
 * never on InstanceStore or a FileSystem service, so it stays composable into
 * the tool registry (InstanceStore -> InstanceBootstrap -> ToolReload ->
 * ToolRegistry -> ... would otherwise be a layer cycle), and comparing two
 * directory spellings does not have to acquire a filesystem service.
 */
export interface CheckInput {
  /** Explicit workspace directory that owns the provider/model catalog. */
  readonly directory: string
  readonly profile: SwarmModel.MemberExecutionProfile
}

export interface Resolved {
  readonly model: ProviderModel
}

export function supportsModelRequirement(model: ProviderModel, requirement: SwarmModel.ModelRequirement) {
  switch (requirement) {
    case "toolcall":
      return model.capabilities.toolcall
    case "reasoning":
      return model.capabilities.reasoning
    case "attachment":
      return model.capabilities.attachment
    case "temperature":
      return model.capabilities.temperature
    case "input_text":
      return model.capabilities.input.text
    case "input_audio":
      return model.capabilities.input.audio
    case "input_image":
      return model.capabilities.input.image
    case "input_video":
      return model.capabilities.input.video
    case "input_pdf":
      return model.capabilities.input.pdf
    case "output_text":
      return model.capabilities.output.text
    case "output_audio":
      return model.capabilities.output.audio
    case "output_image":
      return model.capabilities.output.image
    case "output_video":
      return model.capabilities.output.video
    case "output_pdf":
      return model.capabilities.output.pdf
  }
}

export function unsupportedModelRequirements(
  model: ProviderModel,
  requested: readonly SwarmModel.ModelRequirement[] | undefined,
): SwarmModel.ModelRequirement[] {
  if (!requested?.length) return []
  return [...new Set(requested.filter((item) => !supportsModelRequirement(model, item)))]
}

export interface Interface {
  readonly check: (input: CheckInput) => Effect.Effect<Resolved, SwarmSchema.ValidationError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SwarmProfilePreflight") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const providers = yield* Provider.Service

    const check = Effect.fn("SwarmProfilePreflight.check")(function* (input: CheckInput) {
      const profile = input.profile
      return yield* Effect.gen(function* () {
        const instance = yield* InstanceRef
        if (!instance) {
          return yield* new SwarmSchema.ValidationError({
            reason: "Execution-profile preflight requires an explicit workspace instance context.",
          })
        }
        // Realpath+normalize both sides so a symlinked or differently-spelled
        // path for the same workspace cannot masquerade as another catalog
        // owner. `FSUtil.resolve` throws instead of failing typed, so convert
        // here: an unresolvable workspace must stay a structured refusal.
        const { scoped, requested } = yield* Effect.try({
          try: () => ({
            scoped: FSUtil.resolve(instance.directory),
            requested: FSUtil.resolve(input.directory),
          }),
          catch: (error) =>
            new SwarmSchema.ValidationError({
              reason: `Execution-profile preflight could not resolve the workspace directory: ${
                error instanceof Error ? error.message : String(error)
              }`,
            }),
        })
        if (scoped !== requested) {
          return yield* new SwarmSchema.ValidationError({
            reason: `Execution-profile preflight resolved the provider catalog in ${scoped}, not the requested workspace ${requested}.`,
          })
        }
        const agent = yield* agents.get(profile.agent)
        if (!agent) return yield* new SwarmSchema.ValidationError({ reason: `Agent not found: ${profile.agent}` })

        const model = yield* providers
          .getModel(profile.model.providerID, profile.model.id, profile.model.accountID)
          .pipe(
            Effect.mapError(
              (error) =>
                new SwarmSchema.ValidationError({
                  reason:
                    `Model ${profile.model.providerID}/${profile.model.id}` +
                    (profile.model.accountID === undefined ? "" : ` (account ${profile.model.accountID})`) +
                    ` does not resolve: ${error.message}`,
                }),
            ),
          )

        const variant = profile.model.variant
        if (variant && variant !== "default" && !model.variants?.[variant]) {
          return yield* new SwarmSchema.ValidationError({
            reason: `Model ${profile.model.providerID}/${profile.model.id} does not publish variant ${variant}.`,
          })
        }

        const unsupported = unsupportedModelRequirements(model, profile.modelRequirements)
        if (unsupported.length > 0) {
          return yield* new SwarmSchema.ValidationError({
            reason:
              `Model ${profile.model.providerID}/${profile.model.id} does not satisfy required model ` +
              `capabilities: ${unsupported.join(", ")}.`,
          })
        }

        return { model } satisfies Resolved
      })
    })

    return Service.of({ check })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Agent.node, Provider.node],
})