import { describe, expect, test } from "bun:test"
import { fromConfigProvider } from "../../src/provider/provider"
import { projectHostedNeutralModels } from "../../src/provider/hosted-neutral-model"

const fixture = (providerID: string = "opencode-go") =>
  fromConfigProvider(
    providerID,
    {
      api: providerID === "opencode-go" ? "https://opencode.ai/zen/go/v1" : "https://opencode.ai/zen/v1",
      models: {
        "integration-probe@zen-account-a": { id: "integration-probe", name: "Account A" },
        "integration-probe@zen-account-b": { id: "integration-probe", name: "Account B" },
      },
    } as Parameters<typeof fromConfigProvider>[1],
    undefined,
    {},
  )

describe("hosted qualified-only catalog normalization", () => {
  test("projects an account-neutral model from matching explicit API identities without changing aliases", () => {
    for (const id of ["opencode", "opencode-go"]) {
      const original = fixture(id)
      expect(original.models["integration-probe"]).toBeUndefined()
      const projected = projectHostedNeutralModels(original)
      expect(projected).not.toBe(original)
      expect(projected.models["integration-probe"]).toMatchObject({
        id: "integration-probe",
        providerID: id,
        api: { id: "integration-probe" },
        name: "integration-probe",
      })
      expect(projected.models["integration-probe@zen-account-a"]).toBe(original.models["integration-probe@zen-account-a"])
      expect(projected.models["integration-probe@zen-account-b"]).toBe(original.models["integration-probe@zen-account-b"])
      expect(original.models["integration-probe"]).toBeUndefined()
      expect(projectHostedNeutralModels(projected)).toBe(projected)
    }
  })

  test("existing neutral catalog metadata is authoritative", () => {
    const original = fixture()
    original.models["integration-probe"] = {
      ...original.models["integration-probe@zen-account-a"]!,
      id: "integration-probe" as typeof original.models[string]["id"],
      name: "Official neutral model",
    }
    expect(projectHostedNeutralModels(original)).toBe(original)
    expect(original.models["integration-probe"]?.name).toBe("Official neutral model")
  })

  test("unrelated providers never acquire synthetic routing identities", () => {
    const other = fixture("workbuddy")
    expect(projectHostedNeutralModels(other)).toBe(other)
  })

  test("never projects unknown/qualified API transport IDs", () => {
    const original = fixture()
    original.models["integration-probe@zen-account-b"]!.api.id = "integration-probe@zen-account-b"
    expect(projectHostedNeutralModels(original)).toBe(original)
    expect(original.models["integration-probe"]).toBeUndefined()
  })

  test("rejects conflicting account capabilities and does not choose arbitrary metadata", () => {
    const original = fixture()
    original.models["integration-probe@zen-account-b"]!.capabilities.toolcall = false
    expect(projectHostedNeutralModels(original)).toBe(original)
  })

  test("rejects account-bound credentials and transport overrides in alias metadata", () => {
    for (const patch of [
      (model: ReturnType<typeof fixture>["models"][string]) => { model.options.apiKey = "secret" },
      (model: ReturnType<typeof fixture>["models"][string]) => { model.headers.authorization = "Bearer secret" },
      (model: ReturnType<typeof fixture>["models"][string]) => { model.options.fetch = () => Promise.reject(new Error()) },
      (model: ReturnType<typeof fixture>["models"][string]) => { model.options.baseURL = "https://attacker.invalid" },
      (model: ReturnType<typeof fixture>["models"][string]) => {
        model.options.http = { headers: { Authorization: "Bearer nested-secret" } }
      },
    ]) {
      const original = fixture()
      patch(original.models["integration-probe@zen-account-a"]!)
      expect(projectHostedNeutralModels(original)).toBe(original)
      expect(original.models["integration-probe"]).toBeUndefined()
    }
  })

  test("honors canonical allow/deny policy; alias-only whitelist does not authorize a neutral entry", () => {
    const original = fixture()
    expect(projectHostedNeutralModels(original, (base) => base !== "integration-probe")).toBe(original)
    expect(projectHostedNeutralModels(original, (base) => base === "integration-probe").models["integration-probe"]).toBeDefined()
  })

  test("malformed and unknown @ suffixes are not treated as account qualifications", () => {
    const original = fromConfigProvider("opencode-go", {
      api: "https://opencode.ai/zen/go/v1",
      models: {
        "weird@unrelated": { id: "weird" },
        "empty@zen-": { id: "empty" },
      },
    } as Parameters<typeof fromConfigProvider>[1], undefined, {})
    expect(projectHostedNeutralModels(original)).toBe(original)
    expect(original.models.weird).toBeUndefined()
    expect(original.models.empty).toBeUndefined()
  })

  test("never projects metadata that could send a committed Zen bearer to a foreign API host", () => {
    const original = fixture()
    original.models["integration-probe@zen-account-a"]!.api.url = "https://unauthorized.example/v1"
    expect(projectHostedNeutralModels(original)).toBe(original)
  })
})
