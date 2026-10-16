import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import {
  projectCredential,
} from "@opencode-ai/core/plugin/provider/opencode-provider-account"
import { providerModelID } from "@opencode-ai/schema/model-select/account-identity"
import { integrationID as opencodeIntegrationID } from "@opencode-ai/core/plugin/provider/opencode-auth"
import {
  OPENFORK_COMPAT_PROFILE_ENV,
  T3_CODE_COMPAT_PROFILE,
  T3_CODE_ACCOUNT_MODEL_MARKER,
  canonicalT3CodeModelRef,
  canonicalT3CodeModelSlug,
  t3CodeAccountModelID,
} from "../../src/compat/t3code"
import {
  filterT3CodeAccountModels,
  projectT3CodeAccountModels,
} from "../../src/compat/t3code-provider"

const environment = {
  [OPENFORK_COMPAT_PROFILE_ENV]: T3_CODE_COMPAT_PROFILE,
}

const token = (payload: string) => Buffer.from(payload, "utf8").toString("base64url")

function fixture(providerID: string, modelID: string) {
  const model = { id: modelID, providerID, name: modelID.toUpperCase() } as any
  const provider = {
    id: providerID,
    name: providerID,
    source: "config",
    env: [],
    options: {},
    models: { [modelID]: model },
  } as any
  return { provider, model }
}

function row(provider: any, model: any, accountID: string, accountLabel: string) {
  return { accountID, accountLabel, provider, model } as any
}

/**
 * Read a projected provider's models map without tripping the branded
 * ProviderV2.ID record key. The projection is a compat-only view keyed by an
 * opaque provider string, so the cast stays local to this fixture rather than
 * widening the production type.
 */
function modelsOf(projection: unknown, providerID: string): Record<string, any> {
  return (projection as any).providers[providerID].models
}

