# Provider Matrix — Multi-Account Model Picker

> One row per provider that the model selector must handle. Columns describe what the
> provider *already* does today, and what the collapse/submenu layer needs from it.

## 1. Today

| Provider | Multi-account? | Exposed id shape | Bare (auto) id? | Account label source | Server-side router | Per-account quota in `ProviderResult` | Picker usage surface today |
|---|---|---|---|---|---|---|---|
| `workbuddy` | **Yes** | `<model>[#ctx-N]@wb-<hash>` (`workbuddy.ts:1185-1194`) | Yes, but only from `accounts[0]`'s catalog (`:1253-1261`) — **gap, see T3** | `accountLabels()` → nickname/email, baked into `Model.name` (`:1160`) | `AccountRouter` session-affine + 429 rotation (`workbuddy-accounts.ts:598`) | `usage.workbuddyAccounts[]` + `usage.accountLabels` (`quota/providers/workbuddy.ts:362-461`) | Full: credits bar, rate, promo badge, `modelVariants()` (`use-workbuddy-usage`) |
| `opencode` | **Yes** | `<model>@zen-<hash>` | Yes | unified Zen env/vault pool label | explicit suffix or automatic ProviderRoute/Zen pool selection | `usage.zenAccounts[]` | Window/headroom account surface |
| `opencode-go` | **Yes** | `<model>@zen-<hash>` | Yes; bare Go preserves its direct-provider bearer before pool fallback | unified Zen env/vault pool label | explicit suffix or automatic ProviderRoute/Zen pool selection | `usage.zenAccounts[]` | Window/headroom account surface |
| `openrouter` | No (one key, many upstreams) | plain | n/a | n/a | OpenRouter's own | `credits` + free-tier report | Sub-provider submenu (the pattern we borrow) |
| `genspark` | No | plain | n/a | n/a | n/a | credits | `use-genspark-usage` |
| everything else | No | plain | n/a | n/a | n/a | varies | varies |

**Zen/Go note.** Both providers now share the same unified Zen account pool and
publish account-qualified model ids. Go still retains its independent
direct-provider credential precedence for a bare model selection; an explicit
`@zen-...` model always names the selected pool account.

## 2. Capability descriptor per provider

```ts
export const MULTI_ACCOUNT_PROVIDERS = {
  workbuddy: {
    id: "workbuddy",
    accountPrefix: "wb-",
    accountsField: "workbuddyAccounts",
    aliasMarkers: ["#ctx-"],
    policies: ["sticky", "headroom", "spread"],
    headroomKind: "credits",       // pool balance funds every model
    autoLabelKey: "dialog.model.account.auto",
  },
  opencode: {
    id: "opencode",
    accountPrefix: "zen-",
    accountsField: "zenAccounts",
    aliasMarkers: [],
    policies: ["sticky"],
    headroomKind: "window",
    autoLabelKey: "dialog.model.account.auto",
  },
  "opencode-go": {
    id: "opencode-go",
    accountPrefix: "zen-",
    accountsField: "zenAccounts",
    aliasMarkers: [],
    policies: ["sticky"],
    headroomKind: "window",
    autoLabelKey: "dialog.model.account.auto",
  },
} as const satisfies Record<string, MultiAccountProvider>
```

`headroomKind` is the only behavioural fork in the UI: `credits` renders
"1,204 credits · resets …", `window` renders "~412 requests · resets …". Both come out of
the same normalized `AccountOption.headroom`. WorkBuddy exercises the
`credits` branch; Zen and Go exercise `window`. Keep this descriptor-driven
so another provider remains a registry entry rather than a picker branch.

## 3. Semantic differences that the normalizer must absorb

| Concept | WorkBuddy today | Normalized as |
|---|---|---|
| Funding unit | credit pool (Basic/Gift/Extra; only Basic gates — `use-workbuddy-usage/index.ts:24-26`) | `headroom.kind` |
| Per-(account,model) limit | promo models Hy3/Hy4 have inferred 24h frequency windows (`workbuddy-model-entitlement.ts`) | `remainingPercent` + `resetAt` |
| "Exhausted" | `packageCreditsRemaining <= 0` blocks **every** model, even promo ones (Tencent balance check — `workbuddy-accounts.ts:625-629`) | `state: "exhausted"` |
| Catalog membership | `account.catalog.ids` per account, live-discovered (`workbuddy.ts:787-819`) | `servesModel` (undefined ⇒ assume yes) |
| Account id stability | `stableAccountIdentity()` (uid hash) | opaque string |
| Header vs id routing | id suffix **and** baked `X-WorkBuddy-Account` header per model (`:1245`) | irrelevant to the UI; the id is honoured either way |

`headroomKind: "window"` is now exercised by the live Zen/Go descriptors.
Future providers should still enter through the registry rather than adding
provider-specific picker branches.

## 4. Adding a new multi-account provider — the checklist

1. **Plugin**: expose `<model>@<prefix><accountId>` ids, bake the label into `Model.name`,
   and emit bare ids for the *union* of all accounts' catalogs.
2. **Router**: use `rankAccounts()` from `plugin/account-policy.ts`; accept the `policy`
   argument; treat an explicit account as a rebind.
3. **Quota adapter**: emit `usage.<provider>Accounts[]` in the `WorkBuddyAccountLimits`
   shape (`quota/schema.ts:118-122`) and `usage.accountLabels`.
4. **Routing endpoint**: register the registry/router pair so
   `/experimental/account-routing?provider=<id>` can read it.
5. **Renderer**: add one entry to `MULTI_ACCOUNT_PROVIDERS`.
6. **Tests**: add the provider's id vectors to `model-account-identity.test.ts` and one
   Storybook story.

Steps 5 and 6 are the only renderer work. If a new provider requires a change to
`dialog-select-model.tsx` itself, the descriptor is missing a field — add the field rather
than the branch.
