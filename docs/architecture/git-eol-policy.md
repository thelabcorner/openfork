# Git line-ending policy

## Invariant

OpenFork-owned execution must never let an ambient host Git configuration silently
rewrite repository text from LF to CRLF. Repository attributes are the durable file
policy; process-scoped Git configuration is the runtime backstop.

The canonical defaults are:

- `core.autocrlf=false`
- `core.eol=lf`
- repository text: `* text=auto eol=lf`
- Windows batch entrypoints: `*.bat` / `*.cmd` use `eol=crlf`
- editors: `.editorconfig` uses `end_of_line = lf`

An explicit later `git -c ...` remains the intentional escape hatch. Git documents
command-scope `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` as
overriding config files while still being overridden by explicit `-c` options.

## Ownership

`packages/core/src/git-runtime.ts` is the source of truth for the values and their
precedence. Do not duplicate the literal policy in new call sites.

Runtime enforcement happens at process owners, not consumers:

- `CrossSpawnSpawner` injects the command-scope policy into Effect-owned children and
  therefore the V1 shell/background/tool process tree.
- `Pty` injects it into interactive terminal descendants.
- the legacy `Process` helper, nested JavaScript reroute, and Claude process port apply
  the same policy at their independent process boundaries.
- direct Git wrappers use `GitRuntime.args(...)` as an additional argv-level rail.
- Worktree materialization routes through the shared Git service rather than a private
  raw-Git subprocess.

This makes the invariant independent of Git-for-Windows system/global configuration.

## Mutation semantics are a separate layer

Git materialization policy and file-mutation policy solve different problems. Existing
files may intentionally contain CRLF or mixed terminators, so model-facing edit/write/
patch operations must preserve the target's local bytes rather than flattening every
mutation to LF. V1 edit/write and V2 `FileMutation` share terminator-aware behavior;
their regression suites cover LF, CRLF, and mixed-EOL targets.

Shell text transport is not a substitute for file mutation when exact bytes matter.
In particular, the Windows shell launcher refuses Bash-heredoc compatibility forms
whose LF bytes cannot be preserved through PowerShell. Prefer the write/patch tools or
an explicit file body for exact multiline content.

## Existing repositories and normalization

Adding attributes is not permission to renormalize a dirty shared worktree. Historical
blobs that were already committed with CRLF remain historical data until a deliberate
normalization migration is performed from a clean worktree.

When that migration is intentionally scheduled, use a clean checkout/worktree, inspect
`git add --renormalize --dry-run .`, classify intentional binary/CRLF exceptions first,
then commit normalization separately. Never mix it with feature work.

## Regression proof

Tests must preserve the negative invariant, not merely assert helper output:

1. simulate hostile inherited `core.autocrlf=true`;
2. verify OpenFork resolves Git to `core.autocrlf=false`;
3. verify explicit later `git -c core.autocrlf=true` still wins;
4. materialize a real linked worktree containing an LF file and assert its bytes remain LF.

A future process-launch abstraction that can spawn Git (directly or transitively) must
either pass through an existing enforced owner or apply `GitRuntime.environment` itself.

## Performance and resource invariants

The runtime policy is deliberately spawn-boundary work only. It creates no timers,
watchers, subprocesses, background fibers, or retained caches. Environment processing is
`O(E + C)` in the inherited environment size `E` plus command-scope Git config count `C`.
The Windows override path builds one casing index rather than rescanning `E` for each
override. Direct Git argv defaults are precomputed once at module load.

Do not cache a complete `process.env` snapshot or mutate the parent environment to save a
small per-spawn copy. OpenCode and its tests intentionally change environment variables at
runtime; stale/global state would be a semantic regression. Reapplying the policy must stay
idempotent: nested OpenCode descendants retain one canonical EOL pair instead of growing
`GIT_CONFIG_*` entries with process depth.
