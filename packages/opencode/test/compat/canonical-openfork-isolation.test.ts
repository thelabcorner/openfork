import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Option, Redacted } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import {
  InstallationUserAgent,
  InstallationVersion,
  OpenCodeHostedUserAgent,
} from "@opencode-ai/core/installation/version"
import { ServerAuth } from "../../src/server/auth"
import {
  OPENFORK_COMPAT_PROFILE_ENV,
  T3_CODE_COMPAT_PROFILE,
  T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION,
  canonicalT3CodeModelRef,
  canonicalT3CodeModelSlug,
  isT3CodeCompatibilityProfile,
  localClientReportedVersion,
  localServerListeningProduct,
  t3CodeAccountModelID,
} from "../../src/compat/t3code"
import { projectT3CodeAccountModels } from "../../src/compat/t3code-provider"
import { filterT3CodeAccountModels } from "../../src/compat/t3code-provider"

/**
 * Canonical OpenFork isolation guard for the T3 Code compatibility facade.
 *
 * The T3 facade is an explicit, opt-in local-client exception. Every assertion
 * here is a negative invariant: it must FAIL if a compatibility change stops
 * being profile-scoped and starts altering ordinary `openfork` behavior.
 *
 * Process-level evidence already proves the facade answers T3 correctly
 * (`openfork-t3code --version` => `1.15.13`; `/global/health` => 200
 * `{healthy,version:"1.15.13"}`; `/api/info` => 404). That proof is NOT repeated
 * here. This file is unit/contract scope only and deliberately makes no claim
 * about real stock-T3 process/HTTP/SSE E2E.
 */

const PROFILE_ON = { [OPENFORK_COMPAT_PROFILE_ENV]: T3_CODE_COMPAT_PROFILE }
const PROFILE_UNKNOWN = { [OPENFORK_COMPAT_PROFILE_ENV]: "some-other-client" }

/** Stable first-class Console account id used across the identity invariants. */
const ACCOUNT_ID = "opencode-account:5f97f1529d0df6f34adbd125c71667ef"

/** Every environment object that must behave as canonical, non-T3 OpenFork. */
const CANONICAL_ENVIRONMENTS: ReadonlyArray<readonly [string, Record<string, string | undefined>]> = [
  ["unset", {}],
  ["an unrelated compatibility profile", PROFILE_UNKNOWN],
]

function readRepoFile(relative: string) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
}

const originalFlag = {
  password: Flag.OPENCODE_SERVER_PASSWORD,
  username: Flag.OPENCODE_SERVER_USERNAME,
}
const originalBarePassword = process.env.OPENCODE_PASSWORD
// The facade profile is process-global state. A test that activates it must put
// it back, or a later file that asserts canonical identity against the default
// `process.env` silently observes the T3 projection instead of canonical
// OpenFork. Combined-suite runs are the gate here; per-file green is not enough.
const originalCompatProfile = process.env[OPENFORK_COMPAT_PROFILE_ENV]

afterEach(() => {
  Flag.OPENCODE_SERVER_PASSWORD = originalFlag.password
  Flag.OPENCODE_SERVER_USERNAME = originalFlag.username
  if (originalBarePassword === undefined) delete process.env.OPENCODE_PASSWORD
  else process.env.OPENCODE_PASSWORD = originalBarePassword
  if (originalCompatProfile === undefined) delete process.env[OPENFORK_COMPAT_PROFILE_ENV]
  else process.env[OPENFORK_COMPAT_PROFILE_ENV] = originalCompatProfile
})

describe("canonical product/version identity is never rewritten by the T3 facade", () => {
  for (const [label, environment] of CANONICAL_ENVIRONMENTS) {
    test(`reports the real OpenFork product version when the profile is ${label}`, () => {
      expect(localClientReportedVersion(InstallationVersion, environment)).toBe(InstallationVersion)
      expect(localServerListeningProduct(environment)).toBe("OpenFork")
      expect(isT3CodeCompatibilityProfile(environment)).toBe(false)
    })
  }

  test("the facade version is a consumer contract constant, not the product version", () => {
    expect(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION).toBe("1.15.13")
    // Guard the inequality itself: `not.toBe` is satisfied by ANY differing
    // value, including a degenerate one. Without this the assertion would still
    // pass if the product version were ever empty or undefined.
    expect(InstallationVersion.length).toBeGreaterThan(0)
    expect(InstallationVersion).not.toBe(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)
  })

  test("the facade version is reachable only through the explicit profile", () => {
    expect(localClientReportedVersion(InstallationVersion, PROFILE_ON)).toBe(
      T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION,
    )
    expect(localServerListeningProduct(PROFILE_ON)).toBe("opencode")
  })
})

