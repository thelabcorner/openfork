import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Swarm } from "@opencode-ai/schema/swarm"

const base = {
  agent: Agent.ID.make("build"),
  model: { providerID: Provider.ID.make("anthropic"), id: Model.ID.make("claude-opus-5") },
  permissionBoundary: [],
} satisfies Swarm.MemberExecutionProfile

const decode = Schema.decodeUnknownSync(Swarm.MemberExecutionProfile)

describe("Swarm.MemberExecutionProfile", () => {
  test("accepts the closed model-requirement vocabulary", () => {
    const decoded = decode({
      ...base,
      modelRequirements: ["toolcall", "reasoning", "input_image", "output_text"],
    })
    expect(decoded.modelRequirements).toEqual(["toolcall", "reasoning", "input_image", "output_text"])
  })

  test("rejects semantic routing tags used as model requirements", () => {
    for (const tag of ["research", "preregistration", "audit", "adversarial"]) {
      expect(() => decode({ ...base, modelRequirements: [tag] })).toThrow()
    }
  })

  test("cannot honor the retired unvalidated requestedCapabilities key", () => {
    // Effect struct decoding strips unknown keys, so the retired field is inert
    // at the contract boundary: it can never be interpreted as a requirement.
    const decoded = decode({ ...base, requestedCapabilities: ["tools", "research"] }) as Record<string, unknown>
    expect(decoded.requestedCapabilities).toBeUndefined()
    expect(decoded.modelRequirements).toBeUndefined()
  })

  test("omits modelRequirements when absent", () => {
    const encoded = Schema.encodeSync(Swarm.MemberExecutionProfile)(base)
    expect(Object.keys(encoded)).not.toContain("modelRequirements")
  })
})

describe("Swarm.normalizeLegacyExecutionProfile", () => {
  test("migrates recognized runtime aliases into the closed vocabulary", () => {
    const result = Swarm.normalizeLegacyExecutionProfile({
      ...base,
      requestedCapabilities: ["tools", "input:image", "output:text", "reasoning"],
    })
    expect([...result.profile.modelRequirements!].sort()).toEqual([
      "input_image",
      "output_text",
      "reasoning",
      "toolcall",
    ])
    expect(result.unproven).toEqual([])
    expect(result.routingTags).toEqual([])
    expect("requestedCapabilities" in (result.profile as object)).toBe(false)
  })

  test("reports observed semantic routing tags without stranding or blocking", () => {
    const result = Swarm.normalizeLegacyExecutionProfile({
      ...base,
      requestedCapabilities: ["research", "audit", "preregistration", "adversarial"],
    })
    expect([...result.routingTags].sort()).toEqual(["adversarial", "audit", "preregistration", "research"])
    // Routing tags are not requirements, and they must not be silently rewritten
    // into a requirement that can never be satisfied.
    expect(result.unproven).toEqual([])
    expect(result.profile.modelRequirements).toBeUndefined()
  })

  test("fails safe on an unrecognized legacy requirement instead of dropping it", () => {
    const result = Swarm.normalizeLegacyExecutionProfile({ ...base, requestedCapabilities: ["retina-vision"] })
    expect(result.unproven).toEqual([
      '"retina-vision" is not a known model requirement and cannot be proven against the model catalog',
    ])
  })

  test("is idempotent and preserves already-migrated requirements", () => {
    const once = Swarm.normalizeLegacyExecutionProfile({ ...base, requestedCapabilities: ["tools"] })
    const twice = Swarm.normalizeLegacyExecutionProfile(once.profile)
    expect(twice.profile.modelRequirements).toEqual(["toolcall"])
    expect(twice.unproven).toEqual([])
  })

  test("survives a null stored profile", () => {
    const result = Swarm.normalizeLegacyExecutionProfile(null)
    expect(result.unproven).toEqual([])
    expect(result.routingTags).toEqual([])
  })
})