import { describe, expect, test } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import { Agent as AgentModel } from "@opencode-ai/schema/agent"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProjectV2 } from "@opencode-ai/core/project"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SwarmSchema } from "@opencode-ai/core/swarm/schema"
import { Swarm } from "@opencode-ai/schema/swarm"
import { InstanceRef } from "@/effect/instance-ref"
import { Agent } from "@/agent/agent"
import { Provider as ProviderService } from "@/provider/provider"
import { SwarmProfilePreflight } from "@/swarm/profile-preflight"
import { testEffect } from "../lib/effect"

const directory = "/swarm/preflight"

const base = {
  agent: AgentModel.ID.make("build"),
  model: {
    providerID: ProviderV2.ID.make("anthropic"),
    id: ModelV2.ID.make("claude-opus-5"),
  },
  permissionBoundary: [],
} satisfies Swarm.MemberExecutionProfile

const catalog = {
  variants: { high: {}, low: {} },
  capabilities: {
    toolcall: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
  },
} as unknown as ProviderService.Model

const instance = {
  directory,
  worktree: directory,
  project: {
    id: ProjectV2.ID.make("swarm-profile-preflight-project"),
    worktree: directory,
    vcs: "git",
    sandboxes: [],
    time: {},
  },
} as never

const agentMock = Layer.mock(Agent.Service, {
  get: (name: string) => Effect.succeed(name === "build" ? ({ name: "build" } as any) : (undefined as any)),
})

const providerMock = Layer.mock(ProviderService.Service, {
  getModel: (providerID, modelID, accountID) =>
    providerID === "anthropic" && modelID === "claude-opus-5" && accountID === undefined
      ? Effect.succeed(catalog)
      : Effect.fail(
          Object.assign(new Error("model not found"), {
            reason: `no model ${providerID}/${modelID}/${accountID}`,
          }) as any,
        ),
})

const fsMock = Layer.mock(FSUtil.Service, {
  resolve: (path: string) => Effect.succeed(path.replace(/\/+$/, "")),
} as any)

const it = testEffect(
  Layer.provide(
    SwarmProfilePreflight.layer,
    Layer.mergeAll(fsMock, agentMock, providerMock),
  ),
)

/**
 * The preflight refuses to validate a profile against a provider/model catalog
 * it cannot prove it owns, so every case that is about the *profile* must first
 * be scoped to the workspace that owns it. Only the two directory-identity
 * cases below deliberately omit or contradict that scope.
 */
const scoped = <A, E, R>(effect: Effect.Effect<A, E, SwarmProfilePreflight.Service | R>) =>
  Effect.provideService(effect, InstanceRef, instance)

/** Structured preflight refusals stay readable after cause squashing. */
const failureText = (cause: Cause.Cause<SwarmSchema.ValidationError>) =>
  Cause.prettyErrors(cause)
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .join("; ")

describe("SwarmProfilePreflight", () => {
  it.effect("resolves a runnable profile", () =>
    Effect.gen(function* () {
      const service = yield* SwarmProfilePreflight.Service
      const resolved = yield* scoped(service.check({ directory, profile: base }))
      expect(resolved.model).toBeDefined()
    }),
  )

  it.effect("fails closed when no workspace instance context exists", () =>
    Effect.gen(function* () {
      const service = yield* SwarmProfilePreflight.Service
      const result = yield* service.check({ directory, profile: base }).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
    }),
  )

  it.effect("fails closed when the instance context is a different workspace", () =>
    Effect.gen(function* () {
      const service = yield* SwarmProfilePreflight.Service
      const result = yield* service
        .check({ directory, profile: base })
        .pipe(Effect.provideService(InstanceRef, { ...(instance as object), directory: "/elsewhere" } as never), Effect.exit)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(failureText(result.cause)).toContain("not the requested workspace")
    }),
  )

  it.effect("fails closed on an unknown agent", () =>
    Effect.gen(function* () {
      const service = yield* SwarmProfilePreflight.Service
      const result = yield* scoped(
        service.check({ directory, profile: { ...base, agent: AgentModel.ID.make("ghost") } }),
      ).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(failureText(result.cause)).toContain("Agent not found: ghost")
    }),
  )

  it.effect("fails closed on an unresolvable provider/model/account", () =>
    Effect.gen(function* () {
      const service = yield* SwarmProfilePreflight.Service
      const result = yield* scoped(
        service.check({
          directory,
          profile: { ...base, model: { ...base.model, accountID: "acct_missing" } },
        }),
      ).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(failureText(result.cause)).toContain("does not resolve")
    }),
  )

  it.effect("fails closed on an unpublished model variant", () =>
    Effect.gen(function* () {
      const service = yield* SwarmProfilePreflight.Service
      const result = yield* scoped(
        service.check({ directory, profile: { ...base, model: { ...base.model, variant: ModelV2.VariantID.make("turbo") } } }),
      ).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(failureText(result.cause)).toContain("does not publish variant turbo")
    }),
  )

  it.effect("fails closed on an unsatisfied model requirement", () =>
    Effect.gen(function* () {
      const service = yield* SwarmProfilePreflight.Service
      const result = yield* scoped(
        service.check({ directory, profile: { ...base, modelRequirements: ["input_pdf", "toolcall"] } }),
      ).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(failureText(result.cause)).toContain("input_pdf")
    }),
  )

  it.effect("accepts every requirement the catalog publishes", () =>
    Effect.gen(function* () {
      const service = yield* SwarmProfilePreflight.Service
      yield* scoped(
        service.check({
          directory,
          profile: { ...base, modelRequirements: ["toolcall", "reasoning", "attachment", "input_image", "output_text"] },
        }),
      )
    }),
  )

  test("maps every requirement in the closed vocabulary to a catalog capability", () => {
    for (const requirement of [
      "toolcall",
      "reasoning",
      "attachment",
      "temperature",
      "input_text",
      "input_audio",
      "input_image",
      "input_video",
      "input_pdf",
      "output_text",
      "output_audio",
      "output_image",
      "output_video",
      "output_pdf",
    ] satisfies Swarm.ModelRequirement[])
      expect(SwarmProfilePreflight.supportsModelRequirement(catalog, requirement)).toBeTypeOf("boolean")
  })

  test("never treats a semantic routing tag as a model requirement", () => {
    expect(Swarm.LEGACY_SEMANTIC_ROUTING_TAGS.every((tag) => !(tag in Swarm.LEGACY_MODEL_REQUIREMENT_ALIASES))).toBe(
      true,
    )
  })
})