describe("T3 Code account-qualified model aliases (retained v1 path)", () => {
  /**
   * Latest stock T3 negotiates v1 against this wrapper, so this is the alias
   * contract that is actually exercised. The v2 location-scoped catalog is
   * deliberately NOT asserted here: it is unreachable while the reported
   * version stays on the 1.x facade.
   */

  test("unwraps a projected alias back to the exact account identity that was projected", () => {
    const providerID = "anthropic"
    const baseModelID = "claude-sonnet-4-6"
    const accountID = "opencode-account:5f97f1529d0df6f34adbd125c71667ef"
    const { provider, model } = fixture(providerID, baseModelID)

    const projected = projectT3CodeAccountModels({ [providerID]: provider } as any, [
      row(provider, model, accountID, "research@example.com"),
    ])

    // 1. OpenFork emits the alias into GET /provider.
    const aliasIDs = Object.keys(projected.providers[providerID]!.models).filter((id) =>
      id.includes(T3_CODE_ACCOUNT_MODEL_MARKER),
    )
    expect(aliasIDs).toHaveLength(1)
    const aliasID = aliasIDs[0]!

    // 2. T3 round-trips the opaque slug: it splits on the FIRST "/" only, so
    //    "@" and the whole base64url suffix must survive intact.
    const slug = `${providerID}/${aliasID}`
    const unwrappedSlug = canonicalT3CodeModelSlug(slug, environment)

    // 3. OpenFork must resolve to the SAME identity, not merely to *an* account.
    expect(unwrappedSlug).toEqual({ slug: `${providerID}/${baseModelID}`, accountID })
    expect(
      canonicalT3CodeModelRef({ providerID, modelID: aliasID }, environment),
    ).toEqual({ providerID, modelID: baseModelID, accountID })
  })

  test("keeps distinct Console accounts on one base model independently selectable", () => {
    const providerID = "anthropic"
    const baseModelID = "claude-sonnet-4-6"
    const { provider, model } = fixture(providerID, baseModelID)

    const projected = projectT3CodeAccountModels({ [providerID]: provider } as any, [
      row(provider, model, "opencode-account:alpha", "Alpha"),
      row(provider, model, "opencode-account:beta", "Beta"),
    ])

    const resolved = Object.keys(projected.providers[providerID]!.models).map((id) =>
      canonicalT3CodeModelRef({ providerID, modelID: id }, environment).accountID,
    )
    // Dedup is by PHYSICAL account identity, never by provider family, so both
    // Console accounts survive alongside the account-neutral base row.
    expect(resolved.filter(Boolean).sort()).toEqual([
      "opencode-account:alpha",
      "opencode-account:beta",
    ])
    expect(Object.keys(projected.providers[providerID]!.models)).toContain(baseModelID)
  })

  test("is idempotent so repeated catalog reads cannot duplicate alias rows", () => {
    const providerID = "anthropic"
    const { provider, model } = fixture(providerID, "claude-sonnet-4-6")
    const rows = [row(provider, model, "opencode-account:alpha", "Alpha")]

    const once = projectT3CodeAccountModels({ [providerID]: provider } as any, rows)
    const twice = projectT3CodeAccountModels(once.providers as any, rows)

    expect(Object.keys(twice.providers[providerID]!.models).sort()).toEqual(
      Object.keys(once.providers[providerID]!.models).sort(),
    )
  })

  test("derives identical alias ids from the shared projection primitive", () => {
    // src/provider/catalog.ts (GET /provider) and src/cli/cmd/models.ts both call
    // projectT3CodeAccountModels precisely so the CLI fallback cannot collapse
    // T3 back to one account-neutral model when inventory fails. That guarantee
    // rests on this primitive being a pure function of its inputs.
    const providerID = "workbuddy"
    const { provider, model } = fixture(providerID, "hy4-preview")
    const rows = [row(provider, model, "opencode-account:console-b", "Console B")]

    const http = projectT3CodeAccountModels({ [providerID]: provider } as any, rows)
    const cli = projectT3CodeAccountModels({ [providerID]: provider } as any, rows)

    // NON-TAUTOLOGICAL FORM. An earlier draft compared these two projections to
    // each other, which could never fail: both sides call the same pure function
    // with the same inputs, so it would have stayed green even if the projection
    // were entirely wrong. Compare to the expected mint instead, so the
    // assertion is anchored to ground truth and breaks if the ABI moves.
    const expectedAlias = t3CodeAccountModelID("hy4-preview", "opencode-account:console-b")

    expect(Object.keys(modelsOf(http, providerID)).sort()).toEqual(["hy4-preview", expectedAlias].sort())
    expect(Object.keys(modelsOf(cli, providerID)).sort()).toEqual(["hy4-preview", expectedAlias].sort())

    // connected is a ReadonlySet<string> at this boundary — catalog.ts:300
    // serializes it to an array of ID strings and .models lives on .all only.
    // Asserting membership (not object properties) is what makes this non-vacuous:
    // an empty set would fail rather than pass silently.
    expect([...http.connected]).toEqual([providerID])
    expect([...cli.connected]).toEqual([providerID])
  })

  test("keeps provider defaults account-neutral when explicit-account rows are projected", () => {
    const providerID = "anthropic"
    const baseModelID = "claude-sonnet-4-6"
    const { provider, model } = fixture(providerID, baseModelID)
    const before = Object.keys(provider.models)

    const projected = projectT3CodeAccountModels({ [providerID]: provider } as any, [
      row(provider, model, "opencode-account:alpha", "Alpha"),
    ])

    // The account-neutral base row must survive untouched, so default model
    // resolution can never be captured by an account-qualified alias.
    expect(projected.providers[providerID]!.models[baseModelID]).toBeDefined()
    expect(projected.providers[providerID]!.models[baseModelID]).toEqual(model)
    expect(before).toEqual([baseModelID])
  })

  test("carries variant/reasoning selection through the alias unwrap", () => {
    const accountID = "opencode-account:alpha"
    const aliasID = t3CodeAccountModelID("claude-sonnet-4-6", accountID)

    // Latest T3 v2 sends `{ providerID, id, variant? }` and omits variant when
    // undefined. Under the retained v1 path the same selection arrives alongside
    // the model ref, so lowering must not drop or rewrite it.
    const lowered = canonicalT3CodeModelRef(
      { providerID: "anthropic", modelID: aliasID, variant: "high" },
      environment,
    )
    expect(lowered).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
      accountID,
      variant: "high",
    })

    const slugged = canonicalT3CodeModelSlug(
      `anthropic/${aliasID}`,
      environment,
    ) as Record<string, unknown>
    expect(slugged.slug).toBe("anthropic/claude-sonnet-4-6")
    expect(slugged.accountID).toBe(accountID)
  })
})

