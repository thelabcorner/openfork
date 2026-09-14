# T16 - Zen, Go and subscription runtime tenantization

**Lane:** provider expansion  
**After:** T10, T13  
**Unlocks:** hosted support for subscription/account-pooled providers  
**Primary repo:** OpenFork, with PresGen integration fixtures as needed  
**Critical path:** no for first-wave API-key hosted v1  
**Architecture refs:** sections 5.9, 14, phase 7, D15

## Objective

Tenantize provider paths that currently depend on module-global account pools,
local subscription auth state, CLI/device credentials, or other state that is
not safe to share across hosted tenants.

This task proceeds **provider family by provider family**. A provider remains on
the per-session compatibility lane until its own certification is complete.

Initial families to evaluate:

- OpenCode Zen;
- OpenCode Go;
- Claude subscription / Claude Code auth-context paths;
- Codex subscription / OpenAI auth-context paths if enabled by PresGen;
- Verdent / WorkBuddy style account pools only if PresGen intends to expose
  them in hosted mode.

Do not bundle every provider into one giant all-or-nothing rewrite.

## Why this is separate from T10

The first-wave API-key providers can consume the generic T09 credential
resolver with comparatively small surface changes.

Subscription/account-pooled providers may own:

- module-global account maps;
- cooldown/failure state;
- device/team identity;
- refresh tokens/cookies;
- filesystem auth files;
- background sync timers;
- request governor state;
- provider-specific profile/catalog caches;
- child CLI processes;
- environment-variable fallbacks.

Each of those needs explicit tenant ownership and lifecycle.

## Owned surfaces

Provider-specific, for example:

- `packages/opencode/src/plugin/zen.ts`
- `packages/opencode/src/plugin/zen-accounts.ts`
- `packages/opencode/src/plugin/workbuddy*.ts`
- `packages/opencode/src/plugin/verdent*.ts`
- Claude/Codex binding/runtime/auth-context modules
- quota/usage modules tied to those providers
- provider-specific tests and T10 certification registry

Use separate commits per provider family where practical.

## Per-provider audit template

Before editing a provider, document:

```text
provider family
auth material source
durable authority
module-global mutable state
filesystem paths
process.env reads/writes
timers/background sync
request/client/socket pools
rate/cooldown state
quota/usage state
device/account identity
child processes
hosted target scope for each item
```

If any item lacks a safe target scope, keep the provider disabled in hosted
mode.

## Tenantization requirements

### Account pools

Module-global pools become tenant-realm services or location services as
appropriate.

Tenant A account/cooldown/failure state cannot influence Tenant B.

### Vault/credential sources

Hosted mode consumes PresGen/T09 runtime credential sets or a provider-specific
tenant secret adapter. It does not scan the OpenFork service user's home for
another tenant's auth files.

### Refresh/token lifecycle

Refresh single-flight must be scoped to tenant + credential identity.

Rotation/revocation/version semantics follow T09.

### Device/team identity

If upstream provider semantics require a stable account/device identifier,
derive/store it per tenant credential/account, not process-global unless the
provider explicitly defines device identity as machine-wide and sharing is
security-reviewed.

### Governors and cooldown

Concurrency/rate-limit state integrates with T12 using tenant/account identity.
One account's cooldown must not throttle unrelated tenants.

### Child CLI/runtime

Any Claude/Codex/provider child process must use T08 tenant identity,
environment reconstruction, and process cancellation.

No shared hosted server process env is mutated to activate one tenant's CLI
credential.

## Certification workflow

For each provider family:

1. write/extend deterministic fake upstream or fixture;
2. tenantize state;
3. run A/B concurrent canary;
4. run rotation/revocation race;
5. run cooldown/429 isolation;
6. run restart/realm eviction;
7. run child process isolation if applicable;
8. run redaction checks;
9. benchmark hot path;
10. update hosted certification registry only after all pass.

## Required tests

### A/B account isolation

- separate tenant account list/pool;
- same provider account IDs in different tenants do not collide;
- A failure/cooldown does not alter B;
- A refresh does not overwrite B token;
- A quota/usage view does not include B.

### Restart/eviction

- realm eviction stops provider background sync/timers;
- reacquire rebuilds only that tenant provider state;
- process restart starts with no tenant runtime secret until PresGen rebinds;
- stale provider callback from old generation cannot mutate new realm.

### Filesystem/env

- hosted provider does not read global auth file unexpectedly;
- tenant-specific config/cache paths are contained;
- no provider secret process-env mutation during concurrent A/B request.

### Compatibility

Uncertified provider continues working in per-session mode while hosted mode
rejects/routes it explicitly.

## Performance guard

Record per provider:

- account-pool resident memory per hot tenant;
- auth refresh latency;
- provider request TTFT/throughput delta vs per-session mode;
- background sync timer/request rate;
- socket/client count.

Tenantization must not start one high-frequency polling loop per idle registered
tenant. Background work should exist only for hot realms/active credentials and
must stop on eviction.

## Exit criteria

This task may close incrementally.

For each provider marked `certified`:

- all account/secret/cooldown state is tenant-owned;
- T09 no-fallback rule holds;
- T08 child isolation holds where applicable;
- T12 budgets/governors are integrated;
- A/B race tests pass;
- provider added to hosted allowlist.

Providers not satisfying all criteria remain `compatibility` or `disabled`; the
overall task can PASS when the explicitly scoped provider set is complete.

## Handoff

`../results/T16.md` must contain one section per provider family:

| Provider | Hosted status | Tenantized state | Tests | Remaining blocker |
| --- | --- | --- | --- | --- |

Also record any new generic provider-isolation primitives created so future
providers can reuse them rather than inventing another pool.

