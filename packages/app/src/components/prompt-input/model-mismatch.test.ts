import { describe, expect, test } from "bun:test"
import { activeGenerationMismatch, modelIdentityKey, shouldFollowActiveModel } from "./model-mismatch"

const SESSION_ID = "s1" as import("@opencode-ai/schema/session-id").SessionID
const base = {
  sessionID: SESSION_ID,
  phase: "generating" as const,
  updatedAt: 1,
  generatedMs: 0,
  toolMs: 0,
  model: { providerID: "p", modelID: "active" },
  step: { assistantMessageID: "a1", requestSentAt: 10, visibleChars: 1, reasoningChars: 0, generatedMs: 0, toolMs: 0 },
}

describe("active model mismatch", () => {
  test("only reports a live generation for the addressed session", () => {
    expect(
      activeGenerationMismatch({ sessionID: "s1", telemetry: base, selected: { providerID: "p", modelID: "selected" } })
        ?.model.modelID,
    ).toBe("active")
    expect(
      activeGenerationMismatch({
        sessionID: "s2",
        telemetry: base,
        selected: { providerID: "p", modelID: "selected" },
      }),
    ).toBeUndefined()
    expect(
      activeGenerationMismatch({
        sessionID: "s1",
        telemetry: { ...base, phase: "tool" },
        selected: { providerID: "p", modelID: "selected" },
      }),
    ).toBeUndefined()
    expect(
      activeGenerationMismatch({
        sessionID: "s1",
        telemetry: { ...base, isCompaction: true },
        selected: { providerID: "p", modelID: "selected" },
      }),
    ).toBeUndefined()
  })

  test("compares provider, model, and variant identity", () => {
    expect(modelIdentityKey({ providerID: "p", modelID: "m" })).toBe(
      modelIdentityKey({ providerID: "p", modelID: "m", variant: "" }),
    )
    expect(modelIdentityKey({ providerID: "p", modelID: "m" })).toBe(
      modelIdentityKey({ providerID: "p", modelID: "m", variant: "default" }),
    )
    expect(
      activeGenerationMismatch({
        sessionID: "s1",
        telemetry: base,
        selected: { providerID: "other", modelID: "active" },
      }),
    ).toBeDefined()
    expect(
      activeGenerationMismatch({ sessionID: "s1", telemetry: base, selected: { providerID: "p", modelID: "active" } }),
    ).toBeUndefined()
  })

  test("normalizes account-qualified model ids into the same identity key", () => {
    expect(modelIdentityKey({ providerID: "opencode-go", modelID: "m@zen-889db3308123" })).toBe(
      modelIdentityKey({ providerID: "opencode-go", modelID: "m", accountID: "zen-889db3308123" }),
    )
    expect(modelIdentityKey({ providerID: "openrouter", modelID: "vendor/model@x" })).toBe(
      modelIdentityKey({ providerID: "openrouter", modelID: "vendor/model@x" }),
    )
  })

  test("a pinned per-account key on the running model is not a mismatch", () => {
    const selected = { providerID: "opencode-go", modelID: "m", accountID: "zen-889db3308123", variant: "max" }
    const pinned = { ...base, model: { providerID: "opencode-go", modelID: "m@zen-889db3308123", variant: "max" } }
    expect(activeGenerationMismatch({ sessionID: "s1", telemetry: pinned, selected })).toBeUndefined()
    const split = {
      ...base,
      model: { providerID: "opencode-go", modelID: "m", accountID: "zen-889db3308123", variant: "max" },
    }
    expect(activeGenerationMismatch({ sessionID: "s1", telemetry: split, selected })).toBeUndefined()
    const accountless = { ...base, model: { providerID: "opencode-go", modelID: "m", variant: "max" } }
    expect(activeGenerationMismatch({ sessionID: "s1", telemetry: accountless, selected })).toBeUndefined()
    const bothQualified = {
      ...base,
      model: { providerID: "opencode-go", modelID: "m@zen-889db3308123", variant: "max" },
    }
    expect(
      activeGenerationMismatch({
        sessionID: "s1",
        telemetry: bothQualified,
        selected: { providerID: "opencode-go", modelID: "m@zen-889db3308123", variant: "max" },
      }),
    ).toBeUndefined()
  })

  test("an account conflict is only real when both identities name an account", () => {
    const telemetry = { ...base, model: { providerID: "opencode-go", modelID: "m", accountID: "zen-b" } }
    expect(
      activeGenerationMismatch({
        sessionID: "s1",
        telemetry,
        selected: { providerID: "opencode-go", modelID: "m", accountID: "zen-a" },
      }),
    ).toBeDefined()
    expect(
      activeGenerationMismatch({ sessionID: "s1", telemetry, selected: { providerID: "opencode-go", modelID: "m" } }),
    ).toBeUndefined()
  })

  test("a real model mismatch still surfaces while a key is pinned", () => {
    const pinnedTelemetry = {
      ...base,
      model: { providerID: "opencode-go", modelID: "active@zen-889db3308123", variant: "max" },
    }
    expect(
      activeGenerationMismatch({
        sessionID: "s1",
        telemetry: pinnedTelemetry,
        selected: { providerID: "opencode-go", modelID: "other", accountID: "zen-889db3308123", variant: "max" },
      }),
    ).toBeDefined()
    expect(
      activeGenerationMismatch({
        sessionID: "s1",
        telemetry: pinnedTelemetry,
        selected: { providerID: "other", modelID: "active", accountID: "zen-889db3308123", variant: "max" },
      }),
    ).toBeDefined()
    expect(
      activeGenerationMismatch({
        sessionID: "s1",
        telemetry: pinnedTelemetry,
        selected: { providerID: "opencode-go", modelID: "active", accountID: "zen-889db3308123", variant: "low" },
      }),
    ).toBeDefined()
    const selected = { providerID: "p", modelID: "selected", accountID: "zen-a" }
    const result = activeGenerationMismatch({ sessionID: "s1", telemetry: base, selected })
    expect(result?.model.modelID).toBe("active")
  })

  test("reverse-follow requires a fresh attempt and an unchanged user selection", () => {
    const common = {
      enabled: true,
      nextAttemptKey: "a2:20",
      previousAttemptKey: "a1:10",
      selectedKey: "p:selected",
      activeKeyBefore: "p:old-active",
      activeKey: "p:active",
    }
    expect(shouldFollowActiveModel({ ...common, previousSelectedKey: "p:selected" })).toBe(true)
    expect(shouldFollowActiveModel({ ...common, activeKeyBefore: "p:active", previousSelectedKey: "p:selected" })).toBe(
      false,
    )
    expect(shouldFollowActiveModel({ ...common, previousSelectedKey: "p:other" })).toBe(false)
    expect(shouldFollowActiveModel({ ...common, enabled: false, previousSelectedKey: "p:selected" })).toBe(false)
  })
})