describe("canonical server authentication ignores the bare OPENCODE_PASSWORD variable", () => {
  // Latest stock T3 spawns its OpenCode server with `OPENCODE_PASSWORD`, while
  // OpenFork's canonical server auth contract is `OPENCODE_SERVER_PASSWORD`.
  // Teaching canonical auth to honor the bare name would let any process that
  // can set one env var silently switch password auth on for every OpenFork
  // server. Any such translation belongs in the T3 facade, never here.
  test("does not treat OPENCODE_PASSWORD as a canonical server password", () => {
    process.env.OPENCODE_PASSWORD = "t3-spawned-secret"
    Flag.OPENCODE_SERVER_PASSWORD = undefined
    Flag.OPENCODE_SERVER_USERNAME = undefined

    expect(ServerAuth.header()).toBeUndefined()
    expect(ServerAuth.headers()).toBeUndefined()

    const anonymous = { password: Option.none(), username: "opencode", publicUrl: "" }
    expect(ServerAuth.required(anonymous)).toBe(false)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("t3-spawned-secret") }, anonymous)).toBe(
      false,
    )
  })

  test("keeps OPENCODE_SERVER_PASSWORD as the canonical credential", () => {
    process.env.OPENCODE_PASSWORD = "t3-spawned-secret"
    Flag.OPENCODE_SERVER_PASSWORD = "canonical-secret"
    Flag.OPENCODE_SERVER_USERNAME = undefined

    expect(ServerAuth.header()).toBe(`Basic ${Buffer.from("opencode:canonical-secret").toString("base64")}`)

    const guarded = { password: Option.some("canonical-secret"), username: "opencode", publicUrl: "" }
    expect(ServerAuth.required(guarded)).toBe(true)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("canonical-secret") }, guarded)).toBe(
      true,
    )
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("t3-spawned-secret") }, guarded)).toBe(
      false,
    )
  })

  test("canonical Basic credentials are already UTF-8 encoded, so T3 needs no auth change", () => {
    Flag.OPENCODE_SERVER_PASSWORD = "pässwörd-日本"
    Flag.OPENCODE_SERVER_USERNAME = undefined

    const header = ServerAuth.header()
    expect(header).toBe(`Basic ${Buffer.from("opencode:pässwörd-日本", "utf8").toString("base64")}`)
    expect(Buffer.from(header!.slice("Basic ".length), "base64").toString("utf8")).toBe("opencode:pässwörd-日本")
  })

  test("neither canonical auth owner declares a bare OPENCODE_PASSWORD binding", () => {
    for (const owner of ["../../src/server/auth.ts", "../../../server/src/auth.ts"]) {
      const source = readRepoFile(owner)
      expect(source, `${owner} must not bind the bare OPENCODE_PASSWORD env name`).not.toMatch(
        /(?:EffectConfig|Config)\.string\(\s*"OPENCODE_PASSWORD"/,
      )
    }
  })
})

describe("provider identity is never rewritten by the T3 facade", () => {
  test("activating the profile does not change hosted or fork-owned client identity", () => {
    const hostedBefore = OpenCodeHostedUserAgent()
    const forkOwnedBefore = InstallationUserAgent("cli")

    process.env[OPENFORK_COMPAT_PROFILE_ENV] = T3_CODE_COMPAT_PROFILE
    expect(isT3CodeCompatibilityProfile()).toBe(true)

    // These identities reach upstream-operated Zen/Go and third-party
    // attribution. Routing the local T3 facade version into either would change
    // canonical provider identity for a local-client compatibility exception.
    expect(OpenCodeHostedUserAgent()).toBe(hostedBefore)
    expect(InstallationUserAgent("cli")).toBe(forkOwnedBefore)
  })

  test("the hosted wire user agent never reports the T3 facade version", () => {
    const hosted = OpenCodeHostedUserAgent()
    const forkOwned = InstallationUserAgent("cli")
    // Same discipline as above: `not.toContain` is trivially satisfied by an
    // empty string, so assert the identities are real before asserting what
    // they must never carry.
    expect(hosted.length).toBeGreaterThan(0)
    expect(forkOwned.length).toBeGreaterThan(0)
    expect(hosted).not.toContain(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)
    expect(forkOwned).not.toContain(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)
  })
})

