# Native `@models` and OXP `models` tool

## Mission and ownership

`@models` is the lazy, read-only discovery surface for OpenFork's model registry, not
an alternative model router or a second quota tracker. The native Session
adapter is `packages/opencode/src/tool/models.ts`; the public OXP adapter
is `src/oxp/models.ts`. Both use **one** pure, bounded query engine
(`src/models/query.ts`) and the native-only advisory quota projector
(`src/models/quota.ts`). The model catalog itself remains owned by
`Provider.Service` (configured providers) and `ModelsDev.Service`
(public models.dev). Existing `Usage.Service` and `Quota.Service`
remain the only accounting/quota owners.

`ToolRegistry` and `ToolExposure` register `models` as lazy; the Code tool
and native agent Sessions consume that same registration. OXP provides an
actual executable broker target, not merely a catalog entry. OFXP equivalence
is declared in the exchange ledger, with remote capabilities restricted to
their actual principal's permissions. ACP uses native Session tool exposure;
the mappings alone do not constitute end-to-end certification of ACP/OFXP.

## Agent invocation examples

```ts
// Quick native inventory: only active/configured providers
models({ action: "providers" })

// Ranked discovery for reasoning + tools; explicit, stable page size
models({ q: "deepseek", reasoning: true, tools: true, sort: "context",
         order: "desc", limit: 20 })

// Any public catalog model, not necessarily callable with local credentials
models({ scope: "catalog", q: "qwen", zeroCost: true, limit: 30 })

// Exact native provider/model check (do not infer the model ID from its name)
models({ action: "get", providerID: "opencode-go", modelID: "EXACT_RETURNED_ID" })

// Most-used locally over 30 days, using durable settled usage
models({ includeUsage: true, sort: "usage", order: "desc", limit: 25 })

// Advisory quota, one provider only: never causes provider-wide network fanout
models({ providerID: "opencode-go", includeQuota: true, limit: 25 })

// OXP: discover the lazy schema first, then broker call under the read grant
capability.describe("models")
capability.call("models", { q: "deepseek", sort: "context", limit: 10 })

// OXP Session-only usage enrichment additionally requires permission to
// supervise that exact existing Session. It never exposes global usage.
capability.call("models", { includeUsage: true, sessionID: "SUPERVISED_SESSION_ID" })
```

## Result truth levels and authority

| Dimension | Native Session | OXP / broker |
|---|---|---|
| Configured model inventory | `scope=configured` default | Forbidden (host-private) |
| Public model inventory | `scope=catalog` | Default source |
| Model capability/cost metadata | Whitelisted public/provider fields | Whitelisted public fields |
| Historical usage | Opt-in, bounded top 100 models / 30 days | Opt-in, only supervised Session |
| Quota/account windows | Opt-in, **one** provider's snapshot | Forbidden |
| Execute model / select account | Not performed | Not performed |

**Do not conflate:**

- Published zero input/output prices with free account access, active entitlement,
  or remaining usage limits.
- Presence in models.dev with availability from a locally configured provider.
- Missing usage rows with zero usage: native reads at most the 100 most-used
  indexed models in its 30-day window.
- A quota window reading 0% with a hard inference failure. Provider responses
  can be stale, account-specific, or missing; provider retry/routing remains
  the authoritative runtime mechanism.
- One exhausted WorkBuddy account with all accounts exhausted. The model
  projector preserves observed account counts but suppresses account labels.

OXP performs `info.models` read-grant admission for rootless *public*
model metadata and revalidates at egress. Session enrichment additionally
uses `OxpSupervision.resolve` and separately revalidates Session authority.
No authentication keys, provider options, raw quota window labels, or
workspace instance bootstrap are accepted in the shared projection.

## Performance and boundedness

- Provider enumeration is O(total models); search/filter are one pass with
  precomputed normalized query terms.
- Deterministic in-memory sort is O(M log M), keyed by provider/model ID.
  Release-date parse costs are amortized over unique date strings per query.
- Native usage does one indexed `Usage.inspect` breakdown on explicit request,
  never hydrates Session message bodies.
- Quota performs at most one existing `Quota.get` (adapter already single-flight),
  only if explicitly requested with a provider ID; it honors the adapter's
  existing caching/freshness policy.
- Result pages: default 25, hard maximum 100, hard offset maximum 100,000.
  Provider summary pages are bounded too.
- All outputs use allowlisted model scalars; no provider keys/configuration
  objects are returned. Raw quota window labels and personal account IDs are
  suppressed. Quota snapshots expose observation and reset timestamps and
  distinguish shared provider pools from specific model/account observations.
- The 10,000-row synthetic test searches, sorts and returns 25 rows in
  approximately 15–20 ms on the development machine. This is a targeted
  local test, not an end-to-end provider-catalog or quota-fetch benchmark.

## Verification

```sh
cd packages/opencode
bun test test/tool/models.test.ts test/tool/models-quota.test.ts
bun test test/oxp/capability.test.ts -t models
bun test test/oxp/tool-parity-doc.test.ts test/oxp/tool-parity-matrix.test.ts
bun run typecheck
```

Package-wide typecheck has unrelated existing failures in the dirty checkout;
verify the actual error list before attributing errors to this tool.
No changes to real provider routes, account selection, session retry policies,
or persistent user data are authorized by this capability.
