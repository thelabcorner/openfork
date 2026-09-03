# Provider Matrix — Multi-Account Model Picker

> One row per provider that the model selector must handle. Columns describe what the
> provider *already* does today, and what the collapse/submenu layer needs from it.

## 1. Today

| Provider | Multi-account? | Exposed id shape | Bare (auto) id? | Account label source | Server-side router | Per-account quota in `ProviderResult` | Picker usage surface today |
|---|---|---|---|---|---|---|---|
| `workbuddy` | **Yes** | `<model>[#ctx-N]@wb-<hash>` (`workbuddy.ts:1185-1194`) | Yes, but only from `accounts[0]`'s catalog (`:1253-1261`) — **gap, see T3** | `accountLabels()` → nickname/email, baked into `Model.name` (`:1160`) | `AccountRouter` session-affine + 429 rotation (`workbuddy-accounts.ts:598`) | `usage.workbuddyAccounts[]` + `usage.accountLabels` (`quota/providers/workbuddy.ts:362-461`) | Full: credits bar, rate, promo badge, `modelVariants()` (`use-workbuddy-usage`) |
| `verdent` | **Yes** | `<model>@vd-<hash>` (`verdent.ts:2384-2392`) | Yes, for the whole catalog (`:2381-2384`) | `verdentAccountLabels()`, baked into `Model.name` (`:2328`) | `VerdentRouter`, same shape (`verdent-accounts.ts:591`) | `usage.verdentAccounts[]` (`quota/providers/verdent.ts:203-210`) | **None** — no hook, no bar, no badge. Fixed as a side effect of T2 |
| `openrouter` | No (one key, many upstreams) | plain | n/a | n/a | OpenRouter's own | `credits` + free-tier report | Sub-provider submenu (the pattern we borrow) |
| `genspark` | No | plain | n/a | n/a | n/a | credits | `use-genspark-usage` |
| `opencode-go` | Multi-**credential**, not multi-account-per-model | plain | n/a | Fork credential label | key switcher (`fork-client`) | `byCredential[]` | 5h window bar |
| everything else | No | plain | n/a | n/a | n/a | varies | varies |

**`opencode-go` note.** It is multi-credential, but the credential is chosen by a *global*
key switcher (`dialog-credential-switcher.tsx`), not per model id — so it does not produce
duplicate rows and is explicitly out of scope. If it ever exposes per-credential model ids,
it becomes a descriptor like any other.

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
  verdent: {
    id: "verdent",
    accountPrefix: "vd-",
    accountsField: "verdentAccounts",
    aliasMarkers: [],
    policies: ["sticky", "headroom", "spread"],
    headroomKind: "window",        // no credit pool; per-(account,model) 24h windows
    autoLabelKey: "dialog.model.account.auto",
  },
} as const satisfies Record<string, MultiAccountProvider>
```

`headroomKind` is the only behavioural fork in the UI: `credits` renders
"1,204 credits · resets …", `window` renders "~412 requests · resets …". Both come out of
the same normalized `AccountOption.headroom`.

## 3. Semantic differences that the normalizer must absorb

| Concept | WorkBuddy | Verdent | Normalized as |
|---|---|---|---|
| Funding unit | credit pool (Basic/Gift/Extra; only Basic gates — `use-workbuddy-usage/index.ts:24-26`) | none; free-tier 5h + weekly buckets (`quota/providers/verdent.ts:15-20`) | `headroom.kind` |
| Per-(account,model) limit | promo models Hy3/Hy4 have inferred 24h frequency windows (`workbuddy-model-entitlement.ts`) | governor windows, with hy3/hy4 placeholders filtered (`verdent.ts:104`) | `remainingPercent` + `resetAt` |
| "Exhausted" | `packageCreditsRemaining <= 0` blocks **every** model, even promo ones (Tencent balance check — `workbuddy-accounts.ts:625-629`) | governor `QUOTA_EXHAUSTED` | `state: "exhausted"` |
| Catalog membership | `account.catalog.ids` per account, live-discovered (`workbuddy.ts:787-819`) | shared catalog, all accounts | `servesModel` (undefined ⇒ assume yes) |
| Account id stability | `stableAccountIdentity()` (uid hash) | `stableVerdentIdentity()` | opaque string |
| Header vs id routing | id suffix **and** baked `X-WorkBuddy-Account` header per model (`:1245`) | id suffix decoded in `chat.headers` → `x-verdent-account` (`verdent.ts:2400-2403`) | irrelevant to the UI; both honour the id |

## 4. Adding a third multi-account provider — the checklist

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
