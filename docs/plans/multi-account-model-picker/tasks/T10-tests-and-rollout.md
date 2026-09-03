# T10 — Parity tests, stories, rollout

**Goal:** Prove the preview matches the router, cover the state space, and ship behind a flag
that can be turned off without regression.

## Steps

### 1. Ranker parity test (the important one)

One fixture table, two runners:

- `packages/opencode/src/plugin/account-policy.test.ts` — feeds `AccountCandidate[]` to
  `rankAccounts`.
- `packages/app/src/utils/account-policy-preview.test.ts` — feeds the *same* fixtures,
  converted through the renderer's quota→candidate mapper, to the mirror.

Assert identical `ordered` ids and identical blocked sets for all three policies. Store the
fixtures in one shared JSON so they cannot drift
(`docs/plans/multi-account-model-picker/fixtures/account-ranking.json` or a `test-fixtures`
package, whichever the repo already prefers).

Fixture coverage: 1/2/5 accounts × {healthy, low, cooling, exhausted, no-credits,
not-entitled, unknown-window} × 3 policies, plus ties.

### 2. Storybook

`packages/app/src/components/dialog-select-model-multi-account.stories.tsx` — every row of
UX-SPEC §4, plus: light/dark, RTL, 40-char email, 5 accounts, all-blocked, tier `labels`.

### 3. End-to-end sanity (manual checklist in the PR)

- [ ] Pin account B mid-session → next message is served by B (`/metrics` bindings confirm).
- [ ] `Auto · Headroom` on a session bound to a drained account → next message goes to the
      richest account, and the binding does **not** stick.
- [ ] `Auto` (sticky) over five turns → same account every turn.
- [ ] Kill the routing endpoint → picker degrades, still selectable.
- [ ] Remove an account with the picker open → no ghost rows, no crash.

### 4. Telemetry (opt-in, local only)

Count: submenu opens, policy selections by policy, explicit pins, rebind toasts, and
`source()` tier distribution. This answers the only question that matters after ship — do
people use the policies, or just pin? Follow whatever local-metrics convention the repo uses;
do not add a new network sink.

### 5. Rollout

- Flag: `experimental.multiAccountPicker` (default **on** in dev, **off** in the first
  release build). Off restores the flat list exactly — the collapse call becomes identity.
- Keep the flag for one release, then delete it and this paragraph.
- Update `packages/app/AGENTS.md` with a short note on the descriptor registry so future
  provider work does not add another `provider.id === "…"` branch.
- Add a `FORK.md` entry describing the OpenFork Auto Router (it is a fork-visible feature).

## Acceptance

- [ ] Parity test green for all fixtures.
- [ ] `bun test`, `bun typecheck`, lint green.
- [ ] Stories render without console warnings.
- [ ] Manual checklist completed and pasted in the PR.
- [ ] Flag off ⇒ byte-identical row list to `main` (snapshot test).

## Risk

- The parity test can pass while both implementations are wrong in the same way. Mitigate
  with at least two fixtures derived from a **real** `/metrics` dump of a multi-account
  machine, not hand-written ones.
