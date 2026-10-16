# Unified Tool Description/Discovery — Plan

Goal: one coherent way for an agent to learn what OpenFork can do and what shape a call takes, without turning the permanent prompt into a catalog. Motivating case: the `github` tool can reach long-tail GitHub REST/GraphQL, but its schemas are not discoverable beyond `github({action:"help"})`.

## 1. Current-state inventory

| Mechanism | What it describes | Who calls it | Permanent context cost | Typical discovery cost | Cannot express |
| --- | --- | --- | --- | --- | --- |
| Native tool manifest (`Tool.define` + `registry.ts`) | Permanently resident builtin tools | Provider model directly | High per tool, so exposure policy matters | 0 round trips; already visible | Long-tail variants of the same domain |
| Lazy tool broker (`access.ts:9`, `exposure.ts:7`) | Lazy builtin tools (`archive`, `checkpoint`, `github`, `json`, `refactor`, `sqlite`, `swarm`, `sympy`, `test`) | `tool({action:"list"})`, `describe`, `call` | Low permanent schema; list is compact | 2 round trips before first call | GitHub API schema/detail; only tool-level schema |
| `BrokerContract` (`broker-contract.ts:58`) | Stateless proof that the model saw the current lazy-tool descriptor | `tool` broker | Zero permanent state | Required on every `call` | Domain semantics beyond one tool's schema |
| `code.search` / `code.describe` / `code.run` / `code.save` / `code.call` (`code.ts`) | Callable capability refs, saved tools, run replay | Agent invoking programmable orchestration | Tool description is compact; catalog is lazy | search → describe → run/call | External product API docs; host/auth context; mutation shapes |
| `symbols` tool (`symbols.ts`) | Code symbols in the local repo | Direct tool call | Compact action dispatch | 1 call for search/outline/usages | GitHub/remote API surfaces |
| `project` tool (`project.ts:21`) | Local project snapshot | Direct tool call | Compact tiered schema | 1 call | Remote/GitHub state |
| Per-tool `DESCRIPTION` + `Parameters` flat schema (`github.ts:105`, `git.ts`, `project.ts`) | One domain tool's actions and fields | Provider model | Compact per tool | 0; action-specific rules enforced at runtime | Why an action failed beyond directive error |
| `github({action:"help"})` (`github.ts:722`) | Approved `gh` command families only | Direct `github` call | Zero extra permanent schema | 1 call per topic | REST endpoint catalogs; GraphQL schema details |
| Skill files (`.openfork/skills`, user skills) | Human/agent guidance | `skill` tool / explicit invocation | Not always permanent | 1+ reads | Structured invocation contracts |
| MCP tools / resources (`registry.ts:643`) | External MCP server tools/resources | Provider manifest or `mcp-resource` tools | Can be high if eagerly exposed | Varies | Preserved as MCP-specific |

Observed duplication/drift:

- `tool` broker and `code` both discover invocable things, but with different refs, contracts, and permission boundaries.
- `BrokerContract.describe` and `Capability.Registration` already overlap conceptually but are not the same shape.
- GitHub REST/GraphQL has no first-class tool-local discovery path; only `help` covers curated `gh` commands.

## 2. Failure mode

Routing GitHub schema discovery through `code.search`/`code.describe` is the wrong home because:

- **Wrong ontology.** `Capability.Registration` describes OpenFork-invokable units; GitHub REST paths and GraphQL operations are operations on an external product, not OpenFork capability refs.
- **No authority context.** A GitHub mutation needs repo, host, auth, permission pattern, and api_host routing context. A generic capability ref has no place for that.
- **No shape for "how to call this safely."** Code describe returns a callable contract for a saved JS tool; it cannot express `api` vs `graphql` vs curated `command`, `--jq`, `paginate`, headers, pagination cursors, or `gh` flag restrictions.
- **Wrong failure recovery.** GitHub errors are HTTP/rate-limit/host-routing failures; Code errors are JS orchestration/schema failures.

Required property for the right discovery mechanism: **the describer must be owned by the same authority that owns execution.** GitHub schema discovery must live with `github`; local capability discovery can live with `tool`/`code`; MCP discovery stays MCP-owned.

## 3. Candidate designs

### A. Extend `github` itself with catalog/describe

Add to `github.ts`:

```ts
github({ action: "catalog", query: "issue comment", kind: "api|graphql|command", limit })
github({ action: "describe", ref: "api:/repos/{owner}/{repo}/issues/{issue_number}/comments" })
```

