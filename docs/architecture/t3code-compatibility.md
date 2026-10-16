# T3 Code compatibility boundary

## Purpose

OpenFork is not a generic OpenCode-compatible distribution. T3 Code is one
explicit local-client compatibility exception because its OpenCode provider is a
useful external consumer that OpenFork does not control.

The compatibility burden therefore lives entirely on the OpenFork side:

```text
stock T3 Code
  -> OpenCode binaryPath = "openfork-t3code"
  -> OpenFork T3 compatibility launcher
  -> OpenFork native executable
  -> narrow OpenCode 1.x compatibility profile
  -> ordinary OpenFork V1 runtime/services
```

T3 Code itself is not patched, forked, or asked to understand OpenFork-specific
HTTP, event, session, or provider concepts.

### Native Windows executable and external-server recovery

Use the native `openfork-t3code.exe` alias as `binaryPath` on Windows rather
than the legacy .cmd batch wrapper. The executable basename activates only the
opt-in T3 compatibility profile and avoids intermediate cmd.exe spawning; the
canonical OpenFork executable retains its own identity.

If stock T3's local binary probe still times out, use its existing external
server mode. Launch `openfork-t3code.exe serve --hostname=127.0.0.1` on a
dedicated port under a supervised task and enter its loopback HTTP URL in T3's
`serverUrl` field. Unlike local-process mode, T3 then performs the HTTP
health/version probe and consumes the 1.x SDK inventory without launching a
child CLI on each probe. The installed Windows supervision script
`packages/opencode/script/openfork-t3code-service.ps1` checks the configured
loopback health endpoint before attempting to launch a new service. Never
disable or bypass authentication to make availability checks succeed; when
exposing the server beyond loopback, configure matching credentials on both
OpenFork and T3. Verify HTTP health, provider inventory, SDK calls and T3
status after changes.

## Audited consumer snapshot

The current contract was audited on **2026-09-29** against
`pingdotgg/t3code` main at `0fcd5f90611451cca842689faea53b5450c022da`.

At that snapshot:

- T3 Code's server resolves `@opencode-ai/sdk` to **1.15.13**.
- T3 Code's compatibility manifest supports OpenCode
  `>=1.14.19 <2.0.0`.
- OpenCode `>=2.0.0` is explicitly marked broken by T3 Code.
- T3 Code's OpenCode provider exposes a configurable `binaryPath`. Pointing
  that existing setting at **`openfork-t3code`** selects this compatibility
  façade without modifying T3 Code upstream.

The OpenFork façade therefore reports **1.15.13**. That number is a consumer
contract version, not the OpenFork product version.

### Both generations must stay reachable at once

Stock T3 Code has since gained a second OpenCode integration generation
without removing the 1.x one, so the reported compatibility version is now
bounded by **two** consumer manifests rather than one. Audited on
**2026-10-03** against `pingdotgg/t3code` `origin/main`
`a21702d0e58ad20263dc965d84472bb6d7eb38c8`,
`apps/server/src/provider/model-manifest.json` carries two `opencode` driver
entries:

| T3 Code itself | OpenCode `supported` | OpenCode `graceful` | OpenCode `unsupported` / `broken` |
| --- | --- | --- | --- |
| `>=0.0.42 <0.0.46` (audited baseline) | `>=1.14.19 <2.0.0` | — | `>=2.0.0`, `<1.14.19` |
| `>=0.0.46` (current stock) | `>=2.0.18` | `>=1.14.19 <2.0.0` | `>=2.0.0 <2.0.18`, `<1.14.19` |

The intersection that keeps **both** generations alive is therefore exactly
`[1.14.19, 2.0.0)`. `1.15.13` sits inside it: the audited baseline calls it
supported and current stock calls it graceful.

**The reported compatibility version must never be raised out of
`[1.14.19, 2.0.0)`.** This is the most easily-broken invariant on this
boundary, and raising the number would look like an improvement:

- `>=2.0.0` is *broken* for the audited baseline and *unsupported* for current
  stock, so it regresses both directions at once.
