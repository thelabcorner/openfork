import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OxpModelSelection } from "@/oxp/model-selection"
import { OxpSchema } from "@/oxp/schema"

const explicit = {
  providerID: "workbuddy",
  modelID: "deepseek-v4.1-flash",
  accountID: "wb-example-1234567890",
  variant: "max",
} satisfies OxpSchema.ModelSelection

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
        accountID: "vd-other-account",
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
})
