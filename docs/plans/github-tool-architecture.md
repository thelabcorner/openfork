# GitHub Tool Architecture — Research & Design

## 1. Current OpenFork tool conventions

OpenFork first-party tools live in `packages/opencode/src/tool` and follow a shared shape:

- `Tool.define(id, Effect.gen(...))` produces a lazy or default-exposure tool (`Tool.ts:259`).
- `Parameters` is a flat `Schema.Struct` with optional discriminator-like fields (`action`, `mode`, etc.) and per-action allowlists enforced at execute time (`github.ts:105`, `project.ts:21`, `git.ts:8`).
- `DESCRIPTION` is stored in a sibling `.txt` file and kept terse.
- Permission checks use `ctx.ask({ permission, patterns, always, metadata })`.
- Process execution goes through `AppProcess.Service` (`@opencode-ai/core/process`) with bounded argv/stdin/stdout, timeouts, and abort signals.
- Lazy tools are declared in `exposure.ts:7` (`BUILTIN_LAZY_TOOL_IDS`) and reached through the `tool` broker rather than the permanent provider manifest.

Examples of dense, low-context tools:

- `git` — mode-dispatched typed wrapper over `git` (`git/typed.ts`).
- `project` — tiered project snapshot (`project.ts`).
- `symbols` — search/outline/usages dispatch (`symbols.ts`).
- `code` — search/describe/run/save/call over capability refs (`code.ts`).

The `github` tool (`github.ts`) is wired as a lazy builtin in the same style.

## 2. GitHub CLI architecture

`gh` (v2.102.0, installed locally) is a mature Go CLI built around:

- `cmd/gh` — entrypoint.
- `pkg/cmd` — command implementations (`pr`, `issue`, `repo`, `run`, `search`, etc.).
- `api` / `client` packages — REST and GraphQL clients over `httpx`-style Go stdlib.
- Host config (`gh auth status`, `GH_TOKEN`, `GITHUB_TOKEN`, enterprise hosts).
- `gh api` and `gh api graphql` expose raw REST/GraphQL with:
  - `--method`, `--header`, `--preview`, `--paginate`, `--slurp`, `--jq`, `--include`
  - `--hostname` for enterprise
  - `--field` / `--raw-field` for GraphQL variables and API parameters
  - stdin body support via `--input -`

`gh` is the correct local authority for auth, host resolution, and API semantics. OpenFork should not re-implement token discovery or enterprise host config.

## 3. GitHub API architecture

GitHub exposes:

- **REST** — resource-oriented, cursor/link pagination, versioned via preview headers.
- **GraphQL** — node/edge pagination (`$endCursor`, `pageInfo`), mutations for reviews, threads, reactions, etc.

The gap between REST and GraphQL is covered by using `gh api` for REST and `gh api graphql` for GraphQL, with the same auth/host context.

## 4. Supplied 108-action connector coverage matrix

The official ChatGPT GitHub connector exposes 108 operations (44 writes, 64 reads) spanning:

- repo metadata / permissions / installations
- user / org
- code / file / repo / issue / PR / commit / branch search
- files, directories, blobs, trees, refs
- commits, comparisons
- issues, comments, labels, assignees, reactions
- PRs, reviews, review comments, threads, draft/ready, reviewers, mergeability, auto-merge, merge
- Actions runs, jobs, logs, step summaries, artifacts, reruns
- check runs, commit statuses
- branch/ref updates
- file writes/deletes, blob/tree/commit creation
- secrets
- conversation locking, archival/download

Mapping to `github` actions:

| Connector area | `github` action |
| --- | --- |
| auth/status | `status` |
| help/discovery | `help` |
| common product workflows (repo/issue/pr/run/workflow/release/search/label/cache/ruleset) | `command` |
| arbitrary REST endpoints | `api` |
| arbitrary GraphQL queries/mutations | `graphql` |
| Git objects, reactions, checks, refs, review threads, workflow artifacts, secrets | `api` / `graphql` escape hatch |

This keeps the permanent model surface tiny while preserving reachability.

## 5. Candidate surfaces

### A. Flat huge schema (rejected)

One enum with 108 variants and all fields. Context cost is maximal; most fields are irrelevant per call.

### B. domain + operation with shared parameters

`{ action: "pr", operation: "get", ... }` etc. Cleaner than A but still dozens of enum members and overlapping fields.

### C. Several coarse tools (rejected)

`github_issue`, `github_pr`, `github_run`, etc. Multiplies tool descriptions and forces the model to choose the right namespace.

### D. Tiny direct surface + lazy capabilities (partial fit)

Useful for discovered/external integrations, but the builtin GitHub domain deserves a stable tool id.

### E. Compact semantic surface + constrained API escape hatch (chosen)

`github({ action, ... })` with:

- `status`
- `help`
- `command`
- `api`
- `graphql`

This is the implemented design in `github.ts`.

## 6. Context-budget comparison

Approximate per-call schema exposure:

| Surface | Permanent tokens | Model ambiguity | Round trips for common PR workflow |
| --- | --- | --- | --- |
| 108 flat tools | very high | high | low |
| domain + operation | medium | medium | medium |
| several coarse tools | high | medium | low |
| lazy-only discovery | very low | high (needs search first) | high (search + describe + call) |
| compact `github` + api/graphql | low | low | low |

`github` wins because common workflows (`pr view`, `run list`, `search code`) need one call, and long-tail needs one `api`/`graphql` call without carrying 100 schemas.

