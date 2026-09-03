# Multi-Account Model Picker — Task Plan

Ten tasks. T1–T2 and T5–T6 are the minimum shippable slice ("collapse + submenu with
sticky Auto only"); T3–T4 add the OpenFork router; T7–T10 finish the premium surface.

## Dependency graph

```
T1 identity core (pure)
 ├─► T2 account-usage hook generalisation ──┐
 ├─► T5 selector collapsing ────────────────┼─► T6 row + submenu shell ─► T7 policy & account UI
 │                                          │                              │
 └─► T3 server routing snapshot ────────────┘                              │
       └─► T4 auto policies (sticky/headroom/spread) ─────────────────────►┤
                                                                            ├─► T8 search/keyboard/a11y
                                                                            ├─► T9 spillover surfaces
                                                                            └─► T10 tests + rollout
```

Parallelisable: **T3+T4 (server)** can run alongside **T5+T6 (renderer)** once T1 lands,
because the renderer degrades to tier `quota` without them.

## Task index

| # | Task | Scope | Depends on | Ship gate |
|---|------|-------|-----------|-----------|
| [T1](./tasks/T1-identity-core.md) | Account-model identity + provider registry | pure utils, both packages | — | unit tests green, no behaviour change |
| [T2](./tasks/T2-account-usage-hook.md) | Generalise `use-workbuddy-usage` → `use-account-usage`, add Verdent | renderer hooks | T1 | WorkBuddy picker visually identical; Verdent gains bars |
| [T3](./tasks/T3-routing-snapshot.md) | `/experimental/account-routing` + bare-id catalog union fix | server + plugins | T1 | endpoint advisory-safe; picker unaffected when absent |
| [T4](./tasks/T4-auto-policies.md) | `rankAccounts()` extraction + `sticky`/`headroom`/`spread` | plugins | T3 | existing router tests pass untouched |
| [T5](./tasks/T5-collapse-controller.md) | `collapseAccountVariants()` + controller wiring | renderer | T1, T2 | 60 rows → 12; favorites/recents/current correct |
| [T6](./tasks/T6-row-and-submenu.md) | `ModelRowBody` extraction, `MultiAccountRow`, submenu shell | renderer | T5 | submenu opens with account list; OpenRouter untouched |
| [T7](./tasks/T7-policy-and-account-ui.md) | Policy section, account rows, footer, previews, toasts | renderer | T4, T6 | full UX-SPEC §3 |
| [T8](./tasks/T8-search-keyboard-a11y.md) | Search expansion, keyboard matrix, a11y, perf guards | renderer | T6 | UX-SPEC §6/§7 matrix passes |
| [T9](./tasks/T9-spillover-surfaces.md) | Composer chip, `ModelTooltip`, manage-models, `ModelList` (v1) | renderer | T5 | no duplicate rows anywhere in the app |
| [T10](./tasks/T10-tests-and-rollout.md) | Parity tests, stories, telemetry, flag + rollout | all | T7, T8, T9 | flag default-on, docs updated |

## Definition of done (feature-level)

- [ ] With 4 WorkBuddy accounts enrolled, the picker shows **one row per model**, ranked by
      Usage Yield, and every account is reachable in ≤1 hover + ≤1 arrow key.
- [ ] The "Auto" preview names the same account the server actually routes to, verified by
      the parity test **and** by one manual send per policy.
- [ ] Verdent rows show headroom for the first time.
- [ ] `dialog-select-model.tsx` has no new `provider.id === "<literal>"` branch, and its
      total line count is not higher than before.
- [ ] Picker open → first paint does not regress (measure with the existing perf harness in
      `docs/perf/`).
- [ ] Every new user-facing string is in `i18n/en.ts`; none are hardcoded in TSX.
- [ ] Turning the flag off restores today's behaviour exactly.

## Sequencing notes

- **Land T1 alone first.** It touches both packages and is pure; a clean, separately
  reviewable commit makes the rest bisectable.
- **T5 before T6.** Collapsing with the *existing* row renderer is a legitimate
  intermediate state (rows collapse, submenu not yet available, pinning still reachable via
  search expansion) and is worth its own review.
- **T4 is the risky one.** It edits the router that every WorkBuddy/Verdent request goes
  through. Refactor-first, feature-second: land `rankAccounts()` as a pure extraction with
  the existing tests green *in its own commit*, then add the two new policies.
- **Do not start T7 before T4's endpoint returns real previews** — a preview built on
  guessed data will be quietly wrong and is exactly the failure ADR-3 exists to prevent.
