import { describe, it, expect } from "bun:test"
import { ClaudeModels, MODEL_IDS, MODEL_METADATA, ALIASES, ClaudeModelStatus } from "../models"

describe("claude model metadata", () => {
  it("all canonical model IDs have metadata", () => {
    for (const id of MODEL_IDS) {
      expect(MODEL_METADATA[id]).toBeDefined()
      expect(MODEL_METADATA[id]!.id).toBe(id)
      expect(typeof MODEL_METADATA[id]!.name).toBe("string")
      expect(typeof MODEL_METADATA[id]!.family).toBe("string")
    }
  })

  it("aliases cover common reference forms", () => {
    expect(ALIASES["claude/sonnet"]).toBeDefined()
    expect(ALIASES["claude/opus"]).toBeDefined()
    expect(ALIASES["claude/haiku"]).toBeDefined()
    expect(ALIASES["claude/codex"]).toBeDefined()
    // plugin-ported short forms now supported for first-party subscription
    expect(ALIASES["sonnet"]).toBeDefined()
    expect(ALIASES["opus"]).toBeDefined()
    expect(ALIASES["haiku"]).toBeDefined()
    expect(ALIASES["fable"]).toBeDefined()
  })

  it("model status values are from the allowed set", () => {
    for (const id of MODEL_IDS) {
      const meta = MODEL_METADATA[id]!
      const allowed: ClaudeModelStatus[] = ["active", "unavailable", "setup-required", "deprecated"]
      expect(allowed).toContain(meta.status)
    }
  })

  it("capabilities match Claude SDK profile", () => {
    const meta = MODEL_METADATA["claude-sonnet-4-5-20251101"]!
    expect(meta.capabilities.reasoning).toBe(true)
    expect(meta.capabilities.attachment).toBe(true)
    expect(meta.capabilities.toolcall).toBe(true)
    expect(meta.capabilities.input.text).toBe(true)
    expect(meta.capabilities.input.image).toBe(true)
    expect(meta.capabilities.input.pdf).toBe(true)
  })

  it("effort variants are defined for active reasoning models", () => {
    const meta = MODEL_METADATA["claude-opus-4-6"]!
    expect(meta.variants).toBeDefined()
    expect(meta.variants.low).toBeDefined()
    expect(meta.variants.high).toBeDefined()
    expect(meta.variants.max).toBeDefined()
  })

  it("unavailable model has empty variants and zero limits", () => {
    const meta = MODEL_METADATA["claude-codex-4-5"]!
    expect(meta.status).toBe("unavailable")
    expect(meta.variants).toBeDefined()
    expect(meta.contextLimit).toBe(0)
    expect(meta.outputLimit).toBe(0)
  })

  it("plugin-ported models (fable/sonnet5 etc) are present for first-party claude subscription", () => {
    expect(MODEL_METADATA["fable"]).toBeDefined()
    expect(MODEL_METADATA["sonnet"]).toBeDefined()
    expect(MODEL_METADATA["opus"]).toBeDefined()
    expect(MODEL_METADATA["haiku"]).toBeDefined()
    expect(MODEL_METADATA["claude-opus-4-8"]).toBeDefined()
    expect(MODEL_METADATA["claude-sonnet-4-6"]).toBeDefined()
    expect(MODEL_METADATA["claude-haiku-4-5"]).toBeDefined()
    // names match what the external plugin exposed
    expect(MODEL_METADATA["fable"]!.name).toBe("Fable 5")
    expect(MODEL_METADATA["sonnet"]!.name).toBe("Sonnet 5")
    expect(MODEL_METADATA["claude-opus-4-8"]!.name).toBe("Opus 4.8")
  })
})
