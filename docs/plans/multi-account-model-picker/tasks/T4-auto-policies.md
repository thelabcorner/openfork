# T4 — `rankAccounts()` extraction + the three Auto policies

**Goal:** One pure ranking function used by the router *and* by the UI preview, plus two new
routing policies beside today's sticky behaviour.

**This task edits the code path every WorkBuddy/Verdent request goes through. Split it into
two commits: (a) pure extraction with existing tests green, (b) new policies.**

## Context

`AccountRouter.select()` (`plugin/workbuddy-accounts.ts:598-660`) mixes three concerns:
explicit-intent rebinding, session-affinity maintenance with a blocked-account check
(`:617-634`), and eligibility+preference ranking (`:636-660`). Only the third is
policy-dependent. `VerdentRouter` (`verdent-accounts.ts:591`) duplicates it.

The blocked-check has hard-won semantics worth preserving verbatim:

- `QUOTA_EXHAUSTED` state, `!canAdmitModel(model)`, active `cooldownUntil`, **and**
  `!hasKnownCredits()` — the last one because a 0-credit account 402s even on a free promo
  model (Tencent runs its own balance check first).
- Explicit intent is checked **before** affinity; the comment at `:604-612` documents the
  bug that came from doing it the other way round. Do not reorder.

## Files to touch

- NEW `packages/opencode/src/plugin/account-policy.ts` — `AccountCandidate`, `RankReason`,
  `AutoPolicy`, `rankAccounts()` (pure, no I/O, no Date.now default in the hot path).
- NEW `packages/opencode/src/plugin/account-policy.test.ts` — fixture table (shared with
  the renderer mirror in T10).
- EDIT `plugin/workbuddy-accounts.ts` / `plugin/verdent-accounts.ts` — `select()` delegates
  to `rankAccounts`, gains a `policy` parameter.
- EDIT `plugin/workbuddy.ts` / `plugin/verdent.ts` — `decodeAccountModel` /
  `decodeVerdentAccountModel` recognise `@<prefix>auto:<mode>` and pass `policy` through;
  `handleCompletions` forwards it to `select()`.
- EDIT `plugin/workbuddy.ts` `models()` / `verdent.ts` `models()` — **do not** emit one
  model per policy. Policies are selected client-side by rewriting the id; the catalog stays
  bare + per-account.
- EDIT capabilities response — `accountRoutingPolicies: ["sticky","headroom","spread"]`.

## Policy semantics

| Policy | Affinity | Ordering among eligible |
|--------|----------|-------------------------|
| `sticky` | honoured (today's behaviour, unchanged) | funded-first, then today's existing sort |
| `headroom` | **ignored** (re-evaluated per request) | `modelWindow.remainingPercent` desc; tie-break `packageCreditsRemaining` desc; unknowns last |
| `spread` | ignored | `modelWindow.usedObserved` asc; tie-break least-recently-selected; unknowns first (an unused account is the point) |

Ineligibility is identical for all three — policy changes *preference*, never *admission*.
An explicit account id still overrides everything and rebinds.

## Steps

1. **Commit A — extraction.** Move steps 2–3 of `select()` into `rankAccounts(policy:
   "sticky")`; `select()` keeps its signature. `bun test packages/opencode -- workbuddy-accounts`
   must pass with zero test edits. Do the same for Verdent.
2. **Commit B — policies.** Add `headroom` and `spread` branches; thread `policy` from the
   decoded model id; add the `auto:` decoding with the reserved-namespace guard from T1.
3. `spread` needs a per-provider last-selected map (in-memory, keyed by account id) for the
   tie-break; it must not persist and must not leak across providers.
4. Fill the `preview` field of the T3 endpoint by calling `rankAccounts` once per advertised
   policy for the requested model.
5. Reject an unknown policy token by falling back to `sticky` (forward compatibility with a
   newer renderer), and log once at debug level.

## Acceptance

- [ ] `plugin/tests/workbuddy-accounts.test.ts` passes **unmodified** after commit A.
- [ ] New fixtures: 3 accounts × {healthy, cooling, exhausted, not-entitled} × 3 policies,
      asserting exact ordering and `RankReason[]`.
- [ ] `hy4-preview@wb-auto:headroom` routes to the highest-headroom eligible account and does
      **not** rebind session affinity; `hy4-preview` still binds and sticks.
- [ ] An unknown `@wb-auto:whatever` behaves as `sticky`, never as an error.
- [ ] `GET /experimental/account-routing` returns a `preview` entry per advertised policy.

## Risk

- **Silent regression in sticky.** The only real guard is the untouched existing test suite
  plus a manual multi-turn session confirming the session does not hop accounts mid-thread.
  Verify with `/metrics` bindings before and after five turns.
- `headroom` re-evaluating per request means a long session can spread across accounts —
  which is the intent, but it changes cache-locality assumptions upstream. Note it in the
  policy hint copy ("evaluated every message").
