# T1 — Account-model identity core + provider registry

**Goal:** One authoritative definition of "what an account-qualified model id is", shared
by the renderer and both plugins. No visible change after this task.

## Context

Three decoders exist and quietly disagree (ARCHITECTURE §3.1):

- `packages/opencode/src/plugin/workbuddy.ts:834` — `decodeAccountModel`, splits on
  `lastIndexOf("@wb-")`, then `decodeWorkBuddyContextModel` for `#ctx-`.
- `packages/opencode/src/plugin/verdent.ts:436` — `decodeVerdentAccountModel`, splits on
  `lastIndexOf("@vd-")`.
- `packages/app/src/hooks/use-workbuddy-usage/index.ts:104` — `splitWorkBuddyModelID`,
  splits on the last `@` and strips `#ctx-N`. Its own comment documents a previous bug
  where it searched for a literal `@wb-` that "never appears in the actual id" — evidence
  that this drift is not hypothetical.

Display names are also account-decorated by the plugins
(`workbuddy.ts:1160`, `verdent.ts:2328`), with WorkBuddy appending a context suffix
*after* the account label.

## Files to touch

- NEW `packages/app/src/utils/multi-account-providers.ts` — `MultiAccountProvider`
  descriptor + `MULTI_ACCOUNT_PROVIDERS` registry (see PROVIDER-MATRIX §2).
- NEW `packages/app/src/utils/model-account-identity.ts` —
  `splitAccountModelID`, `joinAccountModelID`, `isAccountQualified`, `baseModelID`
  (keeps alias markers), `canonicalModelName`, `accountShortLabel`.
- NEW `packages/app/src/utils/model-account-identity.test.ts` — the vector table.
- EDIT `packages/app/src/hooks/use-workbuddy-usage/index.ts` — `splitWorkBuddyModelID`
  becomes a thin wrapper over the shared splitter (keep the export; call sites unchanged).
- EDIT `packages/opencode/src/plugin/workbuddy.ts` / `verdent.ts` — decoders call the
  shared splitter. If cross-package import is undesirable, duplicate the *table*, not the
  logic: add `packages/opencode/src/plugin/account-model-id.ts` and have the renderer util
  re-export from a shared location; either way, **one test vector file** feeds both.

## Steps

1. Define the descriptor type and the two entries. `policies` starts as `["sticky"]` for
   both — T4 widens it.
2. Implement the splitter: find the last `@` **that is followed by a known account
   prefix** (`wb-`, `vd-`) or the reserved `auto:` namespace; everything before is the
   base (alias markers retained), everything after is the account/policy token. Falls back
   to "no account" when the prefix does not match — a model named `foo@bar` stays intact.
3. Implement `canonicalModelName(item, labels)` with the 4-step ladder from
   ARCHITECTURE §3.3. Never use a bare `/\(.*\)$/`.
4. Write the vector table. Minimum cases:
   `hy4-preview`, `hy4-preview#ctx-262144`, `hy4-preview@wb-3f1c9a`,
   `hy4-preview#ctx-262144@wb-3f1c9a`, `hy4-preview@wb-auto:headroom`,
   `glm-5.3-flash-free@vd-ab12cd`, `weird@model-name`, `a@wb-`, `@wb-x`, `""`,
   plus round-trip `join(split(x)) === x` for every valid id.
5. Rewire the three existing decoders; run the existing plugin tests
   (`packages/opencode/src/plugin/tests/workbuddy-accounts.test.ts`) unchanged.

## Acceptance

- [ ] `bun test` green for the new vector file and every existing workbuddy/verdent test.
- [ ] `bun typecheck` green.
- [ ] `grep -rn 'lastIndexOf("@' packages/` returns only the shared splitter.
- [ ] No runtime behaviour change: WorkBuddy picker rows, bars and names are byte-identical
      before/after (compare a screenshot or a serialized `model.list()` snapshot).

## Risk

- **Cross-package import direction.** `packages/app` importing from `packages/opencode/src`
  may not be allowed by the build. Check first; if not, put the module in the shared
  location the two already agree on (or duplicate the tiny pure file and share the test
  vectors via a JSON fixture). Do not let this become a reason to keep three decoders.
- The `auto:` namespace must be reserved *now*, even though T4 implements it, so an old
  renderer never mistakes a policy token for an account id.