- OpenFork's façade implements the OpenCode 1.x wire. It deliberately does not
  implement the 2.x `/api/*` protocol, so advertising 2.x would be a claim the
  runtime cannot honour.
- This number must never be derived from the OpenFork release version.

#### What "graceful" actually means for current stock T3

Current stock T3 resolves the band through
`apps/server/src/provider/providerCompatibility.ts`, which attaches a
`compatibilityAdvisory` to the provider snapshot and does nothing else with it.
Driver selection is keyed only on the probed *generation*
(`Drivers/OpenCodeDriver.ts`, `byOpenCodeRuntime`: `generation === "v2" ? v2 :
v1`); the word `graceful` never appears in dispatch. So against a `1.15.13`
façade, current stock T3 runs the retained 1.x path at full function — session
creation, event streaming, tools, permissions, questions and model resolution
are all exercised through `@opencode-ai/sdk` 1.x. `graceful` is a
**presentational** downgrade, rendered as a "Limited support" banner
(`apps/web/src/components/settings/providerStatus.ts`).

Two consequences are load-bearing:

- The banner reads "This provider version has limited compatibility with this T3
  Code release. Use `>=2.0.18`." That recommendation is addressed to stock
  OpenCode and is not actionable for OpenFork. It is cosmetic; it must not be
  "fixed" by raising the reported version.
- A reported version that matches no range, or that is not a stable
  `MAJOR.MINOR.PATCH` string, resolves to `unknown` with **no** advisory at all —
  not an error and not a block. The façade must keep reporting a bare stable
  three-part semver or it silently loses even the banner.

## Activation and identity isolation

The compatibility profile is activated only by
`OPENFORK_COMPAT_PROFILE=t3code-opencode-v1`. The distributed
`openfork-t3code` launcher sets that variable and then executes the same
OpenFork native binary.

Entrypoints remain deliberately isolated:

- `openfork` — canonical OpenFork behavior and product version.
- `opencode` — historical command-name forwarding only; it retains native
  OpenFork behavior for existing scripts.
- `openfork-t3code` — explicit T3/OpenCode-1.x façade.

The profile must never rewrite the canonical OpenFork release version globally,
provider user agents, persistence schema versions, or unrelated remote-service
identity. It changes only the local compatibility observations T3 uses.

## Process handshake

T3 Code relies on three process-level observations.

| Observation | T3 expectation | OpenFork façade |
| --- | --- | --- |
| CLI version probe | semantic version in supported OpenCode 1.x range | `1.15.13` |
| server startup | stdout containing `server listening on <url>` | `opencode server listening on <url>` |
| health probe | `GET /global/health` with `healthy: true` and semantic `version` | minimal legacy shape with version `1.15.13` |

### Generation follows the version, not the path

Current stock T3 negotiates the generation server-side in
`apps/server/src/provider/opencodeVersionProbe.ts`. The mechanics matter because
they determine which OpenFork-side changes are actually dangerous:

- `probeOpenCodeRuntime` is **mutually exclusive**. A non-empty `serverUrl`
  selects the server probe; otherwise the local `binaryPath --version` probe
  runs. The two are independent configurations, and proving one proves nothing
  about the other.
- `probeOpenCodeServer` tries `/api/info` **first**, then `/global/health`, and
  the **path selects only the decoder**. Generation comes from the decoded value:
  `probed()` returns `{ generation: major >= 2 ? "v2" : "v1", version }`. A
  decodable `/api/info` body reporting `1.15.13` therefore classifies as **v1**.
- A candidate only advances to the next one on `404`, a non-`200`, a
  non-`application/json` media type, or an undecodable body. Media type is
  normalized with `contentType.split(";")[0].trim().toLowerCase()`.
- The decoders are stricter than status plus content type. `/api/info` requires
  **both** `version: string` and `pid: int`; `/global/health` requires `healthy`
  as the literal boolean `true` plus a `version` string. The extra canonical
  `path` object is ignored, but a string `"true"` is not.
