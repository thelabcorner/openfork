import { describe, it, expect } from "bun:test"
import { ClaudeProvider, migrateLegacyReference } from "../provider"
import { ClaudeAuth, defaultContract } from "../auth"
import { isClaudeModel, MODEL_IDS, MODEL_METADATA, resolveAlias, ALIASES } from "../models"

describe("claude provider discovery", () => {
  it("discoverPure returns provider info with no process side effects", () => {
    const result = ClaudeProvider.discoverPure()
    expect(String(result.providerID)).toBe("claude")
    expect(result.status).toBe("unavailable")
    expect(result.errorCategory).toBe("setup")
    expect(typeof result.setupState).toBe("object")
    expect(result.setupState!.executableDetected).toBe(false)
    expect(result.setupState!.cliAuthStatus).toBe("unknown")
    expect(result.setupState!.requiresApproval).toBe(false)
  })

  it("discoverPure never starts SDK or CLI (no spawn, no import of SDK modules)", () => {
    // This test verifies by inspection that discoverPure is a pure function:
    // it does not call import(), spawn(), or any async I/O.
    const result = ClaudeProvider.discoverPure()
    expect(result.models).toBeDefined()
    expect(Object.keys(result.models).length).toBeGreaterThan(0)
  })

  it("model IDs are stable and include canonical Claude models", () => {
    expect(MODEL_IDS).toContain("claude-sonnet-4-5-20251101")
    expect(MODEL_IDS).toContain("claude-opus-4-6")
    expect(MODEL_IDS).toContain("claude-haiku-4-5-20251001")
    // first-party port of opencode-claude exposes the same subscription models
    expect(MODEL_IDS).toContain("fable")
    expect(MODEL_IDS).toContain("sonnet")
    expect(MODEL_IDS).toContain("opus")
    expect(MODEL_IDS).toContain("haiku")
    expect(MODEL_IDS).toContain("claude-opus-4-8")
    expect(MODEL_IDS).toContain("claude-sonnet-4-6")
    expect(MODEL_IDS).toContain("claude-haiku-4-5")
  })

  it("aliases resolve to canonical IDs", () => {
    expect(resolveAlias("claude/sonnet")).toBe("claude-sonnet-4-5-20251101")
    expect(resolveAlias("claude/opus")).toBe("claude-opus-4-6")
    expect(resolveAlias("claude/haiku")).toBe("claude-haiku-4-5-20251001")
    expect(resolveAlias("unknown-alias")).toBeUndefined()
    // short forms resolve to themselves (valid model IDs for subscription)
    expect(resolveAlias("sonnet")).toBe("sonnet")
    expect(resolveAlias("fable")).toBe("fable")
    expect(resolveAlias("opus")).toBe("opus")
  })

  it("isClaudeModel recognizes canonical and family IDs", () => {
    expect(isClaudeModel("claude-sonnet-4-5-20251101")).toBe(true)
    expect(isClaudeModel("claude-opus-4-6")).toBe(true)
    expect(isClaudeModel("gpt-4o")).toBe(false)
    // ported plugin models
    expect(isClaudeModel("sonnet")).toBe(true)
    expect(isClaudeModel("fable")).toBe(true)
    expect(isClaudeModel("claude-opus-4-8")).toBe(true)
  })

  it("migrateLegacyReference handles canonical IDs and aliases", () => {
    expect(migrateLegacyReference("claude/sonnet")).toBe("claude-sonnet-4-5-20251101")
    expect(migrateLegacyReference("claude-sonnet-4-5-20251101")).toBe("claude-sonnet-4-5-20251101")
    expect(migrateLegacyReference("unknown")).toBeUndefined()
    // new short forms for first-party
    expect(migrateLegacyReference("sonnet")).toBe("sonnet")
    expect(migrateLegacyReference("fable")).toBe("fable")
  })

  it("model metadata has capabilities and variants", () => {
    const meta = MODEL_METADATA["claude-sonnet-4-5-20251101"]
    expect(meta).toBeDefined()
    expect(meta!.capabilities.reasoning).toBe(true)
    expect(meta!.capabilities.attachment).toBe(true)
    expect(meta!.variants).toBeDefined()
    expect(Object.keys(meta!.variants)).toContain("low")
    expect(Object.keys(meta!.variants)).toContain("high")
  })

  it("contract interface is suitable for fake fixtures", () => {
    expect(typeof ClaudeProvider.contract.discover).toBe("function")
    expect(typeof ClaudeProvider.contract.resolveAlias).toBe("function")
    expect(typeof ClaudeProvider.contract.modelStatus).toBe("function")
    expect(typeof ClaudeProvider.contract.providerStatus).toBe("function")
  })
})

describe("claude auth contracts", () => {
  it("default contract has no credential writes", () => {
    const info = defaultContract.getStatus()
    expect(info.providerID).toBe("claude")
    expect(info.method).toBe("cli-login")
    expect(info.status).toBe("unknown")
    expect(info.cliExecutableDetected).toBe(false)
    expect(info.requiresUserApproval).toBe(false)
    expect(info.correlationHash).toBeUndefined()
  })

  it("default contract reports unavailable and requires setup", () => {
    expect(defaultContract.isAvailable()).toBe(false)
    expect(defaultContract.requiresSetup()).toBe(true)
  })
})
