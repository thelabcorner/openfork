# Tasks — Limits System

## Dependency Graph

```
T1 core-foundation ─┬─ T2 claude
                    ├─ T3 codex
                    ├─ T4 xai
                    ├─ T5 openrouter-both
                    └─ T6 opencode-go-multikey
                              │
                              └─ T7 frontend-system-hook ── T8 limits-panel-premium-ux ── T9 testing
```

All of T2/T3/T4/T5 can land in parallel after T1. T6 needs T1 only. T7 needs T1+T5+T6. T8 needs T7. T9 covers all.

## Sequencing (smallest valuable slices)

1. **T1** — No UX change. Extract shared helpers + hook shell.
2. **T6** — Reuse `useForkUsage` → pane shows all Go keys (hidden flag off). Immediately visible value even before new providers.
3. **T5** — Make OpenRouter show `credits` correctly + merge free report.
4. **T2, T3, T4** — Port upstream adapters (mechanical, isolated).
5. **T7** — Unify `useLimits` (filter, sort, worstRemaining, cooldown). Swap pane to it.
6. **T8** — Premium depletion UX, live countdown, hide-not-connected enforcement.
7. **T9** — Fixture tests, cooldown/parity, gRPC-web/protobuf edge cases.

Each task has its own file under `tasks` with goal/context/files/acceptance.
See `tasks/T1-*.md` … `T9-*.md`.
