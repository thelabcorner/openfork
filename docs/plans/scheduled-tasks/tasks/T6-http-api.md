# T6 — Tier-0 HTTP API + SDK regeneration

**Depends on:** T3 T5
**Blocks:** T8  
**Read first:** `04-surface-and-ux.md` § 1; the httpapi `AGENTS.md`

## Scope

One `scheduledTask` group on `RootHttpApi`. Every HTTP operation is Tier 0,
including `runNow`: manual fire at the transport boundary means **durably
enqueue a queued run and return**. The process-global runner/executor performs
the later Tier-3 work.

The group must not carry `InstanceContextMiddleware`, import
`InstanceStore`, or depend on `ScheduledTaskRunner`. The runner is woken from
authoritative domain events in-process and correctness does not depend on that
ephemeral wake.

## Rules

- Follow the established group pattern: yield services once while building the
  handler layer, close over them in endpoint implementations.
- Declare explicit `Schema.ErrorClass` error contracts per endpoint. Do not
  leak domain or storage errors through the handler boundary.
- Keep the core service free of HttpApi types.
- `preview` is pure and touches no database.
- `runNow` writes only durable Tier-0 state. Do not call the runner from the
  handler; notification is an optimization, not the durability boundary.

## SDK

**Regenerate the SDK and commit the result.** Generated client code is never
hand-edited. T6 is not complete until generated types exist and the SDK
typechecks.

## Verification

- D1/D2: every endpoint, including `runNow`, answers with zero Instance loads
  and without directory/workspace context.
- Static ownership test: the scheduled-task HTTP handler imports neither
  `InstanceHttpApi` nor `ScheduledTaskRunner`.
- OpenAPI output exposes one `ScheduledTask` client surface and the
  `/scheduled-task/{taskID}/run-now` operation.
