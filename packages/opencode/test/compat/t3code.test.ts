import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  OPENFORK_COMPAT_PROFILE_ENV,
  T3_CODE_COMPAT_EXECUTABLE,
  T3_CODE_COMPAT_PROFILE,
  T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION,
  canonicalT3CodeModelRef,
  canonicalT3CodeModelSlug,
  isT3CodeCompatibilityProfile,
  localClientReportedVersion,
  localServerListeningProduct,
  t3CodeAccountModelID,
} from "../../src/compat/t3code"
import {
  filterT3CodeAccountModels,
  projectT3CodeAccountModels,
} from "../../src/compat/t3code-provider"

const nodeExecutable = (() => {
  const result = spawnSync("node", ["-p", "process.execPath"], {
    encoding: "utf8",
    windowsHide: true,
  })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
})()

function compatibilityProfileFromEntrypoint(name: "openfork" | "openfork-t3code" | "opencode") {
  const environment = { ...process.env }
  delete environment[OPENFORK_COMPAT_PROFILE_ENV]
  environment.OPENFORK_BIN_PATH = nodeExecutable

  const executable = fileURLToPath(new URL(`../../bin/${name}`, import.meta.url))
  const result = spawnSync(
    nodeExecutable,
    [
      executable,
      "-e",
      `process.stdout.write(process.env.${OPENFORK_COMPAT_PROFILE_ENV} ?? "")`,
    ],
    {
      encoding: "utf8",
      env: environment,
      windowsHide: true,
    },
  )

  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

describe("T3 Code compatibility profile", () => {
  const environment = {
    [OPENFORK_COMPAT_PROFILE_ENV]: T3_CODE_COMPAT_PROFILE,
  }

  test("is opt-in and never changes canonical OpenFork identity by default", () => {
    const environment = {}

    expect(isT3CodeCompatibilityProfile(environment)).toBe(false)
    expect(localClientReportedVersion("2.7.0", environment)).toBe("2.7.0")
    expect(localServerListeningProduct(environment)).toBe("OpenFork")
  })

  test("projects the audited OpenCode 1.15.13 facade when explicitly activated", () => {
    expect(T3_CODE_COMPAT_EXECUTABLE).toBe("openfork-t3code")
    expect(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION).toBe("1.15.13")
    expect(isT3CodeCompatibilityProfile(environment)).toBe(true)
    expect(localClientReportedVersion("9.0.0", environment)).toBe("1.15.13")
    expect(localServerListeningProduct(environment)).toBe("opencode")
  })

  test("does not treat unknown compatibility profiles as T3 Code", () => {
    const environment = {
      [OPENFORK_COMPAT_PROFILE_ENV]: "some-other-client",
    }

    expect(isT3CodeCompatibilityProfile(environment)).toBe(false)
    expect(localClientReportedVersion("2.0.0", environment)).toBe("2.0.0")
    expect(localServerListeningProduct(environment)).toBe("OpenFork")
  })

  test("keeps canonical and historical OpenFork entrypoints isolated from the T3 facade", () => {
    expect(compatibilityProfileFromEntrypoint("openfork")).toBe("")
    expect(compatibilityProfileFromEntrypoint("openfork-t3code")).toBe(T3_CODE_COMPAT_PROFILE)
    expect(compatibilityProfileFromEntrypoint("opencode")).toBe("")
  })

  test("round-trips generic first-class accounts through an opaque T3 model alias", () => {
    const accountID = "opencode-account:5f97f1529d0df6f34adbd125c71667ef"
    const alias = t3CodeAccountModelID("claude-sonnet-4-6", accountID)
    expect(alias).toStartWith("claude-sonnet-4-6@ofacct:")
    expect(
      canonicalT3CodeModelRef(
        { providerID: "anthropic", modelID: alias },
        environment,
      ),
    ).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
      accountID,
    })
    expect(canonicalT3CodeModelSlug(`anthropic/${alias}`, environment)).toEqual({
      slug: "anthropic/claude-sonnet-4-6",
      accountID,
    })
  })

  test("preserves model ids containing slashes while lowering a T3 account alias", () => {
    const accountID = "opencode-account:slash-model"
    const alias = t3CodeAccountModelID("vendor/model-name", accountID)
    expect(canonicalT3CodeModelSlug(`openrouter/${alias}`, environment)).toEqual({
      slug: "openrouter/vendor/model-name",
      accountID,
    })
  })

  test("lowers only provider-declared legacy account suffixes and never arbitrary @ model ids", () => {
    expect(
      canonicalT3CodeModelRef(
        { providerID: "workbuddy", modelID: "hy4-preview@wb-account-a" },
        environment,
      ),
    ).toEqual({
      providerID: "workbuddy",
      modelID: "hy4-preview",
      accountID: "wb-account-a",
    })
    expect(
      canonicalT3CodeModelRef(
        { providerID: "opencode", modelID: "gpt-5@zen-account-a" },
        environment,
      ),
    ).toEqual({
      providerID: "opencode",
      modelID: "gpt-5",
      accountID: "zen-account-a",
    })
    expect(
      canonicalT3CodeModelRef(
        { providerID: "anthropic", modelID: "literal@model-name" },
        environment,
      ),
    ).toEqual({
      providerID: "anthropic",
      modelID: "literal@model-name",
    })
  })

  test("never decodes compatibility aliases outside the explicit T3 profile", () => {
    const alias = t3CodeAccountModelID("model", "account-a")
    expect(canonicalT3CodeModelRef({ providerID: "provider", modelID: alias }, {})).toEqual({
      providerID: "provider",
      modelID: alias,
    })
  })

  test("does not claim an unrelated model that merely resembles the reserved suffix", () => {
    const legacyLikeToken = Buffer.from("ordinary-model-suffix", "utf8").toString("base64url")
    const modelID = `literal-model@ofacct:${legacyLikeToken}`
    expect(
      canonicalT3CodeModelRef(
        { providerID: "provider", modelID },
        environment,
      ),
    ).toEqual({
      providerID: "provider",
      modelID,
    })
  })

  test("projects account rows without mutating the canonical account-neutral catalog", () => {
    const providerID = "anthropic" as any
    const modelID = "claude-sonnet-4-6" as any
    const model = {
      id: modelID,
      providerID,
      name: "Claude Sonnet 4.6",
    } as any
    const provider = {
      id: providerID,
      name: "Anthropic",
      source: "config",
      env: [],
      options: {},
      models: { [modelID]: model },
    } as any
    const providers = { [providerID]: provider } as any
    const projected = projectT3CodeAccountModels(providers, [
      {
        accountID: "opencode-account:abc",
        accountLabel: "research@example.com",
        provider,
        model,
      },
    ])
    const keys = Object.keys(projected.providers[providerID]!.models)
    expect(keys).toHaveLength(2)
    expect(keys).toContain(modelID)
    const alias = keys.find((key) => key !== modelID)!
    expect(alias).toStartWith(`${modelID}@ofacct:`)
    expect(projected.providers[providerID]!.models[alias as any]!.name).toBe(
      "Claude Sonnet 4.6 (research@example.com)",
    )
    expect(projected.connected.has(providerID)).toBe(true)
    expect(Object.keys(provider.models)).toEqual([modelID])
  })

  test("deduplicates only the same native account alias and preserves distinct Console accounts", () => {
    const providerID = "workbuddy" as any
    const modelID = "hy4-preview" as any
    const nativeAliasID = "hy4-preview@wb-account-a" as any
    const model = {
      id: modelID,
      providerID,
      name: "HY 4 Preview",
    } as any
    const nativeAlias = {
      ...model,
      id: nativeAliasID,
      name: "HY 4 Preview (Native A)",
    } as any
    const provider = {
      id: providerID,
      name: "WorkBuddy",
      source: "custom",
      env: [],
      options: {},
      models: {
        [modelID]: model,
        [nativeAliasID]: nativeAlias,
      },
    } as any
    const projected = projectT3CodeAccountModels(
      { [providerID]: provider } as any,
      [
        {
          accountID: "wb-account-a",
          accountLabel: "Native A",
          provider,
          model,
        },
        {
          accountID: "opencode-account:console-b",
          accountLabel: "Console B",
          provider,
          model,
        },
      ],
    )

    const keys = Object.keys(projected.providers[providerID]!.models)
    expect(keys.filter((key) => key === nativeAliasID)).toHaveLength(1)
    expect(keys.filter((key) => key.includes("@ofacct:"))).toHaveLength(1)
    expect(
      keys.some(
        (key) =>
          canonicalT3CodeModelRef(
            { providerID, modelID: key },
            environment,
          ).accountID === "opencode-account:console-b",
      ),
    ).toBe(true)
    expect(projected.connected.has(providerID)).toBe(true)
  })

  test("applies the same enabled/disabled provider gate to T3 account projections", () => {
    const rows = [
      { provider: { id: "anthropic" } },
      { provider: { id: "openai" } },
      { provider: { id: "workbuddy" } },
    ] as any

    expect(
      filterT3CodeAccountModels(rows, {
        enabledProviders: ["anthropic", "openai"],
        disabledProviders: ["openai"],
      }).map((entry) => String(entry.provider.id)),
    ).toEqual(["anthropic"])

    expect(
      filterT3CodeAccountModels(rows, {
        disabledProviders: ["workbuddy"],
      }).map((entry) => String(entry.provider.id)),
    ).toEqual(["anthropic", "openai"])
  })
})