describe("model identity is untouched outside the explicit profile", () => {
  const accountID = ACCOUNT_ID
  const alias = t3CodeAccountModelID("claude-sonnet-4-6", accountID)

  for (const [label, environment] of CANONICAL_ENVIRONMENTS) {
    test(`leaves a compat-looking model id byte-identical when the profile is ${label}`, () => {
      const ref = { providerID: "anthropic", modelID: alias }
      const canonical = canonicalT3CodeModelRef(ref, environment)

      expect(canonical.modelID).toBe(alias)
      expect(canonical.accountID).toBeUndefined()
      expect(canonicalT3CodeModelSlug(`anthropic/${alias}`, environment)).toEqual({ slug: `anthropic/${alias}` })
    })
  }

  test("never downgrades a canonical first-class account selection", () => {
    const environment = PROFILE_ON
    const ref = { providerID: "anthropic", modelID: "claude-sonnet-4-6", accountID }

    expect(canonicalT3CodeModelRef(ref, environment)).toEqual(ref)
  })

  test("decodes the alias only when the profile is active", () => {
    // Positive control: proves the gate above is a real profile check and not a
    // decoder that was accidentally disabled everywhere.
    expect(canonicalT3CodeModelRef({ providerID: "anthropic", modelID: alias }, PROFILE_ON)).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
      accountID,
    })
  })
})

describe("the compatibility projection never writes back into the canonical catalog", () => {
  test("leaves the canonical account-neutral provider catalog untouched", () => {
    const providerID = "anthropic" as never
    const modelID = "claude-sonnet-4-6" as never
    const model = { id: modelID, providerID, name: "Claude Sonnet 4.6" } as never
    const provider = {
      id: providerID,
      name: "Anthropic",
      source: "config",
      env: [],
      options: {},
      models: { [modelID]: model },
    } as never
    const providers = { [providerID]: provider } as never
    const before = JSON.stringify(providers)

    const projected = projectT3CodeAccountModels(providers, [
      { accountID: ACCOUNT_ID, accountLabel: "research@example.com", provider, model } as never,
    ])

    const projectedKeys = Object.keys(projected.providers[providerID]!.models)
    expect(projectedKeys).toHaveLength(2)
    expect(JSON.stringify(providers)).toBe(before)
    expect(Object.keys(provider.models)).toEqual([modelID])

    // `AccountModelProjection` is compat-ADJACENT, not compat-GATED: it is
    // declared in the canonical provider owner (src/provider/provider.ts) and
    // never reads the profile env, but it is the row producer feeding both the
    // HTTP catalog projection and the CLI fallback. A canonical rename of any
    // consumed field would NOT reduce the row count -- the alias would still be
    // minted, just from `undefined` -- so asserting the exact account identity
    // round-trips is what makes such a rename fail loudly here.
    const aliasID = projectedKeys.find((key) => key !== modelID)!
    expect(
      canonicalT3CodeModelRef({ providerID, modelID: aliasID }, PROFILE_ON).accountID,
    ).toBe(ACCOUNT_ID)

    // Mutating the compatibility projection must not reach the canonical catalog.
    projected.providers[providerID]!.models[aliasID as never] = { id: aliasID } as never
    expect(JSON.stringify(providers)).toBe(before)
    expect(Object.keys(provider.models)).toEqual([modelID])
  })
})

describe("the T3 provider filter stays bit-for-bit parity with the canonical filter", () => {
  const rows = [{ provider: { id: "anthropic" } }, { provider: { id: "openai" } }] as never

  // Canonical OpenFork reads the enablement set with a TRUTHINESS check at
  // provider/catalog.ts:212 and drops every provider at :216/:220 when it does
  // not match. `[]` is truthy, so `enabled_providers: []` empties the CANONICAL
  // catalog today. filterT3CodeAccountModels uses the identical truthiness
  // pattern, so the T3 path must agree.
  //
  // This is pinned deliberately as a NON-CHANGE. "Hardening" the T3 filter to
  // treat an empty array as unrestricted would be doubly wrong: it would hand a
  // caller that disabled every provider a full catalog (unauthorized widening),
  // and it would make the T3 projection DIVERGE from canonical OpenFork
  // behavior. Both are hard gates. If this test ever fails, the fix is to
  // restore truthiness — never to "improve" it into a length check.
  test("an empty enabled list means nothing is enabled, matching canonical truthiness", () => {
    expect(filterT3CodeAccountModels(rows, { enabledProviders: [] })).toEqual([])
  })

  test("an absent enabled list stays unrestricted, matching canonical truthiness", () => {
    expect(filterT3CodeAccountModels(rows, {})).toHaveLength(2)
  })
})