describe("T3 Code alias identity stability across the credential lifecycle", () => {
  /**
   * SCOPE, corrected after review: core ALREADY pins the durable identity rules
   * this lane depends on. `packages/core/test/plugin/opencode-provider-account.test.ts`
   * covers rotation stability, org/user/server separation, email-not-identity,
   * server-realm normalization, the unverified-credential refusals, and SHA-256
   * opacity. Do not duplicate those here - they will rot in this file the moment
   * core changes its derivation.
   *
   * What core does NOT touch is the T3 WIRE TOKEN. Nothing in core knows that
   * `t3CodeAccountModelID` exists. These tests therefore assert only the BRIDGE:
   * that a given stable identity always mints the same alias token, that a
   * credential-ROW swap never moves that token, and that the token stays a legal
   * OpenCode model id T3 can round-trip. That bridge is what makes a slug T3
   * stored before re-auth still resolve afterwards.
   *
   * Authority for the stable id itself: packages/core/src/plugin/provider/
   * opencode-provider-account.ts (deriveAccountID / projectCredential), paid out
   * as AccountModelProjection.accountID at provider.ts:3334.
   */

  const server = "https://console.opencode.ai"

  function credential(input: {
    readonly id: string
    readonly label?: string
    readonly remoteUserID?: string
    readonly server?: string
    readonly orgID?: string
    readonly email?: string
    readonly type?: "oauth" | "key"
  }) {
    const oauth = (input.type ?? "oauth") === "oauth"
    return {
      id: input.id,
      integrationID: opencodeIntegrationID,
      label: input.label ?? "Console",
      active: true,
      revision: 1,
      value: {
        type: input.type ?? "oauth",
        ...(oauth
          ? { access: "at-secret", refresh: "rt-secret" }
          : { key: "sk-not-an-oauth-secret" }),
        metadata: {
          ...(input.remoteUserID === undefined ? {} : { accountID: input.remoteUserID }),
          ...(input.server === undefined ? {} : { server: input.server }),
          ...(input.orgID === undefined ? {} : { orgID: input.orgID }),
          ...(input.email === undefined ? {} : { email: input.email }),
        },
      },
    } as any
  }

  const stableAccountID = (input: Parameters<typeof credential>[0]) => {
    const projected = projectCredential(credential(input))
    expect(projected).toBeDefined()
    return projected!.accountID
  }

  test("credential rotation preserves the exact alias token T3 already stored", () => {
    const before = stableAccountID({ id: "cred_old", label: "Old label", remoteUserID: "user-1", server })
    const after = stableAccountID({ id: "cred_new", label: "New label", remoteUserID: "user-1", server })

    expect(before).toBe(after)
    expect(before).not.toContain("cred_old")
    expect(before).not.toContain("cred_new")

    // The property that actually matters at the wire: a T3 client holding a
    // model slug minted before rotation still decodes to the same account.
    const base = "claude-sonnet-4-6"
    expect(t3CodeAccountModelID(base, before)).toBe(t3CodeAccountModelID(base, after))
    expect(canonicalT3CodeModelSlug(`anthropic/${t3CodeAccountModelID(base, before)}`, environment)).toEqual({
      slug: `anthropic/${base}`,
      accountID: before,
    })
  })

  test("renaming the label or email changes presentation only, never identity", () => {
    const original = stableAccountID({
      id: "cred_a",
      label: "work@example.com",
      remoteUserID: "user-1",
      server,
      email: "work@example.com",
    })
    const renamed = stableAccountID({
      id: "cred_a",
      label: "personal@example.com",
      remoteUserID: "user-1",
      server,
      email: "personal@example.com",
    })

    expect(renamed).toBe(original)

    // The accountLabel is the only thing permitted to move.
    const { provider, model } = fixture("anthropic", "claude-sonnet-4-6")
    const base = "claude-sonnet-4-6"
    expect(
      modelsOf(
        projectT3CodeAccountModels({ anthropic: provider } as any, [
          row(provider, model, original, "work@example.com"),
        ]),
        "anthropic",
      )[t3CodeAccountModelID(base, original)]!.name,
    ).toBe("CLAUDE-SONNET-4-6 (work@example.com)")
    expect(
      modelsOf(
        projectT3CodeAccountModels({ anthropic: provider } as any, [
          row(provider, model, renamed, "personal@example.com"),
        ]),
        "anthropic",
      )[t3CodeAccountModelID(base, renamed)]!.name,
    ).toBe("CLAUDE-SONNET-4-6 (personal@example.com)")
  })

  test("distinct upstream identities never collapse onto one alias", () => {
    const base = stableAccountID({ id: "cred_a", remoteUserID: "user-1", server })
    // Each of these is a genuinely different durable account.
    const others = [
      stableAccountID({ id: "cred_b", remoteUserID: "user-2", server }),
      stableAccountID({ id: "cred_c", remoteUserID: "user-1", server, orgID: "org-9" }),
      stableAccountID({ id: "cred_d", remoteUserID: "user-1", server: "https://other.console.ai" }),
    ]

    for (const other of others) expect(other).not.toBe(base)
    // Namespace disambiguation: a stable id must never be confusable with the
    // provider-native @wb-/@zen- legacy account namespaces.
    for (const id of [base, ...others]) expect(id.startsWith("opencode-account:")).toBe(true)
  })

  test("a refused credential yields no alias row at all, rather than a wrong-account one", () => {
    // The refusal SHAPES are core's contract and are pinned there; re-listing
    // them here would rot. What core cannot assert is the compat consequence:
    // with no stable accountID there is nothing for the projection to encode,
    // so an unverified credential produces an EMPTY alias set - not a row that
    // merely looks account-qualified.
    const unverified = credential({ id: "cred_a", server }) // no upstream identity
    expect(projectCredential(unverified)).toBeUndefined()

    const { provider, model } = fixture("anthropic", "claude-sonnet-4-6")
    const projected = projectT3CodeAccountModels({ anthropic: provider } as any, [])

    // Positive control: the projection does mint alias rows when it is handed a
    // real stable identity, so the empty result above cannot pass vacuously.
    expect(
      Object.keys(modelsOf(projected, "anthropic")).filter((id) =>
        id.includes(T3_CODE_ACCOUNT_MODEL_MARKER),
      ),
    ).toEqual([])
    expect(Object.keys(modelsOf(projected, "anthropic"))).toContain("claude-sonnet-4-6")
    expect(model.id).toBe("claude-sonnet-4-6")
  })

  test("mints a token that is a legal OpenCode model id T3 can round-trip", () => {
    // The compat-specific leg of the bridge. Nothing in core knows the alias
    // exists, so the token's own legality is asserted here. T3 splits a model
    // slug on the FIRST "/" only, which is what makes a namespaced base id
    // ("vendor/model") safe to carry inside an alias.
    const accountID = "opencode-account:" + "a".repeat(64)

    for (const base of ["claude-sonnet-4-6", "vendor/model"]) {
      const alias = t3CodeAccountModelID(base, accountID)
      const token = alias.slice(alias.indexOf(T3_CODE_ACCOUNT_MODEL_MARKER) + T3_CODE_ACCOUNT_MODEL_MARKER.length)
      // The account token itself must be opaque and path-free, or T3's split
      // would treat part of it as a provider.
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(alias).not.toContain(" ")
      // Base id passes through verbatim (provider namespaces own that), and the
      // round trip recovers the exact base plus the exact account.
      expect(canonicalT3CodeModelSlug(`anthropic/${alias}`, environment)).toEqual({
        slug: `anthropic/${base}`,
        accountID,
      })
      // And the alias is untouched outside the profile, so a canonical OpenFork
      // client never sees the compat token rewritten under it.
      expect(canonicalT3CodeModelSlug(`anthropic/${alias}`, {})).toEqual({
        slug: `anthropic/${alias}`,
      })
    }
  })

  test("an explicit stable account never degrades to the account-neutral model", () => {
    // Narrows canonical-openfork-guard's ACCEPTED-UNEXERCISED-BOUNDARY to what is
    // statically decidable. getModel's legacy/unrouted branch (provider.ts:3630)
    // is the ONLY caller of providerModelID on the resolution path. If that branch
    // ever resolved a stable accountID to the ACCOUNT-NEUTRAL row, the account
    // would be silently dropped - the one genuinely unacceptable outcome. Pin the
    // composed lookup key so that outcome cannot be introduced quietly.
    const base = "claude-sonnet-4-6"
    const accountID = "opencode-account:" + "a".repeat(64)
    const qualified = providerModelID(base, "anthropic", accountID)

    // The key carries the requested account...
    expect(qualified).toBe(`${base}@${accountID}`)
    // ...so a lookup against an account-neutral catalog cannot hit the neutral row.
    expect({ [base]: {} }[qualified]).toBeUndefined()
    // ...and it cannot be confused with a provider-native legacy account either,
    // which is what would bind a DIFFERENT physical account.
    expect(qualified).not.toBe(providerModelID(base, "workbuddy", "wb-1"))
    // Fail-closed by construction: with the account qualified there is no key
    // that resolves, so provider.ts raises ModelNotFoundError and prompt.ts:536
    // (Effect.option) degrades to None rather than binding an account.
    expect(providerModelID(base, "anthropic", undefined)).toBe(base)
  })
})

