# Cross-platform Git / EOL policy research ledger

Status: implemented runtime/repository guardrails; historical index/worktree EOL debt intentionally not mass-renormalized in the active dirty worktree.

## Problem statement

On Windows, Git can materialize the same LF-normalized index blob as CRLF when ambient Git configuration enables `core.autocrlf=true`. The resulting byte-only worktree churn looks like broad source modification and can be amplified by worktree/reset/checkout operations. Editor settings and mutation-tool EOL preservation cannot prevent this upstream checkout conversion.

The failure was multi-layer:

1. Git for Windows system configuration supplied `core.autocrlf=true`.
2. Some OpenCode Git paths already forced `core.autocrlf=false`; others called raw Git and inherited the host default.
3. Worktree creation/reset therefore depended on which internal Git pathway happened to run.
4. General shell/PTY/process boundaries could launch nested Git with the ambient host policy even when typed Git tools were safe.
5. Correct edit/write/patch preservation could then faithfully preserve an already-polluted CRLF worktree.
6. `.editorconfig` only controls editor writes; it is not a Git checkout policy.

## Reproduction / byte proof

A temporary repository was created with an LF file committed to the index. Under the machine's Git-for-Windows system `core.autocrlf=true`, ordinary linked-worktree materialization produced:

```text
i/lf    w/crlf
61 6C 70 68 61 0D 0A 62 65 74 61 0D 0A
```

The same operation with command-scope `core.autocrlf=false` produced:

```text
i/lf    w/lf
61 6C 70 68 61 0A 62 65 74 61 0A
```

A second PoC used Git's `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` command environment rather than argv `-c`; it also produced LF. An explicit later `git -c core.autocrlf=true ...` still overrides the process default, giving us a deliberate escape hatch without allowing ambient config to decide bytes.

## Canonical invariant

OpenCode owns Git checkout bytes for OpenCode-owned process trees.

- Repository text policy: `.gitattributes`.
- Editor default: `.editorconfig`.
- App-owned process policy: `packages/core/src/git-runtime.ts`.
- Existing-file mutation policy: preserve the target's established local EOL representation unless conversion is explicit.
- User/global Git configuration: convenience only, never required for correctness.

The default Git process policy is:

```text
core.autocrlf=false
core.eol=lf
```

Repository attributes are:

```gitattributes
* text=auto eol=lf
*.bat text eol=crlf
*.cmd text eol=crlf
```

Binary files remain binary through `text=auto`. Windows batch entrypoints are the narrow checkout exception.

## Runtime architecture

`GitRuntime.environment()` is the process-boundary source of truth. It:

- inherits the appropriate base environment;
- preserves valid pre-existing `GIT_CONFIG_COUNT` pairs in order;
- discards malformed runtime-config sequences instead of propagating a Git startup failure;
- appends the canonical EOL policy so ambient command-scope values cannot defeat it;
- handles Windows environment-key case insensitivity when merging explicit overrides;
- canonicalizes its own `GIT_CONFIG_*` keys;
- leaves a later explicit Git argv `-c` as the intentional per-command override.

`GitRuntime.args()` derives its argv defaults from the same `eolConfig` tuple. There is no second literal copy of the policy.

The policy is applied at all general process boundaries that can transitively execute Git:

- core `CrossSpawnSpawner` (Effect/AppProcess and shell descendants);
- core PTY creation;
- legacy `Process.spawn/run`;
- nested JavaScript runtime rerouting;
- Claude child-process port;
- typed Git services and direct app-owned Git invocations.

Internal checkpoint code no longer uses direct `Bun.$\`git ...\`` calls. It routes through the shared V1 Git service, including shadow-repository `read-tree`, `checkout-index`, `ls-tree`, `commit-tree`, and `update-ref` operations.

## Worktree materialization

The V1 Worktree service previously had a private raw-Git helper. That bypass violated the single-source-of-truth rule and was the direct architectural analogue of the reproduction. It now delegates to `Git.Service.run`, so `worktree add`, `reset --hard`, fetch, submodule reset/clean, and status share the same Git policy.

The core Git worktree implementation likewise uses `GitRuntime.args()` for direct Git process calls.

## Mutation boundary

Canonical repository LF does **not** mean every existing file is blindly rewritten during an edit.

Write/edit/patch paths retain their established behavior:

- an existing uniform CRLF file remains CRLF during a semantic edit;
- an existing LF file remains LF even when model/patch transport text contains CRLF;
- mixed-EOL files preserve unaffected separator regions;
- transport newline syntax is not allowed to rewrite unrelated source bytes.

This separation matters: Git materialization decides checkout policy, while mutation tools preserve local file intent. Conflating the two causes whole-file churn.

## Historical debt

The active OpenCode worktree already contained substantial EOL debt before this policy was installed. A representative audit observed thousands of `i/lf w/crlf` entries plus legacy `i/crlf` and mixed index entries.

That debt is deliberately **not** repaired in the current dirty worktree. A broad checkout, reset, `git add --renormalize .`, formatter pass, or line-ending rewrite would commingle unrelated in-progress work and violate dirty-worktree safety.

Adding `.gitattributes` itself was tested in a disposable detached worktree and does not by itself stage thousands of changes. Historical CRLF index blobs remain historical until a dedicated normalization migration.

## Future one-time normalization migration

Run only from a dedicated clean worktree after current feature work is settled:

1. verify the repository is clean;
2. verify `.gitattributes` is present and reviewed;
3. record `git ls-files --eol` counts;
4. run `git add --renormalize .`;
5. inspect the complete staged diff and specifically audit executable/scripts, generated assets, snapshots, fixtures, and intentional CRLF files;
6. prove no semantic content changed beyond intended normalization;
7. commit normalization separately from feature work;
8. clone/materialize on Windows and POSIX and compare `git status --porcelain` after checkout;
9. retain explicit attribute exceptions rather than weakening the process invariant.

## Negative invariants / tests

The regression suite must continue proving:

- hostile inherited `core.autocrlf=true` resolves to `false` inside OpenCode-owned children;
- `core.eol` resolves to LF through the same policy;
- explicit later `git -c core.autocrlf=true` still wins;
- a real linked worktree created under hostile inherited config materializes committed LF bytes as LF;
- explicit non-extended child environments remain isolated except for the Git invariant itself;
- Windows differently-cased environment overrides cannot create two logical `GIT_CONFIG_*` variables;
- CRLF/mixed source mutation tests remain byte-preserving;
- checkpoint restore/materialization stays on the shared Git service rather than reintroducing raw Git subprocesses.

## Audit rule

When adding a new process or Git execution path, reviewers should ask two separate questions:

1. Does this child-process boundary derive its environment from `GitRuntime.environment()` (directly or through the central spawner/process abstraction)?
2. If this code invokes Git directly, does argv derive from `GitRuntime.args()` or the shared Git service?

A new private raw-Git materialization path is an architectural regression even if a local `-c core.autocrlf=false` makes the immediate test pass.