- A `401` is a **hard error on either path**, not a fall-through. Both generations
  answer a wrong password with `401` on either path, so it carries no version
  information and the probe raises immediately.
- The probe **appends** to the configured URL and preserves its query, so
  `/base/?x=1` becomes `/base/api/info?x=1`. Sub-path and reverse-proxy mounts
  are in scope.

#### The invariant that actually matters

The forbidden thing is a **decoded version whose major is `>= 2`**, on either
path — not the presence of a route. OpenFork's `404` on `/api/info` is correct
and current, but it is not what keeps this integration on v1; the reported
version is.

Two consequences:

- Under the T3 profile this is safe by construction, because only the profile
  pins the report to `1.15.13`.
- The forward hazard is **canonical OpenFork**. `localClientReportedVersion`
  serves both probe paths, and without the profile it reports OpenFork's real
  version. So the day OpenFork's own version reaches `2.0.0`, a `serverUrl`
  deployment pointed at a canonical OpenFork server negotiates **v2** with no
  route added, no configuration change, and no error naming the cause. That is a
  much more likely trigger than any `/api/*` work, and it should be tracked as a
  canonical-version-numbering concern rather than a T3-profile one.

The negotiation decision is pinned by
`packages/opencode/test/server/t3code-process-version-auth.test.ts`, and the
profile-pinned version's `major < 2` by
`packages/opencode/test/compat/t3code-version-window.test.ts`.

Canonical `openfork` invocations continue to print the OpenFork startup
identity and real OpenFork version. Historical `opencode` does the same; only
`openfork-t3code` projects the audited OpenCode 1.x identity.

## Authentication and config injection

T3's SDK client authenticates password-protected OpenCode servers with HTTP
Basic credentials using username `opencode`. OpenFork's server-auth contract
uses the same default username and `OPENCODE_SERVER_PASSWORD`, so the adapter
does not translate credentials or weaken normal server authentication.

### Password auth interoperates only where T3 actually forwards the credential

The sentence above is a statement about OpenFork, not a promise of end-to-end
interoperation. T3 forwards the password on the **session** client only when the
connection is external, so the working and broken configurations are the
opposite of the intuitive ones:

- `OpenCodeAdapterV2.ts:963-969` passes `serverPassword` only when
  `connection.external` is true. Per `opencodeRuntime.ts`, `external: true`
  means an externally-managed server (a `serverUrl` was configured) and
  `external: false` means a locally spawned managed process.
- Therefore **external `serverUrl` + password works**, and a
  **locally spawned password-protected server returns `401`** to the session
  client.

The asymmetry that makes this look like an OpenFork fault: the version probe
authenticates in **both** modes, while the session client's credential is
subject to the external guard. A green probe proves negotiation and generation
classification, and proves nothing about whether the session path can
authenticate.

In the local case T3 provisions the credential and then omits it:
`opencodeRuntime.ts:691-693` resolves the server password and `:707` places it
in the spawned child environment as `OPENCODE_SERVER_PASSWORD`, so OpenFork
enforces authentication correctly and the adapter simply declines to send that
same password back.

> **Do not relax authentication on `/global/health`, `/api/info`, or any other
> route to clear a `401` observed here.** OpenFork's auth behavior is correct;
> the credential is withheld by the consumer. Trading a canonical security
> boundary for a consumer-side omission is a canonical-behavior regression and
> must be treated as upstream's defect, not as work for this façade.

T3 also passes `OPENCODE_CONFIG_CONTENT` to locally spawned OpenCode
processes. OpenFork continues to consume that compatibility environment
variable as a normal config source. The T3 profile does not rewrite config,
provider, account, or persistence semantics.

## SDK operations consumed by T3 Code

The contract is intentionally defined by T3's real adapter call graph rather
than by all endpoints that happened to exist in OpenCode 1.15.13.