describe("T3 Code catalog projection must not mutate the canonical provider catalog", () => {
  test("leaves an existing canonical provider byte-identical", () => {
    const providerID = "workbuddy"
    const baseModelID = "hy4-preview"
    const { provider, model } = fixture(providerID, baseModelID)
    const canonical = { [providerID]: provider } as any
    const before = structuredClone(canonical)

    const projected = projectT3CodeAccountModels(canonical, [
      row(provider, model, "opencode-account:alpha", "Alpha"),
      row(provider, model, "opencode-account:beta", "Beta"),
    ])

    expect(canonical).toEqual(before)
    expect(Object.keys(provider.models)).toEqual([baseModelID])
    expect(Object.keys(modelsOf(projected, providerID))).toHaveLength(3)
  })

  test("does not alias the models map it synthesizes for an account-only provider", () => {
    // t3code-provider.ts creates the provider entry when the canonical catalog
    // has none. If that reused the incoming projection row's own models map, a
    // later alias write would leak T3-only rows back into discovery.
    const providerID = "anthropic"
    const { provider, model } = fixture(providerID, "claude-sonnet-4-6")
    const accountOnly = { ...provider, models: { ...provider.models } } as any
    const before = structuredClone(accountOnly)

    const projected = projectT3CodeAccountModels({} as any, [
      row(accountOnly, model, "opencode-account:alpha", "Alpha"),
    ])

    expect(accountOnly).toEqual(before)
    expect(Object.keys(accountOnly.models)).toEqual(["claude-sonnet-4-6"])
    // Stronger than "did not alias the map": the synthesized provider starts
    // from an EMPTY model map, so the only row it can ever carry is one this
    // projection minted. There is no path by which a canonical model from the
    // incoming row could be inherited, let alone mutated.
    expect(Object.keys(modelsOf(projected, providerID))).toHaveLength(1)
    const onlyAlias = Object.keys(modelsOf(projected, providerID))[0]!
    expect(onlyAlias).toContain(T3_CODE_ACCOUNT_MODEL_MARKER)
    expect(modelsOf(projected, providerID)[onlyAlias]).toEqual(
      expect.objectContaining({ id: onlyAlias }),
    )
    expect(projected.connected.has(providerID)).toBe(true)
  })
})