## 7. Execution architecture

Current implementation:

```
github tool
  → classify(input)       // validate action, access, target host, endpoint, headers
  → permissionPattern     // read/write : repo|host|command
  → ctx.ask               // GitHub-specific permission patterns
  → assertKnownHost       // refuse unconfigured hosts
  → assertSafeApiRouting  // fail closed on gh api_host redirects
  → runGh                 // direct argv, no shell, bounded output/time
```

Properties:

- No shell interpolation (argv array only) → injection-resistant.
- Direct `gh` process per call; no daemon yet.
- Timeout/abort propagated via `ctx.abort`.
- Output capped (`maxBytes`, default 120k, max 500k).
- stdin used for large JSON bodies instead of argv.

## 8. Authentication

`gh` owns auth entirely:

- `GH_TOKEN` / `GITHUB_TOKEN`
- `gh auth login`
- Keyring / credential helpers

The tool never reads or echoes tokens. `BLOCKED_API_HEADERS` refuses `Authorization`, `Cookie`, `x-github-otp`, etc. (`github.ts:14`). `command` mode refuses `--show-token`, `--editor`, `--web`, file-backed input.

## 9. GitHub Enterprise

- `host` field sets `GH_HOST` / `--hostname`.
- `repo` may be `HOST/OWNER/REPO`; `explicitRepoHost` extracts the host.
- `assertKnownHost` rejects hosts not configured in `gh auth status`.
- `assertSafeApiRouting` refuses authenticated API redirects because `gh` documents `api_host` as not a security boundary.

## 10. Safety / permission model

- **Read** actions: `status`, `help`, read-only curated commands, REST GET/HEAD, GraphQL queries.
- **Write** actions: REST POST/PATCH/PUT/DELETE, GraphQL mutations, curated write commands.
- Permission patterns: `read:owner/repo:pr view`, `write:owner/repo:pr merge`, etc.
- Remote URL targets are refused for writes to prevent bypassing exact repo scope.
- PR merges refuse `--delete-branch` (local worktree mutation).
- PR create requires explicit `--head` and refuses template/fill/dry-run.
- Workflow run refuses file/stdin-decoding input modes.
- Custom headers are constrained to safe names/values; newlines refused.

## 11. Response normalization

Default output is the bounded stdout/stderr of the `gh` invocation. `renderResult` wraps:

```ts
{ title, output, metadata }
```

Metadata carries `action`, `access`, `ok`, `exitCode`, `truncated`, `repo`, `host`, `command`.

Compact-by-default: the tool does not expand raw REST/GraphQL payloads; callers can request `--json`/`--jq` through curated commands or use `jq` through `api`/`graphql`.

Large diffs/logs/artifacts should be paged or written to files outside the tool rather than dumped into context.

## 12. Performance findings

- Single `gh` invocation per semantic action keeps latency proportional to one subprocess.
- `command` mode uses `--json`/`--jq` for machine-readable projection; no extra TS parsing layer.
- `api`/`graphql` support `--paginate`/`--slurp` for batching pages without multiple tool calls.
- No persistent `gh` daemon exists yet; repeated subprocess startup (~50–200 ms warm, more cold) is acceptable for typical PR/issue inspection but may become a bottleneck for high-frequency GraphQL polling. If that becomes real, batch via composed GraphQL or consider a local helper process.

## 13. Recommended implementation

Use the existing `github` tool (`src/tool/github.ts`) as the durable surface.

Implemented since this design: `github({action:"catalog"})` and
`github({action:"describe"})` expose the bounded capability index (curated
commands, REST endpoints, GraphQL operations) with canonical descriptors;
see `docs/plans/tool-description-discovery-unification.md` §7.

Recommended near-term hardening:

- Expand curated `command` allowlists only when a common workflow lacks coverage.
- Prefer `api`/`graphql` for long-tail GitHub functionality.
- Add more deterministic tests around `api` pagination, GraphQL cursor pagination, enterprise host refusal, and rate-limit surfacing.
- Keep descriptions terse; do not inline endpoint catalogs.

## 14. Tests

`packages/opencode/test/tool/github.test.ts` covers:

- classification of read/write commands
- REST method-based access
- invalid action fields
- GraphQL mutation vs query detection
- unsafe flag/header/host rejection
- explicit PR/issue target requirements
- `--delete-branch` refusal
- `pr create --head` enforcement
- repository authority invariants

Missing but desirable:

- pagination parsing
- cancellation during `runGh`
- missing `gh` binary
- unauthenticated `gh`
- rate-limit and not-found error normalization
- output truncation behavior
- shell-injection resistance via argv fuzzing
- Unicode repo names / paths

## 15. Future expansion

- Add curated high-value composed actions (e.g. `pr review context`) only if multiple micro-calls prove expensive.
- Consider structured `data` payloads for `pr`/`issue` views if UI needs richer state.
- Explore a lazy `github` reference skill/doc for extended GraphQL/REST recipes.
- Agent routing: `web`/`webfetch` descriptions carve out github.com URLs for the
  github tool, and webfetch appends a one-line github-tool nudge to GitHub-host
  responses (unauthenticated fallback preserved).
- See [`docs/plans/tool-description-discovery-unification.md`](tool-description-discovery-unification.md) for the broader description/discovery model; GitHub catalog/describe should stay GitHub-owned.
- Do **not** split into `github_issue`, `github_pr`, `github_workflow`, etc. unless empirical evidence shows one schema cannot handle dispatch cleanly.