| SDK operation | Method | Legacy path |
| --- | --- | --- |
| `app.agents` | GET | `/agent` |
| `app.skills` | GET | `/skill` |
| `command.list` | GET | `/command` |
| `event.subscribe` | GET | `/event` |
| `global.health` | GET | `/global/health` |
| `mcp.add` | POST | `/mcp` |
| `permission.list` | GET | `/permission` |
| `permission.reply` | POST | `/permission/{requestID}/reply` |
| `provider.list` | GET | `/provider` |
| `question.list` | GET | `/question` |
| `question.reply` | POST | `/question/{requestID}/reply` |
| `session.abort` | POST | `/session/{sessionID}/abort` |
| `session.children` | GET | `/session/{sessionID}/children` |
| `session.command` | POST | `/session/{sessionID}/command` |
| `session.create` | POST | `/session` |
| `session.fork` | POST | `/session/{sessionID}/fork` |
| `session.get` | GET | `/session/{sessionID}` |
| `session.message` | GET | `/session/{sessionID}/message/{messageID}` |
| `session.messages` | GET | `/session/{sessionID}/message` |
| `session.promptAsync` | POST | `/session/{sessionID}/prompt_async` |
| `session.status` | GET | `/session/status` |
| `session.summarize` | POST | `/session/{sessionID}/summarize` |
| `session.update` | PATCH | `/session/{sessionID}` |

T3 creates its SDK client with a workspace directory. OpenFork continues to
accept the legacy `x-opencode-directory` carrier as well as the compatible
query form. Operations that carry an explicit `directory` in the generated
SDK, such as `session.fork`, keep that value at the routing boundary rather
than forcing it into the domain payload.

`session.status` is deliberately bootstrap-free and does not require a
directory. It may expose optional directory/workspace scoping as long as an
unscoped call remains valid and returns the legacy session-id map. T3 currently
invokes this operation with an undefined request payload.

## Multi-account model projection

OpenFork's canonical account-routing contract is richer than OpenCode 1.x:
account identity is first-class and remains separate from the account-neutral
model id. T3's OpenCode adapter has no independent account selector; it only
round-trips the opaque `provider/model` slug it discovers from
`provider.list`.

The T3 façade therefore projects one compatibility model row per executable
`(provider, model, account)` only while the T3 profile is active. Canonical
OpenFork discovery is not mutated.

- Providers with an existing legacy account-model ABI keep that ABI. WorkBuddy
  already publishes `<model>@wb-...`; Zen/OpenCode publishes
  `<model>@zen-...`. A compatibility row is suppressed only when one of those
  native aliases already represents the **same provider + base model + stable
  account identity**. Provider id alone is never a dedup key: a distinct
  Console-backed account remains independently selectable even when it exposes
  a provider that also has provider-native account aliases.
- First-class Console account routes that do not own a legacy suffix are
  exposed to T3 as
  `<base-model>@ofacct:<base64url(stable-account-id)>`.
- The display name is decorated with the disambiguated account label, so T3
  renders the rows as independent choices while retaining the same provider.
- The bare account-neutral model remains available when the canonical catalog
  exposes it; it continues to mean OpenFork's normal automatic route.
- Provider defaults remain account-neutral. Projecting explicit-account rows
  must never make one account become the new default.

The `@ofacct:` suffix is a compatibility wire encoding, not an OpenFork model
identity. Its base64url payload carries a versioned namespace sentinel plus the
stable account id, so unrelated model ids that merely resemble the suffix are
not claimed by the adapter. It is reversible, carries no credential secret,
and is decoded only inside the explicit T3 profile. `promptAsync`, native
`session.command`, and `session.summarize` unwrap the alias at the HTTP
boundary into OpenFork's canonical `providerID + base modelID + accountID`
representation before ProviderRoute resolution. T3 itself never sends an
`accountID` field.

Because the alias encodes the stable ProviderAccount identity rather than a
credential row id or mutable label, credential rotation and account renames do
not change T3's persisted model slug. If that stable account is removed, the
explicit selection fails closed; it must never silently fall back to another
account.

