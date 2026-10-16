# T3 Code OpenCode 2 HTTP contract inventory

## Status: mapping-only, NOT exercised

This document is a **contract inventory and a hazard warning**. It is not an
active compatibility target, and nothing here is a work order.

It maps the OpenCode 2 HTTP surface that current upstream T3 Code (`origin/main`
`a21702d0e`) actually consumes, so that the deliberate absence of that surface in
OpenFork is a recorded decision rather than an undiscovered gap.

Current OpenFork behaviour forces latest T3 Code onto the **v1** path:

| Probe                       | OpenFork (real, observed)                                       | T3 classification          |
| --------------------------- | --------------------------------------------------------------- | -------------------------- |
| `openfork-t3code --version` | stdout exactly `1.15.13`                                        | v1 (major 1)               |
| `GET /api/info`             | `404` `application/json` `{"error":"Not Found"}`                | no version → try next path |
| `GET /global/health`        | `200` `application/json` `{"healthy":true,"version":"1.15.13"}` | v1 (major 1)               |

Therefore **none of the endpoints below are reached** when latest T3 Code runs
against OpenFork. The active contract is the legacy OpenCode 1.15.13 facade
described in [`t3code-compatibility.md`](./t3code-compatibility.md).

## How T3 actually decides v1 vs v2

Read this before any negotiation change. The generation is decided **by the
decoded version's semver major**, never by which path answered.

```ts
function probed(version: string | null | undefined) {
  const major = parseSemver(version ?? "")?.major
  if (!version || major === undefined) return undefined
  return { generation: major >= 2 ? "v2" : "v1", version }
}
```

Consequences that are easy to get wrong:

- **The path is not the generation.** A `200 application/json` `/api/info`
  answering `{version: "1.15.13", pid: 1234}` classifies as **v1**, not v2.
- `/api/info` selects v2 only when its decoded version has major `>= 2`.
- An empty or undecodable body yields `undefined`, which makes the probe try the
  **next** candidate path.

### The two probes are mutually exclusive, not two gates

`probeOpenCodeRuntime` chooses **one** path; it is not a conjunction:

- a non-empty `serverUrl` → `probeOpenCodeServer` (HTTP `/api/info`, then
  `/global/health`);
- otherwise → `probeOpenCodeBinary`, which runs `binaryPath --version`.

So a deployment can be steered by either surface, and only the selected one
matters. An E2E harness must exercise both configurations separately; proving one
says nothing about the other.

### Within the server probe, `401` is a hard error and `404` is not

