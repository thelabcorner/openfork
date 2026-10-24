# AX GitHub WebFetch research routing — 2026-10-17

## Task, baseline, owner

Real agent task: retrieve `storytold/vectorcraft` Rust source through `raw.githubusercontent.com/storytold/vectorcraft/main/crates/geom/src/{lib,projective}.rs`. Source research should use the **authenticated gh-backed native `github` tool** when available, instead of anonymous WebFetch. Prefer first-party GitHub API access for private repositories, predictable rate-limit/account scope, and bounded tool permissions.

Observed baseline in `packages/opencode/src/tool/webfetch.ts`: `executeFetch` performed network I/O, then `applyGitHubNudge` appended a generic instruction to successful textual responses. Thus the agent had already performed the wasteful anonymous request, and code/RAG content was polluted with an advisory.

Single owner for guidance: `packages/opencode/src/tool/github-fetch-guidance.ts` (pure URL classifier and advisory). Execution boundary: native `webfetch` leaf, including the `web(action="fetch")` facade that delegates to it. **No privileged GitHub call is made by the guidance branch.**

## Intervention semantics

1. At the WebFetch execution leaf, before WebFetch permission or HTTP client, classify exact HTTPS GitHub hosts and supported repository resource paths. Never match suffixes/substrings such as `github.com.evil.example`.
2. For supported resources and ordinary text/markdown fetching, return a successful result with `metadata.advisory="github-preferred"`, `contentFetched=false`, `recommendedTool="github"`, `kind`, and executable next-operation guidance.
3. For raw source and `github.com/.../blob/... ` under unambiguous `main`, `master` or commit-SHA refs, suggest `github action=api`, `repo=OWNER/REPO`, `endpoint=repos/OWNER/REPO/contents/PATH`, `params={ref:REF}`, and `headers={Accept:"application/vnd.github.raw+json"}`. For directories, use GitHub Contents JSON. For issues/PRs/repositories, suggest the allowlisted `github action=command` operations. Existing endpoint/command and authenticated-host gates remain enforced by `github`.
4. For ambiguous slash-bearing refs, suggest discovery/resolution rather than invent a potentially wrong file path. Do not interpret the advice as having loaded source.
5. The lazy `github` tool remains behind the existing `tool(action="describe"/"call")` broker, with its contract and permission checks; normal `@github` activation may seed its descriptor. It is not added to the permanent hot catalog.
6. `forceWeb:true` on either `web` or `webfetch` bypasses guidance, reaches ordinary `webfetch` permission, and fetches through the existing unauthenticated HTTP client. Appropriate for publicly accessible URLs when gh is absent, inaccessible, denied, rate-limited, or exact HTTP output is essential. A private repo cannot be read anonymously merely because authenticated GitHub access has exhausted its quota. No silent retries, auth transfer, credential copying, or fallback to unapproved roots.
7. Unsupported resources are left alone: explicit HTML, non-HTTPS, archive/codeload, patch-diff host, unknown GitHub pages, web links with query-dependent semantics, non-GitHub domains, and public websites. Query/host/ref ambiguity is not papered over.

## AX task-map and gates

| Step | Prior behavior | Candidate |
| --- | --- | --- |
| Tool discovery | `web` advertises generic GitHub preference | `web` and `webfetch` describe the preferred `github` route and named opt-out |
| Selection | Anonymous WebFetch accepted | Tool result redirects source research before I/O |
| Arguments | Generic `pr diff` example for any GitHub URL | Resource-specific repository/file/ref/Accept example |
| Authority | WebFetch permission plus HTTP; GitHub independent | No I/O/no permission on advisory; gh still requires actual lazy-tool contract and GitHub permissions |
| Evidence/partial progress | Nudge appended to fetched source | Success guidance marks `contentFetched=false`; no synthetic source content |
| Recovery | Repeat calls may repeat anonymous fetch | Explicit `forceWeb:true` escape hatch; no forced failure loop |
| Context/latency | Download + appended generic prose | Bounded routing advice and no network I/O for recognized source URLs |
| Verification | The first fetch may appear to satisfy RAG | Agent must execute `github` and verify real content |

The meaningful AX metric is not zero failed tools: it is verified task completion with fewer wrong-path network requests, retries and model tokens, **without** increased denied actions or missing source evidence. No end-to-end model trajectory, live gh authentication, or actual savings measurements have yet been established.

## Executable parity / scope

| Entry point | Code path | Evidence |
| --- | --- | --- |
| Native WebFetch leaf | `WebFetchTool.execute` | Integration tests: successful no-permission guidance and override reaching permission |
| Native `web(action="fetch")` | `WebTool` delegates to `WebFetchTool` | Executed facade-level integration tests: preserved advice metadata/no permission, `forceWeb` propagated to permission gate |
| Session/worker, lazy broker, Code Mode | Registry `web` and shared delegate | Same owner when invoked through native leaf; independent dispatcher E2E pending |
| OXP/OFXP/ACP/MCP | Supported gateway only if it actually calls this native leaf | Transport-specific executable and deployed-host parity **not yet certified**; no authority inferred from catalog presence |
| External/custom WebFetch implementations | Unrelated implementations | Not covered and not modified |

### Verification

- `cd packages/opencode && bun test test/tool/web.test.ts test/tool/webfetch.test.ts test/tool/github.test.ts` — 32/32 passed on source checkout.
- `bun run typecheck` — passed on earlier runs. The final package run failed on an unrelated existing error in `test/tool/goal.test.ts(25,24)`: its Goal service test mock lacks the required `submit` method. That file is outside this change and has no local diff. No routing-code TypeScript errors appeared in the final report; the overall package typecheck gate is not clean.
- WebFetch tests cover the concrete screenshot URL, raw/blob/tree/issues/PR/API/repo advice, foreign/malicious hosts, ambiguous refs, explicit HTML, non-GitHub pass-through, successful no-permission advice, and explicit fallback permission.
- Existing remote GitHub tool classification/authorization-unit tests remain green. They do not prove that the remote file exists or that the API account has available quota.
- **Live CLI smoke result:** An authenticated `gh api` GET for the photographed `lib.rs` file returned HTTP 403 with GitHub API rate-limit exhaustion; a separate `gh api rate_limit` read reported the account core bucket at **0 remaining of 5,000**. In the same environment, a direct unauthenticated HTTPS read of that public raw URL returned **HTTP 200, 4,092 bytes**. These are environmental transport checks, not dispatcher-level proof or a source routing regression. The authenticated path was **not live-verified as fetching the file successfully** at the time of the test. Public WebFetch fallback can be appropriate while the authenticated bucket is exhausted; do not automatically retry exhausted gh quota.

## Deployment and next experiment

Changes are in the **dirty local `opencode` main source tree**, not a new commit, PR, rebuilt host or deployed runtime. Preserve all unrelated checkout changes. Rebuild/restart the actual OpenFork host before production observation; verify the live tool implementation rather than treating a source test as deployment.

Next AX A/B: on the same model, prompt, available credentials, and task corpus, compare (1) old post-fetch nudge, (2) new prefetch guidance, and (3) explicit GitHub-first tool selection; track source accuracy, successful gh activation, unauthorized attempts, WebFetch count, bytes downloaded, latency, tokens and completion. Include private repo (authorized and denied), GitHub API rate limit, no `gh`, non-default slash-containing ref, archive/HTML exclusions, and repeat-loop avoidance.