- `catalog` returns compact refs: path/method/summary/access/example.
- `describe` returns exact parameter/body/pagination/example for one ref.
- Uses the same host/repo/permission checks as execution where applicable.
- Data source: generated compact index from GitHub REST OpenAPI + GraphQL introspection, plus curated command metadata; `help` remains for `gh` command prose.

Pros: correct authority, one durable tool, long-tail reachable, permission/host context preserved.
Cons: GitHub-specific code grows; index freshness/size must be managed.

### B. One first-class `describe`/`tools` tool

A single tool answers "what can I call and what is its shape?" for builtin tools, lazy tools, capability refs, MCP, and external APIs.

Pros: one mental model.
Cons: god-tool risk; every domain must teach it its semantics; makes native tools harder to keep compact; may duplicate `tool` broker/Code.

### C. Layered progressive disclosure

Permanent terse description → one discovery call → fully specified call → optional cached detail.

Current architecture already partially does this for lazy tools (`tool` broker) and Code, but not for GitHub REST/GraphQL details. This is an interaction pattern more than a new mechanism.

Pros: low context; scalable.
Cons: two/three round trips for long-tail tasks; agents must know to ask.

### D. Unify only the description format

Define one canonical descriptor shape used by:

- `BrokerContract.describe` (`broker-contract.ts:58`)
- `Capability.Registration` (`capability.ts:39`)
- `code.search`/`code.describe`
- future `github catalog/describe`
- MCP catalog projections

Pros: removes format drift without collapsing dispatch.
Cons: does not by itself solve GitHub discoverability.

### E. Status quo + per-domain ad hoc introspection

Keep `github.help`, `tool` broker, Code, GitHub remains. Add catalogs wherever needed.

Pros: minimal churn.
Cons: preserves the current duplication and likely creates more one-off schemas.

### F. Eliminate a mechanism

Candidates:

- Remove `code`'s search/describe in favor of the `tool` broker. Not viable: Code also composes saved tools and run replay; broker is intentionally thin.
- Remove `tool` broker list/describe/call in favor of always-visible tools. Not viable: that reintroduces permanent manifest bloat.
- Remove per-tool flat `Parameters` schemas. Not viable: they are the route to low context.

No mechanism should be eliminated now; unify their descriptor vocabulary instead.

## 4. Scoring

Scores are relative, not measurements.

| Option | Agent ergonomics | Permanent context | Long-tail reachability | Safety | Implementation cost |
| --- | --- | --- | --- | --- | --- |
| A. GitHub-owned catalog/describe | Good for GitHub; no new mental model | Low | High if index is compact | High; preserves host/permission context | Medium: index generation + GitHub tests |
| B. Single `describe` tool | Superficially uniform | Medium | Medium | Medium: easy to leak wrong authority | High: redesign broker/Code/registry |
| C. Progressive disclosure pattern | Good if taught | Very low | Depends on describer | High if domain-owned | Low as policy, not alone sufficient |
| D. Unified descriptor format | Neutral to positive | No direct change | No direct change | High | Medium |
| E. Status quo + ad hoc | Drifts | Low | GitHub remains weak | Medium | Low now, high later |
| F. Eliminate mechanism | Regression risk | May increase | No | Depends | High |

## 5. Non-negotiables

Regardless of chosen design:

- argv arrays only; no shell interpolation.
- never read/echo tokens; refuse credential/hop-by-hop headers.
- configured-host refusal and fail-closed `api_host` routing checks.
- permission via `ctx.ask` with read/write patterns.
- bounded argv/stdin/output/time; abort via `ctx.abort`.
- no local checkout/worktree mutation through GitHub writes.
- do not split `github` into `github_pr`/`github_issue`/etc. without evidence.
- no composed GitHub actions unless micro-call measurements prove they pay for themselves.

## 6. Recommendation

Do **not** unify all discovery into one tool. Do **unify the descriptor format**, and keep dispatch surfaces:

1. `tool` broker remains the lazy builtin tool gateway.
2. `code` remains programmable capability composition.
3. `github` gains `catalog`/`describe` for GitHub-owned API discovery.
4. Define one canonical descriptor envelope used by A/Broker/Code/MCP so descriptions converge.

Sequenced path:

1. Add a shared `CapabilityDescriptor` shape in `capability.ts` or a sibling module; no behavior change.
2. Emit that shape from `BrokerContract.describe` and `code.describe` without changing call semantics.
3. Add `github({action:"catalog"})` returning descriptor refs for REST/GraphQL/command surfaces.
4. Add `github({action:"describe"})` for one ref, including example `api`/`graphql`/`command` inputs.
5. Update `github.txt` with one terse line: use `catalog`/`describe` when the exact endpoint/mutation is unknown.
6. Re-evaluate after real long-tail tasks whether a thin `capabilities` router is warranted.

## 7. Implementation status

Steps 1–5 are implemented:

- `BrokerContract.CanonicalDescriptor` (`protocol: capability-descriptor-v1`) plus
  `toCanonicalDescriptor`/`fromBrokerDescriptor` in
  `packages/opencode/src/tool/broker-contract.ts`; the lazy `tool` broker
  `describe` output carries a `canonical` envelope (`access.ts`).
- `CodeService.toCanonicalDescriptor` projects `code.describe` items onto the
  same envelope (`packages/opencode/src/code/service.ts`).
- `github({action:"catalog"})` searches a bounded local index (curated `gh`
  commands generated from the existing allowlists, ~70 REST endpoints, 8
  GraphQL operations); `github({action:"describe"})` returns the exact
  invocation shape plus a canonical descriptor. Both are read-only, keep the
  existing repo/host permission patterns, and never touch `gh` or tokens.
- `github.txt` documents `catalog`/`describe` in two terse lines.
- Full projection: `BrokerContract.fromRegistration` covers native, lazy, MCP,
  MCP-resource, and saved registrations structurally; `code.describe` items
  carry a `canonical` envelope. Native `Tool.Def`s are intentionally *not*
  wrapped — they are permanently visible, so no discovery gap exists — and
  `Capability.Registration` keeps its runtime contract (invoke/authorize/
  permission keys); the envelope is a projection, never a replacement.

Deliberately not built: a 108-tool schema dump, a Code-owned GitHub API index,
token-bearing catalog responses, per-PR/per-issue tool splits.

What breaks: nothing if staged as additive. What migrates: descriptor shapes only after both producers and consumers accept the shared shape. What we deliberately do not build: a 108-tool GitHub schema dump, a Code-owned GitHub API index, token-bearing catalog responses, or per-PR/per-issue tool splits.

Evidence that would change the answer:

- If agents repeatedly fail to find the GitHub tool itself, revisit broker placement.
- If REST/GraphQL long-tail requires >3 discovery round trips on common paths, revisit one router.
- If generated index cannot be kept under a useful bounded size, keep discovery in `help` + docs only.

## 7. Affected files and tests

Likely implementation files (future, not now):

- `packages/opencode/src/tool/github.ts` — add `catalog`/`describe` classification and validation.
- `packages/opencode/src/tool/github.txt` — one-line discovery guidance.
- `packages/opencode/src/tool/capability.ts` — canonical descriptor type if shared.
- `packages/opencode/src/tool/broker-contract.ts` — align describe envelope if reused.
- `packages/opencode/src/tool/access.ts` — emit/accept shared descriptor shape if format unified.
- `packages/opencode/src/code/*` — align describe output shape only.
- `docs/plans/github-tool-architecture.md` — cross-link from §15.

Tests to name for later:

- catalog returns bounded refs for a query.
- describe rejects unknown refs and returns exact invocation shape.
- catalog/describe do not mutate or require write permission.
- host/repo authority still applies; enterprise hosts require configured auth.
- no token or credential headers are echo👼ed.
- index does not include secrets-bearing example payloads.
- missing `gh`, unauthenticated `gh`, rate-limit, 404, and truncation behavior for discovery calls.

## 8. Open questions

| Question | Cheapest experiment |
| --- | --- |
| How large is a useful compact REST/GraphQL index? | Generate a ref+one-line-summary index for a subset and measure bytes/tokens. |
| Does GraphQL introspection work uniformly across github.com and enterprise? | Run one introspection query against a known enterprise host and compare shape. |
| How many extra round trips does long-tail discovery cost? | Count calls for 3 real tasks: find a REST mutation, find a GraphQL query field, create an issue comment. |
| Do agents prefer `github({action:"catalog"})` over generic `tool`/`code` discovery? | A/B prompt wording in a scripted session or manual trace review. |
| Is a generated index fresh enough? | Compare one endpoint version against live GitHub docs/API for N=20 sampled refs. |