`classifyOpenCodeProbeResponse` returns the sentinel `"unauthorized"` for `401`,
and `probeOpenCodeServer` immediately converts that into an
`OpenCodeRuntimeError` (_"401 Unauthorized: the OpenCode server rejected the
password."_). Every other non-qualifying response yields `undefined`, which
merely advances to the next candidate path.

T3's own comment records why the asymmetry is necessary: **both** 1.x and 2.x
answer a wrong password with a `401` on either path, so a 401 carries no version
information and must not be treated as "unidentified".

| Response on either path                      | Result                                           |
| -------------------------------------------- | ------------------------------------------------ |
| `401`                                        | **hard error**, no fall-through                  |
| not `200 application/json`                   | `undefined` → try next path                      |
| `200 application/json`, body does not decode | `undefined` → try next path                      |
| both candidates exhausted                    | `OpenCodeRuntimeError` "did not identify itself" |

### Decoders are stricter than status and content-type

Status plus media type are necessary but not sufficient. The media type is
normalized with `contentType.split(";")[0].trim().toLowerCase()`, so `charset`
parameters are tolerated but an uppercase or otherwise exotic type is not.

- `/api/info` requires **both** `version: string` **and** `pid: Int`. The
  in-source rationale: requiring both "keeps unrelated JSON out".
- `/global/health` requires `healthy: Schema.Literal(true)` — the literal boolean,
  so `"true"` fails — **and** `version: string`. OpenFork's extra `path` field
  is ignored, so the canonical body still decodes.
- A version that fails `parseSemver` yields `undefined`, and exhausting both
  paths produces _"The server did not identify itself as OpenCode."_

### URL construction preserves a prefix and query

The probe appends the candidate path to the configured URL rather than replacing
it, and preserves the query string: `/base/?x=1` becomes `/base/api/info?x=1`.
A reverse proxy mounted under a sub-path is therefore in scope.

## `GET /api/info` is deliberately absent (a conservative invariant)

> Do not add a `200 application/json` `/api/info` that reports major `>= 2`.

To be precise about the mechanism, since this was initially documented too
strongly: a JSON `/api/info` is **not** inherently v2. The current absence of
the route is a _conservative_ facade invariant, and its practical value is that
it prevents a future native OpenFork version from being exposed at that path.

The genuine flip condition is narrower and more dangerous: **any
`200 application/json` `/api/info` whose decoded version has major `>= 2`**.

That matters because `/global/health` and `/api/info` are both served by
`localClientReportedVersion(...)`, and only the T3 profile pins `1.15.13` — the
canonical branch reports the real OpenFork version. So:

- while the reported version stays below `2.0.0`, both probes classify v1 by a
  margin of one major version;
- if OpenFork's version line ever reaches `2.0.0`, a T3 deployment configured
  with `serverUrl` against a canonical (non-profile) OpenFork negotiates **v2**
  and fails, with no route added and no error naming the cause.

The invariant is therefore a **pair**, and pinning only the route leaves a
future reader one release away from the identical silent flip:

1. no decodable `/api/info` reporting major `>= 2`; **and**
2. any reported version T3 can decode has semver major `< 2`.

If such a flip ever happened:

- every T3 lane would switch to the v2 adapter at once;
- there would be **no T3-side error and no log line** naming the cause;
- OpenFork cannot actually serve the 2.x `/api/*` protocol, so the failure would
  surface as many unrelated regressions across unrelated surfaces;
- the shared version window `[1.14.19, 2.0.0)` would no longer hold, so a
  version-string check alone would not reveal it early.

Corroboration that the absence is structural rather than accidental: no
`/api/...` path is declared by any OpenFork route group, and `api/info` has zero
occurrences in `packages/opencode/src`. There is nothing to remove and nothing to
complete.

### Ownership

The live negotiation regression belongs to the single lane that owns the
process/version/auth surface (`test/server/t3code-process-version-auth.test.ts`):

- T3-profile `--version` is exactly `1.15.13`;
- `401` hard-fails immediately with no fall-through (both candidate paths);
- authenticated `/api/info` does not report a major `>= 2` version (today `404`);
- authenticated `/global/health` is `200` + `application/json` + a body decoding
  `{healthy: true, version: "1.15.13"}`;
- both probe branches — the local-binary branch and the external-`serverUrl`
  branch — are covered, since they are mutually exclusive;
- startup stdout stays `opencode server listening on ...`.

Two related traps belong to that lane as well, because they are negotiation
inputs rather than endpoint behaviour:

- **stdout hygiene.** `classifyOpenCodeCliVersion` runs
  `parseGenericCliVersion` over the **whole** stdout, matching the first
  `/\bv?(\d+\.\d+\.\d+)\b/` and letting the major decide. Any semver-shaped token
  printed _before_ the version — an update notice, a migration line, a plugin
  banner — silently changes the classification.
- **version window.** Per T3 `apps/server/src/provider/model-manifest.json`
  (lines 53-74), old T3 (`t3CodeRange >=0.0.42 <0.0.46`) treats `>=1.14.19
<2.0.0` as supported and `>=2.0.0` as broken; latest T3
  (`t3CodeRange >=0.0.46`) treats `>=2.0.18` as supported, `>=2.0.0 <2.0.18` as
  unsupported, and `>=1.14.19 <2.0.0` as graceful. `1.15.13` sits inside the
  shared window `[1.14.19, 2.0.0)`: old T3 supported, latest T3 graceful.
  **But see below — this manifest does not enforce anything.**
- **reported version stays major `< 2` under the profile.** This, not route
  absence, is the primary guard; see the hazard note above.

### The version manifest is advisory-only, never a gate

Do not write a test that expects a hard failure on an out-of-window version.
`resolveProviderCompatibility` returns a `compatibilityAdvisory`, and
`if (!policy) return undefined` short-circuits; `graceful` never appears in
driver dispatch. Concretely:

- A version matching no range yields status `unknown`, message `null`, and **no
  advisory at all**.
- `graceful` is descriptive only; it is not a dispatch branch.
- A wrong version therefore produces a **misleading banner**, not an error. An E2E
  that waits for a hard failure will hang instead of failing — assert the banner
  shape instead.
- `StableVersion` requires `/^\d+\.\d+\.\d+$/` after stripping one leading `v`, so
  a non-bare version loses even the banner, with no signal whatsoever.

This is why the window is worth respecting while being unenforceable: nothing in
T3 stops OpenFork from misreporting, which is exactly why the guard has to live in
OpenFork's own regression tests.

### A guard fed the dev sentinel is inert

`InstallationVersion` (`packages/core/src/installation/version.ts:17`) is
`typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"`. A dev or test
build stamps no release define, so the value is the **non-semver sentinel
`"local"`**, and `parseSemver("local")` yields no major.

Consequences when writing the OpenFork-side fence:

- A guard that feeds `InstallationVersion` into a T3 classifier takes a
  fail-closed early-return branch in an ordinary test run and asserts the
  "unclassified" result, so it never actually evaluates the `major >= 2`
  comparison.
- `"local"` cannot select v2, so the early return is safe — but it also means the
  fence **only bites in a release build** where the define is present. A test that
  looks like it protects the major-version invariant may be inert in CI.
- To make it bite earlier, feed the input that is actually stamped in CI: the
  release version (`InstallationReleaseVersion`) or the package-manifest version,
  not the dev sentinel.

Assert both, or the fence protects only release time while appearing to protect
always.

The legacy SDK response-envelope/status assertions stay with the lane that owns
`t3code-compat-contract.test.ts`. These are deliberately **not** duplicated.

## Endpoint inventory

Every entry is a method latest T3 invokes on `@opencode/client` 2.0.18. Line
numbers are `apps/server/src/**` at `origin/main` `a21702d0e`. All of it is
documented-not-exercised.

### Server / readiness

| Method          | Args | Envelope consumed                  | Notes                                                                                   |
| --------------- | ---- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| `server.info()` | none | `{version, pid}` → only `.version` | `OpenCode2Server.ts:104`. Readiness proof; 5s timeout. `pid` is decoded then discarded. |

`server.info()` looks like a stricter `/api/info` check than the one above, but
the two do not conflict: `verifyServer` only runs **after**
`probeOpenCodeRuntime` has already selected a generation, and
`OpenCode2Server` is constructed only on the v2 branch. By then a major `>= 2`
version is established, so treating any decodable `/api/info` as v2 is
consistent — and treating a 2xx-but-undecodable body as "not an OpenCode 2
server" matches T3's own reason for requiring a JSON body (1.x answers that path
with HTML).

