# TypeScript / Effect compiler frontier (opt-in)

**Owner:** repository-level development tooling. **Status:** experimental, non-authoritative.
**Baseline:** existing `bun run typecheck` / workspace `tsgo` scripts remain unchanged.

## Why this exists

OpenFork's monorepo uses Effect heavily, but an ordinary native TypeScript check does
not necessarily execute `@effect/language-service` diagnostics. The experimental
[ts-rust project](https://github.com/pingdotgg/ts-rust) ports TypeScript's native
compiler to Rust and incorporates the Effect diagnostic rules (377xxx), provided the
project's `compilerOptions.plugins` includes `@effect/language-service`.

This is **a developer validation tool**, not a runtime or app-performance optimization.
The compiler is preliminary. The pinned compiler used during the first trial was
`tsc-rs@0.1.0` (TypeScript 7.1.0-dev, upstream TypeScript pin 2026-09-29).
Our installed `tsgo` reports TypeScript 7.0.0-dev.20251207.1. Compiler differences
may be attributable to TypeScript _version_, not defects in the Rust port.

## Commands

From the repository root:

```sh
# Pure parser/policy tests; does not require a Rust executable.
bun run typecheck:frontier:test

# Existing authoritative typecheck, unchanged:
bun run typecheck

# Observe TS diagnostic parity and Effect findings in four opt-in Effect packages:
node script/typecheck-frontier.mjs --rust-bin /absolute/path/to/tsc-rs

# Linux-to-Linux benchmark (same OS and filesystem, after matching project semantics):
node script/typecheck-frontier.mjs --rust-bin /absolute/path/to/tsc-rs \
  --packages llm,core --warmup 1 --repeats 5 --gate parity \
  --output /tmp/openfork-typecheck-frontier.json

# Include the new, independent Effect configurations for the largest packages:
node script/typecheck-frontier.mjs --packages core,opencode \
  --rust-bin /absolute/path/to/tsc-rs --gate observe

# Query optional Bun checker discrepancies:
node script/typecheck-frontier.mjs --checkers tsgo,rust,bun \
  --packages llm --rust-bin /absolute/path/to/tsc-rs
```

The default package selection is `llm,effect-drizzle-sqlite,effect-sqlite-node,http-recorder`.
Use `--packages all` for all enumerated workspaces or `--packages core,opencode`
for an explicit subset. `--checkers` accepts a comma-separated subset of
`tsgo,rust,bun`.

### Install Rust separately, pinned

Avoid modifying the primary worktree's `bun.lock` or installing an experimental
compiler into the authoritative dependency graph.

On a supported Linux x64 (or macOS arm64) development machine, install
`tsc-rs@0.1.0` in an isolated prefix, not inside OpenFork:

```sh
mkdir -p /tmp/openfork-rust-typecheck
npm install --prefix /tmp/openfork-rust-typecheck --no-save tsc-rs@0.1.0
node script/typecheck-frontier.mjs \
  --rust-bin /tmp/openfork-rust-typecheck/node_modules/.bin/tsc-rs
```

Check `npm view tsc-rs@0.1.0` and the precise downloaded executable before
using a different version. The `--version` of `tsc-rs` prints the TypeScript
compiler revision (7.1.0-dev), **not** its npm package version. The CLI never
downloads executables or silently falls back to another compiler.

### Windows / WSL2

There is **no official native Windows binary for `tsc-rs@0.1.0`**. In Windows
developer environments, run the standalone _Linux_ binary under WSL2:

```powershell
node script/typecheck-frontier.mjs --wsl `
  --rust-bin /absolute/linux/path/to/tsc `
  --rust-types llm=bun `
  --rust-types effect-drizzle-sqlite=bun `
  --rust-types effect-sqlite-node=node `
  --rust-types http-recorder=node `
  --output ../openfork-frontier-report.json
```

The `--rust-types` overrides are **explicit workarounds**, not parity proofs.
When evaluating missing ambient types on a Windows-mounted checkout, the Rust
toolchain may need `--types bun` or `--types node` even though native Windows
`tsgo` resolves the same project. The runner never invents these overrides.
When no explicit override is supplied, missing ambient types are reported as
ordinary compiler diagnostics; they are not silently ignored.

WSL2 startup, mount traversal, and cross-process execution produce significant
overhead. **Never interpret Windows-`tsgo` vs WSL2-`tsc-rs` timings as native
compiler speedup or slowdown.** The JSON report marks this with
`environment.mixedRuntime=true`. For production-grade performance evidence, run
both native binaries on **one Linux host**, with comparable caches, warmed runs,
the same files/configs and recorded versions. Compare at least five repetitions
after warmup; prefer medians and report variance. The runner alternates checker
execution order between repetitions to reduce warmed-cache bias.

For a diagnostic/performance comparison inside the **same WSL2 environment**,
provide a separately installed Linux `tsgo` and use `--wsl-tsgo`
with `--tsgo-bin /absolute/linux/path/to/tsgo`, as well as the `--wsl`
and `--rust-bin` flags. This avoids Windows-vs-WSL process asymmetry, but
WSL startup and Windows-mounted filesystem latency still mean the results
should not be interpreted as native Linux measurements.

Composite TypeScript projects are checked with `--noEmit` and a unique,
disposable `--tsBuildInfoFile` outside the checkout for every invocation;
the file is deleted even on invocation failure. `bun check` never emits.
This does not convert `-p` into `-b`, so composite project-reference graphs
may still require separate validation under the authoritative existing scripts.

## Diagnostic semantics

The tool parses diagnostic location + severity + code into a stable, normalized
identity and compares **ordinary TypeScript** diagnostic multisets without
dropping duplicates or mistakenly comparing message wording.
Missing and introduced errors are reported independently.

Effect diagnostic codes (377xxx) are deliberately **not included** in the ordinary
TypeScript parity check: they are classified and counted as Effect errors,
warnings, or suggestions. In the default observation mode, TypeScript and
Effect errors remain visible, but do not fail the process. Subprocess launch
errors, timeouts, and otherwise unexplained nonzero exits **always** fail.

Three explicit gate levels are supported:

| Gate             | Behavior                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--gate observe` | Report only; no diagnostic gate. Never marks a broken compiler invocation as success.                                  |
| `--gate parity`  | Require `tsgo` + `rust`; fail if TypeScript location/code/severity multiset differs.                                   |
| `--gate strict`  | Require parity and also fail if Rust emits TypeScript errors or Effect errors. Warnings/suggestions are informational. |

Machine-readable reports are opt-in. An `--output` target must be outside
the OpenFork checkout and not already exist. Reports are created exclusively
to protect concurrent work; reruns must choose a fresh output filename.
Observed compiler errors do not count as a passing **strict** check, and
missing/failed compiler executions are fatal even in observation mode.

The `--effect auto` option prefers `tsconfig.effect-frontier.json` for Rust
if a package has one; `--effect off` only disables this **additional overlay**.
It does _not_ disable Effect plugins already declared in ordinary tsconfig files
(such as `packages/llm/tsconfig.json`).

Dedicated additive configurations exist for `packages/core` and
`packages/opencode` and extend the authoritative configs without changing
existing typecheck scripts. They allow broadening Effect diagnostic coverage
without forcing untriaged Effect rules onto every CI job.

Some type-only fixtures intentionally leave Effect expressions unused
(`packages/llm/test/tool.types.ts`); those currently trigger floating-Effect
errors. Categorize intentional tests, document defensible suppressions in the
fixture when needed, and validate against an independent Effect checker before
enforcing strict mode. Do not disable a whole diagnostic family just to force a
green result.

## Initial primary-worktree experiment (2026-10-08)

Ran on Windows x64 with Rust in WSL2 against the same primary checkout.
Because runtime environments differ, figures below are **diagnostic counts,
not a performance comparison**.

| Package                 | Ordinary TypeScript parity       | Extra Rust Effect diagnostics        |
| ----------------------- | -------------------------------- | ------------------------------------ |
| `llm`                   | Match (0 vs 0 TypeScript errors) | 4 errors, 1 warning, 102 suggestions |
| `effect-drizzle-sqlite` | Match (0 vs 0)                   | 1 warning, 6 suggestions             |
| `effect-sqlite-node`    | Match (0 vs 0)                   | 0                                    |
| `http-recorder`         | Match (0 vs 0)                   | 8 suggestions                        |

The expanded Effect overlay experiment found:

| Package    | Ordinary TS parity                | Rust Effect errors | Warnings | Suggestions |
| ---------- | --------------------------------- | -----------------: | -------: | ----------: |
| `core`     | Match: 5 existing errors in both  |                 25 |       69 |         742 |
| `opencode` | Drift: 22 Go vs 24 Rust TS errors |                 25 |      419 |       1,786 |

The two additional Rust diagnostics in `opencode` are both TS2345 at
`src/ofxp/certificate.ts:137-138`: the current `pkijs.CryptoEngine` is not
assignable to `ICryptoEngine` due to `generateKey` overload signatures
(including X25519). Because Rust is based on TS 7.1-dev and the installed Go
checker is based on TS 7.0-dev, this is a **version-skew investigation**, not
proof of a compiler defect or justification for changing cryptography.

The dominating Effect rules include TS377098 (finite number schemas), TS377091
(lazy Effect wrappers), and TS377023 (untagged global Error in Effect failures).
Some TS377001 floating Effects occur in runtime code, others in intentional
test fixtures. Prioritize actual runtime correctness defects rather than
bulk-rewriting thousands of suggestions.

The baseline itself is a **dirty primary worktree**, not a clean-tree release
verification. The experiment neither fixes nor conceals these existing errors.

### Same-environment WSL2 follow-up

For these **two scoped packages**, I used a separately installed Linux x64
`tsgo` (7.0.0-dev.20251207.1) and `tsc-rs` (7.1.0-dev from `tsc-rs@0.1.0`)
under the **same WSL2 filesystem mount**, one warmup per checker, then five
measured, alternating-order repetitions:

| Package              |   Go median | Rust + Effect median | Observed ratio | Ordinary TS parity |
| -------------------- | ----------: | -------------------: | -------------: | ------------------ |
| `llm`                | 3,120.63 ms |          2,699.42 ms |          1.16× | Match              |
| `effect-sqlite-node` | 1,479.59 ms |            952.43 ms |          1.55× | Match              |

The ratio is `Go median / Rust median`: larger than 1 means Rust took
less elapsed time. The `llm` Rust run **also ran its Effect diagnostics**,
while Go's standard check did not. This is promising, but measurements
still include WSL launch overhead and Windows-mounted filesystem latency.
Compiler versions also differ. Do not generalize these ratios to OpenFork's
whole monorepo or native Linux until a controlled native run corroborates them.

The manual-only `.github/workflows/experimental-ts-rust-frontier.yml` workflow
is owner-gated, runs only on the approved homelab runner, installs Rust into an
isolated prefix, and uploads a JSON diagnostic report. It does not modify the
default CI workflow or establish a new release gate.

## Promotion criteria

1. Validate all intended workspaces, including composite/reference projects,
   without introducing build artifacts or changing the authoritative compiler.
2. Make cross-compiler ambient type inclusion and TypeScript version explicit.
3. Keep normal TS parity a separate gate from newly introduced Effect rules.
4. Triage Effect errors as genuine defects vs type-level fixture expectations.
5. Collect equivalent native timings; promote only on measured Pareto gains.
6. Test failure paths and maintain the option to disable/remove this lane without
   changing production build, runtime, or editor behavior.

OpenFork's root `typecheck`, default CI, and package lockfile remain
unaffected by this experimental lane.