T3 currently parses OpenCode model slugs by splitting on only the first
`/`; therefore `@` and the opaque suffix survive inventory, selection,
session state, prompt submission, native commands, and compaction unchanged.

The CLI fallback must expose the same projection as the normal HTTP inventory:
`openfork-t3code models --verbose` and `provider.list` must enumerate the
same explicit-account model ids. This prevents a transient HTTP-inventory
failure from silently collapsing T3 back to one account-neutral model.

## Event contract

T3 currently consumes these legacy event types:

- `server.connected`
- `session.created`, `session.updated`, `session.deleted`,
  `session.error`, `session.compacted`, `session.status`
- `message.updated`, `message.removed`, `message.part.updated`,
  `message.part.delta`, `message.part.removed`
- `todo.updated`
- `permission.asked`, `permission.replied`
- `question.asked`, `question.replied`, `question.rejected`

The recognized session-status family remains `idle | busy | retry`. T3 is
tolerant of extra fields on those status objects but depends on those type
names and on the ordinary message/session/request identifiers in the events.

The legacy `/event` SSE route gives replayable frames an epoch-scoped
`Last-Event-ID`. Its bridge retains at most 4096 events / 8 MiB and keeps
capturing for 30 seconds after the last subscriber disconnects, covering the
pinned SDK 1.15.13 retry window without retaining an unbounded history while
idle. Reconnects within that grace replay from the supplied cursor. After expiry,
the cursor receives `server.stream.gap` and requires snapshot hydration. The
pinned T3 provider adapter currently ignores that gap event; therefore bounded
short-disconnect replay is supported, while recovery after the grace window is
not a production-ready guarantee. The SDK retries thrown transport errors but
ends its event stream on a clean EOF without retrying.

OpenFork may emit additional fork-specific events. They are not part of this
exception and do not need to be hidden merely because T3 ignores them.

## Request-shape invariants

The compatibility suite pins the payload details that are easy to break while
refactoring internal owners:

- T3's remote MCP registration accepts `oauth: false`, headers, and URL.
- async prompts accept T3's message ID, model ref, system addendum, and text/file
  parts; account selection is carried only by the aliased model id.
- native commands retain the legacy string model selector
  `provider/model`, including an account-qualified compatibility model id.
- manual compaction retains `providerID`, `modelID`, and `auto`; an
  explicit account again rides inside the model id because that is what T3
  actually sends.
- session updates retain legacy permission rules.

These are consumer-boundary invariants. OpenFork may add optional fields or
internal semantics without violating the contract.

## CLI fallback inventory

T3 also contains CLI-based inventory fallbacks. The façade must keep these
commands runnable with their legacy spellings:

- `models --verbose`
- `agent list`
- `debug skill`

The normal server inventory path remains authoritative for the integration:
`provider.list`, `app.agents`, `app.skills`, and `command.list`.

## T3-owned out-of-band surfaces

Not every OpenCode-shaped feature in T3 travels through the SDK/server wire.
Those surfaces must not be "fixed" by making OpenFork impersonate upstream
filesystem or package-manager ownership.

### Provider maintenance / updates

T3 independently resolves the configured OpenCode executable and derives an
update command from where that executable lives. The adapter must therefore be
configured through a **direct/native OpenFork `openfork-t3code` launcher
path**, or through an install channel whose ownership T3 can prove correctly.

- A direct/native release path is intentionally manual-only in T3.
- A Homebrew-installed adapter resolves through the actual OpenFork keg, so T3
  can derive `brew upgrade openfork` rather than an upstream npm update.
- Do **not** use a Bun-, pnpm-, or Vite+-global command shim as T3's
  `binaryPath`. At the audited T3 version those path classes are treated as
  package-manager ownership before package identity is proven, so T3 can
  propose installing/updating its stock `opencode-ai` package.

OpenFork must not rename the adapter to look like
`~/.opencode/bin/opencode`, and it must not fake upstream package ownership to
gain one-click maintenance. A maintenance action that cannot be proven to
target OpenFork is safer as manual-only.