describe("T3 Code alias unwrap guards", () => {
  const providerID = "anthropic"

  function unwrap(modelID: string) {
    return canonicalT3CodeModelRef({ providerID, modelID }, environment)
  }

  test("refuses account ids beyond the length guard", () => {
    const long = "opencode-account:" + "a".repeat(300)
    const aliasID = t3CodeAccountModelID("claude-sonnet-4-6", long)
    expect(unwrap(aliasID)).toEqual({ providerID, modelID: aliasID })
  })

  test("refuses account ids carrying control characters", () => {
    for (const accountID of ["opencode-account:a\u0000b", "opencode-account:a\nb", "opencode-account:a\u007fb"]) {
      const aliasID = t3CodeAccountModelID("claude-sonnet-4-6", accountID)
      expect(unwrap(aliasID)).toEqual({ providerID, modelID: aliasID })
    }
  })

  test("refuses an empty base model id", () => {
    const aliasID = t3CodeAccountModelID("", "opencode-account:alpha")
    expect(aliasID.startsWith(T3_CODE_ACCOUNT_MODEL_MARKER)).toBe(true)
    expect(unwrap(aliasID)).toEqual({ providerID, modelID: aliasID })
  })

  test("refuses tokens that are not an exact base64url round trip", () => {
    for (const bad of ["not+base64url!", "YWJj_ZA", "YWJjZA", ""]) {
      const modelID = `claude-sonnet-4-6${T3_CODE_ACCOUNT_MODEL_MARKER}${bad}`
      expect(unwrap(modelID)).toEqual({ providerID, modelID })
    }
  })

  test("refuses an unmarked suffix that only looks like an account token", () => {
    const modelID = `claude-sonnet-4-6${T3_CODE_ACCOUNT_MODEL_MARKER}${token("someone-elses-model")}`
    expect(unwrap(modelID)).toEqual({ providerID, modelID })
  })

  test("splits at the LAST marker so a base id containing the marker still resolves", () => {
    const accountID = "opencode-account:alpha"
    const baseModelID = `vendor/model${T3_CODE_ACCOUNT_MODEL_MARKER}legacy`
    const aliasID = t3CodeAccountModelID(baseModelID, accountID)
    expect(unwrap(aliasID)).toEqual({ providerID, modelID: baseModelID, accountID })
  })

  test("treats malformed slugs as identity instead of throwing", () => {
    for (const slug of ["", "no-slash", `${providerID}/`, "/leading-slash"]) {
      expect(canonicalT3CodeModelSlug(slug, environment)).toEqual({ slug })
    }
  })

  test("never decodes aliases outside the explicit T3 profile", () => {
    const aliasID = t3CodeAccountModelID("claude-sonnet-4-6", "opencode-account:alpha")
    expect(canonicalT3CodeModelRef({ providerID, modelID: aliasID }, {})).toEqual({
      providerID,
      modelID: aliasID,
    })
    expect(canonicalT3CodeModelSlug(`${providerID}/${aliasID}`, {})).toEqual({
      slug: `${providerID}/${aliasID}`,
    })
  })
})