### Session

| Method                             | Args                                                   | Notes                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session.create`                   | `{location:{directory}, title?, model?, permissions?}` | `TextGeneration.ts:132`, `AdapterV2:3593`. Answer read for bare `id`.                                                                                                    |
| `session.get`                      | `{sessionID}`                                          | `:3644`. Read for `id` **and** `location.directory`.                                                                                                                     |
| `session.update`                   | `{sessionID, permissions}`                             | `:2984`. Note **plural** `permissions`; the v1 contract asserts singular `permission`. Possibly a real v1→v2 rename — verify against the T3 v1 adapter before asserting. |
| `session.active`                   | none                                                   | `:2744`, `:3043`. Answer is a **map keyed by session id**, not an array: `sessionId in active`.                                                                          |
| `session.move`                     | `{sessionID, directory}`                               | `:3662`, `:4220`. No v1 analogue.                                                                                                                                        |
| `session.fork`                     | `{sessionID, before?}`                                 | `:4185`. `before` is **omitted**, not sent as `null`.                                                                                                                    |
| `session.switchAgent`              | `{sessionID, agent}`                                   | `:3769`. No v1 analogue.                                                                                                                                                 |
| `session.switchModel`              | `{sessionID, model}`                                   | `:3789`. No v1 analogue.                                                                                                                                                 |
| `session.compact`                  | `{sessionID, id}`                                      | `:3503`.                                                                                                                                                                 |
| `session.command`                  | `{sessionID, ...command}`                              | `:3519`. Carries no T3 id and its answer carries none.                                                                                                                   |
| `session.revert.stage` / `.commit` | —                                                      | `:3107`, `:3110`.                                                                                                                                                        |
| `session.instructions.entry.put`   | —                                                      | `:3278`.                                                                                                                                                                 |

### Message

| Method              | Args                                 | Envelope consumed                                               | Notes    |
| ------------------- | ------------------------------------ | --------------------------------------------------------------- | -------- |
| `message.list`      | `{sessionID, order:"desc", limit:1}` | `{data:[…]}`, `newest.data[0]?.id`                              | `:3516`. |
| `session.prompt`    | `{sessionID, text, files?}`          | `TextGeneration.ts:153`; `files` is `[{uri:"file://…", name}]`. |          |
| `session.interrupt` | `{sessionID}`                        | `TextGeneration.ts:162`. Timeout bail-out.                      |          |
| `session.remove`    | `{sessionID}`                        | Finalizer, 5s timeout, `Effect.ignore`.                         |          |

### Catalog (all location-scoped)

| Method         | Args                     | Notes    |
| -------------- | ------------------------ | -------- |
| `model.list`   | `{location:{directory}}` | `:2896`. |
| `agent.list`   | `{location:{directory}}` | `:2925`. |
| `command.list` | `{location:{directory}}` | `:3508`. |
| `skill.list`   | `{location:{directory}}` | `:3525`. |

### Permissions, forms, questions, MCP

| Method                           | Args          | Notes                      |
| -------------------------------- | ------------- | -------------------------- |
| `permission.list`                | `{sessionID}` | `:1897`, `:2791`.          |
| `session.form.list`              | `{sessionID}` | `:1898`, `:2792`.          |
| `session.form.reply` / `.cancel` | —             | `:4066`, `:2084`, `:4062`. |
| `mcp.remove`                     | —             | `:3204`.                   |

`session.form.*` is a genuinely new v2 concept: forms are a first-class pending
request kind alongside permissions, with their own ids. There is no 1.x analogue.

## Cross-cutting contract rules

### List envelope key is `data`

Every list call is read as `<x>.data` — `models.data`, `list.data.map(…)`,
`newest.data[0]`. Not `items`, not `results`.

### Pagination: `cursor` and `order` are mutually exclusive

Envelope is `{data: Item[], cursor: {next?: unknown}}`, not a bare array.

`paginate()` (`OpenCode2Client.ts:199-222`) sends the caller's full input
**including `order`** on the first request, then every later request sends
`{...request, order: undefined, cursor: page.cursor.next}`. The source states the
server **rejects a cursor combined with `order`**, so `order` must be dropped
rather than merged.

Termination: `page.data.length === 0` **or** `cursor.next === undefined`.

### Locations are body-scoped, not a query parameter

v2 passes `location: Location.PublicRef.make({directory: AbsolutePath.make(cwd)})`
— a branded body value. The v1 facade takes a plain `directory` **query**
parameter (asserted at `t3code-compat-contract.test.ts:94`). Nothing in OpenFork
needs to change for this.

### An empty catalog is not authoritative

Catalog reads are best-effort: `model.list`, `agent.list`, `command.list`, and
`skill.list` are each wrapped `Effect.orElseSucceed(() => [])` after a timeout.
An empty list usually means _failed or still scanning_, never _definitely empty_.

`agent.list` additionally polls — `Effect.repeat({until: list => list.data.length > 0, schedule: spaced(250ms)})`
under a 5s timeout — which is direct evidence that an initially empty catalog
means scan-pending.

### `GET /api/event` (SSE)

Hand-rolled rather than via the generated `event.subscribe`, specifically for
forward compatibility. Sources: `readEvents` and `undecodable` in
`apps/server/src/provider/opencode2/OpenCode2Client.ts` (auth wiring in `make`,
same file).

- `GET /api/event` with `accept: text/event-stream`, then `filterStatusOk`.
- `decodeText` → `Sse.decode()` → per-frame `filterMapEffect`. Each frame is
  decoded **independently** against `OpenCodeEvent`, so one unknown event does not
  tear down the stream. The generated client's `event.subscribe` fails the whole
  stream on the first undecodable event — that is the failure mode being avoided.
- **Heartbeat:** OpenCode writes a `: heartbeat` comment every 10–15s. T3's
  `SILENT_STREAM_TIMEOUT` is 45s at _stream_ level, so 45s with zero bytes is a
  stuck server (`OpenCode2SilentStreamError`). Comments count as bytes and reset
  it; a proxy or client that strips SSE comments will look like a 45s stall.
- **Boundaries:** start `session.execution.started`; terminal
  `session.execution.succeeded` | `session.execution.failed` |
  `session.execution.interrupted` (the `EXECUTION_ENDS` constant, `OpenCode2Client.ts`).
- **Undecodable frames** fall back to a minimal envelope
  `{type, data?:{sessionID?}}` (`decodeEnvelope`, same file). A terminal type with
  a surviving `sessionID` becomes `unreadable.execution.ended` so the turn still
  ends; a start type becomes `unreadable.execution.started`; any other undecodable
  frame is **skipped**. Forward compatibility is asymmetric on purpose — only the
  events that delimit an execution are preserved.
- `events` **succeeds once the subscription is accepted**, because the stream is
  volatile. Callers must subscribe _before_ starting the work whose events they
  need. Loss of the stream is terminal in
  `apps/server/src/textGeneration/OpenCode2TextGeneration.ts` (the forked stream
  `Effect.exit`s into a failed `Deferred`).

### Auth

HTTP Basic only, with a hardcoded username `opencode`
(`OPENCODE_USERNAME`, `OpenCode2Client.ts`):

```
Authorization: Basic base64(utf8("opencode:" + password))
```

It is hand-rolled because OpenCode decodes Basic credentials as **UTF-8**, while
`HttpClientRequest.basicAuth` encodes Latin-1 via `btoa` and would get non-ASCII
passwords rejected.

One injected authenticated client covers both the generated client and the
hand-rolled `/api/event` reader.

**Two env vars, and precedence matters:** OpenCode 2 prefers `OPENCODE_PASSWORD`
over `OPENCODE_SERVER_PASSWORD`. `serverEnvironment()` strips the inherited
`OPENCODE_SERVER_PASSWORD` and sets only `OPENCODE_PASSWORD`, so the T3-generated
password is the only one in play. Re-adding the inherited variable would silently
split the v1 and v2 credentials.

Generated passwords are 32 random bytes, **base64url**, held in `Redacted` — so
they may contain `-` and `_`; anything that round-trips them must not assume
standard base64.

### Error classification

The client wraps HTTP failures in its own `ClientError`, so T3 unwraps **either**
shape: a raw `HttpClientError`, or a tagged `ClientError` whose `.cause` is one.
Modelling only the inner error misses failures surfaced through the outer wrapper.

`/api/info` failure classification — status alone is not the discriminator, the
body must decode as JSON (1.x answers `/api/info` with HTML):

| Condition           | Meaning                             |
| ------------------- | ----------------------------------- |
| `TransportError`    | could not reach the server          |
| `401`               | server rejected the server password |
| any other non-2xx   | server returned HTTP `<status>`     |
| 2xx but undecodable | not an OpenCode 2 server            |

Client-facing error **details are fixed text** by design, because a `serverUrl`
can carry credentials; the raw failure stays in `cause`. No upstream URL or
response body should reach a client-facing message.

### Timeouts

| Operation                    | Timeout                                  |
| ---------------------------- | ---------------------------------------- |
| `server.info`                | 5s                                       |
| `model.list`, `agent.list`   | 5s (agents poll every 250ms while empty) |
| `command.list`, `skill.list` | inventory timeout                        |
| `session.active`             | active-check timeout                     |
| `session.remove`             | 5s                                       |
| SSE silence                  | 45s                                      |

## Provenance

Derived by reading T3 at `origin/main` `a21702d0e` with `git show` — read-only.
No T3 file was checked out, modified, or staged. T3 is a fixed upstream puzzle
piece; every shim, alias, and negotiation decision lives in OpenFork.

This is source-reading plus wrapper-level probe evidence. It is **not** end-to-end
proof: real E2E requires an actual stock-T3 process driving OpenFork over HTTP and
SSE, which is tracked separately.