### OpenCode Go usage limits

T3's OpenCode Go usage probe is also independent of the OpenCode server. It
reads `$XDG_DATA_HOME/opencode/auth.json` (or the platform-equivalent default)
and specifically looks for the `opencode-go` credential. OpenFork deliberately
does **not** shadow-write credentials into that upstream-owned path.

T3 already accepts `OPENCODE_API_KEY` and `OPENCODE_AUTH_CONTENT` in the
provider-instance environment. If OpenCode Go usage display is required while
using the OpenFork adapter, supply the credential through that existing T3
environment surface. Without it, the OpenFork runtime can still function
normally; only T3's independent Go-usage probe reports the feature unavailable.

## Distribution

`openfork-t3code` is part of the OpenFork release surface wherever practical:

- native release archives;
- npm launcher package;
- AUR package;
- Homebrew formula;
- official container image.

T3 local-process mode should set its existing OpenCode `binaryPath` setting to
`openfork-t3code`. T3 external-server mode bypasses that launcher entirely, so
the external OpenFork server must itself be started through
`openfork-t3code serve ...` (or with the equivalent
`OPENFORK_COMPAT_PROFILE=t3code-opencode-v1` environment) if the T3 façade is
required. T3 also skips its local `t3-code` MCP registration for external
OpenCode servers, so local-process mode is the preferred full-feature path.

On Windows native archives `openfork-t3code` is a `.cmd` launcher that sets
the profile and invokes the adjacent `openfork.exe`. On Unix-like platforms it
is an executable shell launcher using `exec`. The historical `opencode`
launcher remains a separate transparent OpenFork forwarding surface and must
not be repurposed as the T3 adapter.

The packaged-distribution promise above covers released archives. Running the
façade **from a source checkout** is a development harness concern: the
`bin/openfork-t3code` wrapper resolves the OpenFork binary through the normal
resolver, so the harness must supply `OPENFORK_BIN_PATH` pointing at a freshly
built native executable. A stale `dist/` binary predating the current checkout
can prove the shipped handshake while proving nothing about current source, so
harness evidence must always name the binary it used. Do not change the resolver
or the launcher to accommodate a source checkout.

## Non-goals

This exception does **not** mean:

- OpenFork supports arbitrary OpenCode SDK clients;
- every OpenCode plugin works in OpenFork;
- OpenFork must reproduce OpenCode 1.15.13 internals;
- OpenFork's native API must freeze at OpenCode 1.x;
- the historical `opencode` command becomes a broad compatibility promise;
- T3-specific constraints may leak into canonical OpenFork behavior.

The adapter should remain a thin projection over authoritative OpenFork runtime
owners. Duplicating session execution, provider logic, or event state inside a
T3 proxy would create two runtimes and is explicitly rejected.

## Maintenance procedure

When T3 changes its OpenCode integration:

1. Re-audit T3's locked `@opencode-ai/sdk` version, compatibility manifest,
   `opencodeRuntime.ts`, and `OpenCodeAdapter.ts`.
2. Diff the actual SDK method call graph against the table above.
3. Diff the event types and fields T3 reads.
4. Update the compatibility version only when the audited consumer contract
   changes; never derive it from the OpenFork release number.
5. Extend the focused contract tests before changing production behavior.
6. Keep the adaptation at the narrowest local-client boundary. Do not bend
   canonical OpenFork domain/runtime architecture around a consumer quirk.
7. Validate the compatibility launcher separately from canonical `openfork`
   so a fix cannot silently change normal product identity.

The regression owners are:

- `packages/opencode/test/compat/t3code.test.ts`
- `packages/opencode/test/server/t3code-compat-contract.test.ts`
- `packages/opencode/test/compat/t3code-version-window.test.ts` — the
  dual-generation version window from §Both generations must stay reachable at
  once, including the negative cases proving that guard has teeth.
- `packages/opencode/test/server/t3code-process-version-auth.test.ts` — the
  v1-vs-v2 negotiation decision from §Generation follows the version, not the
  path.
