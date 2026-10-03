import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { OxpError } from "@/oxp/error"
import { OxpModelSelection } from "@/oxp/model-selection"
import { OxpSchema } from "@/oxp/schema"

const explicit = {
  providerID: "workbuddy",
  modelID: "deepseek-v4.1-flash",
  accountID: "wb-example-1234567890",
  variant: "max",
} satisfies OxpSchema.ModelSelection

const publicIntent: ProviderRouteIntent.Info = { kind: "public" }
const autoIntent: ProviderRouteIntent.Info = { kind: "auto" }
const accountIntent = (accountID: string, pin?: "hard" | "soft"): ProviderRouteIntent.Info => ({
  kind: "account",
  accountID,
  ...(pin ? { pin } : {}),
})

function failure(run: () => unknown) {
  try {
    run()
  } catch (error) {
    if (OxpError.isError(error)) return error
    throw new Error(`expected a typed OXP failure, received ${String(error)}`, { cause: error })
  }
  throw new Error("expected the OXP selection boundary to fail closed")
}

describe("OxpModelSelection", () => {
  test("keeps provider account identity first-class and lowers it only at the provider boundary", () => {
    const result = OxpModelSelection.materialize(explicit)

    expect(result.selection).toEqual(explicit)
    expect(result.accountMode).toBe("explicit")
    expect(result.providerModelID).toBe("deepseek-v4.1-flash@wb-example-1234567890")
  })

  test("rejects account smuggling through modelID", () => {
    expect(() =>
      OxpModelSelection.materialize({
        providerID: "workbuddy",
        modelID: "deepseek-v4.1-flash@wb-example-1234567890",
        variant: "max",
      }),
    ).toThrow("use accountID")
  })

  test("accepts human account selectors at ingress but refuses to lower them before runtime resolution", () => {
    expect(
      OxpModelSelection.normalize({
        providerID: "workbuddy",
        modelID: "deepseek-v4.1-flash",
        accountID: "owner@example.com",
      }),
    ).toEqual({
      providerID: "workbuddy",
      modelID: "deepseek-v4.1-flash",
      accountID: "owner@example.com",
    })

    expect(() =>
      OxpModelSelection.materialize({
        providerID: "workbuddy",
        modelID: "deepseek-v4.1-flash",
        accountID: "owner@example.com",
      }),
    ).toThrow("stable internal account id")

    expect(() =>
      OxpModelSelection.materialize({
        providerID: "workbuddy",
        modelID: "deepseek-v4.1-flash",
        accountID: "invalid-other-account",
      }),
    ).toThrow("stable internal account id")
  })

  test("still rejects account selectors for providers without first-class multi-account routing", () => {
    expect(() =>
      OxpModelSelection.normalize({
        providerID: "openrouter",
        modelID: "anthropic/claude-sonnet",
        accountID: "acct-1",
      }),
    ).toThrow("does not expose first-class account selection")
  })

  test("keeps omitted account selection explicitly automatic", () => {
    const result = OxpModelSelection.materialize({
      providerID: "workbuddy",
      modelID: "deepseek-v4.1-flash",
      variant: "max",
    })

    expect(result.accountMode).toBe("automatic")
    expect(result.routeIntent).toEqual({ kind: "auto" })
    expect(result.providerModelID).toBe("deepseek-v4.1-flash")
    expect(result.selection.accountID).toBeUndefined()
  })

  test("projects existing provider-qualified native selections back to explicit OXP account identity", () => {
    expect(
      OxpModelSelection.fromProviderModel(
        "workbuddy",
        "deepseek-v4.1-flash@wb-example-1234567890",
        "max",
      ),
    ).toEqual(explicit)
  })

  test("schema bounds all model-selection identifiers", () => {
    const decode = Schema.decodeUnknownSync(OxpSchema.ModelSelection)
    expect(() => decode({ providerID: "workbuddy", modelID: "x\n", accountID: "wb-a" })).toThrow()
    expect(() => decode({ providerID: "x".repeat(257), modelID: "m" })).toThrow()
  })

  test("canonicalizes a legacy account selection as a hard account pin", () => {
    const result = OxpModelSelection.materialize(explicit)

    expect(result.routeIntent).toEqual({
      kind: "account",
      accountID: "wb-example-1234567890",
      pin: "hard",
    })
    expect(result.accountMode).toBe("explicit")
  })

  test("preserves an explicit Public intent through normalization", () => {
    const result = OxpModelSelection.normalize({
      providerID: "workbuddy",
      modelID: "deepseek-v4.1-flash",
      routeIntent: publicIntent,
    })

    expect(result.routeIntent).toEqual({ kind: "public" })
    expect(result.accountID).toBeUndefined()
    expect(Object.hasOwn(result, "accountID")).toBe(false)
  })

  test("keeps Public account-free and independent of multi-account providers", () => {
    const result = OxpModelSelection.normalize({
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet",
      routeIntent: publicIntent,
    })

    expect(result.routeIntent).toEqual({ kind: "public" })
    expect(result.accountID).toBeUndefined()
  })

  test("materializes explicit Public account-free while preserving route intent for downstream binding", () => {
    const result = OxpModelSelection.materialize({
      providerID: "workbuddy",
      modelID: "deepseek-v4.1-flash",
      routeIntent: publicIntent,
    })

    expect(result.providerModelID).toBe("deepseek-v4.1-flash")
    expect(result.accountMode).toBe("public")
    expect(result.routeIntent).toEqual({ kind: "public" })
    expect(result.selection.accountID).toBeUndefined()
    expect(Object.hasOwn(result.selection, "accountID")).toBe(false)
  })

  test("materializes an explicit account intent without a legacy account field", () => {
    const result = OxpModelSelection.materialize({
      providerID: "workbuddy",
      modelID: "deepseek-v4.1-flash",
      routeIntent: accountIntent("wb-example-1234567890", "soft"),
    })

    expect(result.accountMode).toBe("explicit")
    expect(result.routeIntent).toEqual({
      kind: "account",
      accountID: "wb-example-1234567890",
      pin: "soft",
    })
    expect(result.providerModelID).toBe("deepseek-v4.1-flash@wb-example-1234567890")
  })

  test("fails closed when an explicit intent conflicts with the legacy account field", () => {
    for (const routeIntent of [publicIntent, autoIntent, accountIntent("wb-other-9999999999")]) {
      const error = failure(() =>
        OxpModelSelection.normalize({
          providerID: "workbuddy",
          modelID: "deepseek-v4.1-flash",
          accountID: "wb-example-1234567890",
          routeIntent,
        }),
      )
      expect(error).toBeInstanceOf(OxpError.Conflict)
      expect(error._tag).toBe("OXP_CONFLICT")
    }
  })

  test("accepts an explicit intent that names exactly the legacy account", () => {
    const result = OxpModelSelection.normalize({
      providerID: "workbuddy",
      modelID: "deepseek-v4.1-flash",
      accountID: "wb-example-1234567890",
      routeIntent: accountIntent("wb-example-1234567890", "hard"),
    })

    expect(result.routeIntent).toEqual({
      kind: "account",
      accountID: "wb-example-1234567890",
      pin: "hard",
    })
  })

  test("carries an explicit Public intent through a provider-model projection", () => {
    const result = OxpModelSelection.fromProviderModel(
      "workbuddy",
      "deepseek-v4.1-flash",
      "max",
      undefined,
      publicIntent,
    )

    expect(result).toEqual({
      providerID: "workbuddy",
      modelID: "deepseek-v4.1-flash",
      variant: "max",
      routeIntent: { kind: "public" },
    })
    expect(Object.hasOwn(result, "accountID")).toBe(false)
  })

  test("never infers Public from a missing account suffix", () => {
    const projected = OxpModelSelection.fromProviderModel("workbuddy", "deepseek-v4.1-flash")
    expect(projected.routeIntent).toBeUndefined()

    const result = OxpModelSelection.materialize(projected)
    expect(result.routeIntent).toEqual({ kind: "auto" })
    expect(result.accountMode).toBe("automatic")
  })
})