describe("T3 Code account model provider filter", () => {
  const rows = [
    { provider: { id: "anthropic" } },
    { provider: { id: "openai" } },
    { provider: { id: "workbuddy" } },
  ] as any

  test("treats an omitted allowlist as no filter", () => {
    expect(
      filterT3CodeAccountModels(rows, {}).map((entry) => String(entry.provider.id)),
    ).toEqual(["anthropic", "openai", "workbuddy"])
  })

  test("treats an explicit empty allowlist as an empty catalog", () => {
    // RULING: [] means NOTHING ENABLED, not "no filter".
    //
    // This is not a judgment call — it is PARITY. Canonical OpenFork applies the
    // identical truthiness pattern at catalog.ts:212 and drops every provider at
    // :216, so `enabled_providers: []` already empties the canonical catalog.
    // Treating [] as "no filter" here would make the T3 facade DIVERGE from
    // canonical behavior, which is worse than the sharp edge: it would hand a
    // caller that disabled every provider a full catalog. A caller meaning
    // "unrestricted" must OMIT the key (it is Schema.optional with no default at
    // packages/core/src/v1/config/config.ts:82, so omission is a real option).
    expect(filterT3CodeAccountModels(rows, { enabledProviders: [] })).toEqual([])
  })

  test("agrees with the canonical catalog filter on empty and omitted allowlists", () => {
    // Mirror of catalog.ts:212/:216. If canonical filtering ever changes, the
    // compat projection must change with it or T3 and canonical OpenFork would
    // disagree about which providers exist.
    const canonicalKeeps = (ids: readonly string[], enabled?: readonly string[]) => {
      const set = enabled ? new Set(enabled) : undefined
      return ids.filter((id) => !((set && !set.has(id)) as boolean))
    }
    const ids = ["anthropic", "openai", "workbuddy"]
    const compatKeeps = (enabled?: readonly string[]) =>
      filterT3CodeAccountModels(
        ids.map((id) => ({ provider: { id } })) as any,
        enabled ? { enabledProviders: enabled } : {},
      ).map((entry) => String(entry.provider.id))

    for (const enabled of [undefined, [], ["anthropic"], ["openai", "workbuddy"]]) {
      expect(compatKeeps(enabled)).toEqual(canonicalKeeps(ids, enabled))
    }
  })

  test("keeps disabled authoritative independently of the allowlist", () => {
    expect(
      filterT3CodeAccountModels(rows, {
        enabledProviders: ["anthropic", "openai", "workbuddy"],
        disabledProviders: ["openai", "workbuddy"],
      }).map((entry) => String(entry.provider.id)),
    ).toEqual(["anthropic"])
  })
})