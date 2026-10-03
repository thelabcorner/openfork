# OpenFork compatibility boundary

OpenFork is an **independent product surface descended from OpenCode**, not an
OpenCode-compatible client distribution or wrapper.

Source ancestry, retained package names, and release-tag merges do not create a
compatibility promise. OpenFork may change its local client APIs, local server
routes, runtime semantics, plugin interfaces, UI, tools, persistence, configuration,
and feature set whenever the fork's architecture requires it.

## The one strict upstream compatibility boundary

OpenFork must remain compatible with **upstream-operated remote OpenCode services
that OpenFork chooses to consume**, because those systems run outside this repository
and cannot be changed by the fork.

Examples currently include the OpenCode-hosted model/provider path such as Zen/Go,
and may include upstream-operated authentication, account, usage/quota, sharing,
GitHub integration, or other remote service endpoints actually used by OpenFork.

For each consumed upstream-operated remote service, preserve the externally observed
contract required by that service, including where applicable:

- endpoint/path and method semantics;
- authentication and account-selection behavior;
- required headers and client identity;
- request schemas and provider-native payload semantics;
- streaming/framing behavior;
- model identifiers and advertised capabilities;
- response/error contracts;
- quota, usage, billing, and retry semantics;
- version negotiation or migration behavior.

When upstream changes one of those remote contracts, OpenFork must adapt its local
adapter. Do not "improve" a remote wire contract in a way the upstream service does
not accept.

This is the repository's meaningful **1:1 fidelity requirement**.

## What is explicitly not an OpenCode compatibility target

The following are OpenFork-owned surfaces unless a narrower compatibility promise is
explicitly documented:

- local HTTP/server APIs;
- V1/current/V2 client APIs and generated clients;
- session/runtime implementation;
- UI/desktop/mobile behavior;
- tool contracts and tool inventory;
- plugin and extension APIs;
- CLI/TUI behavior;
- local configuration semantics;
- persistence/database layout;
- local events and projections;
- fork-specific orchestration and agent behavior.

An OpenCode plugin, extension, client, script, config, or local-API consumer **may
not work with OpenFork**. Likewise, an OpenFork integration may not work with
OpenCode. Never advertise or assume cross-product compatibility from a shared
`@opencode-ai/*` package name or common ancestry.

If OpenFork intentionally supports a particular upstream local integration, that is
an **explicit compatibility exception**. Name the exact surface and version range,
add tests, and document the support boundary.

### Explicit compatibility exception: T3 Code OpenCode 1.x provider

T3 Code is supported through a narrow OpenCode-1.x compatibility profile, not
by making canonical or historical OpenFork entrypoints generically
OpenCode-compatible. The current façade is pinned to the OpenCode **1.15.13**
client contract consumed by T3 Code and is activated by the explicit
`openfork-t3code` launcher. T3 already exposes a configurable OpenCode
`binaryPath`, so this requires no upstream source change.

The exception covers only the process handshake, legacy HTTP operations, request
shapes, and legacy event/status semantics actually consumed by T3's OpenCode
provider. Canonical `openfork`, OpenFork persistence/domain semantics, and
unrelated provider identities remain native OpenFork surfaces.

The full consumer snapshot, operation/event matrix, distribution requirements,
and update procedure are documented in
`docs/architecture/t3code-compatibility.md`.

### Explicit compatibility exception: WakaTime OpenCode integration

OpenFork's first-party WakaTime exporter intentionally preserves the dashboard-visible
heartbeat contract of `opencode-wakatime` **1.4.0**. This exception is behavioral,
not a promise that OpenFork can load that OpenCode plugin or reproduce its internal
module/lifecycle structure. Newer plugin releases are not automatically covered until
their externally observable heartbeat behavior is reviewed and the reference version
here is updated.

The compatibility target covers the semantics WakaTime observes: file entities,
`ai coding` category, per-file coalescing, signed AI line-change deltas with zero
omitted, optional write markers, proven project-folder scoping, batched extra
heartbeats, the ordinary 60-second project delivery floor, forced settlement, and
WakaTime configuration discovery including `WAKATIME_HOME` tilde expansion. The
delivery floor is restart-persistent as in the reference adapter, but OpenFork uses
one bounded mode-0600 state document containing only SHA-256 project fingerprints
and timestamps rather than one raw-path-derived state file per project.

OpenFork deliberately diverges where first-party ownership makes the behavior safer
or more accurate: one process-global exporter, explicit opt-in and a Tier-0 control
surface, observation timestamps on the primary heartbeat, OpenFork-owned plugin
identity, `--sync-ai-disabled` to prevent transcript double counting, bounded queues
and replay state, and checksum-verified/tag-pinned/bounded managed CLI delivery.
Internal attribution and idempotency are separate: `sourceRef` may be a durable
actor/principal identity, while only a producer-proven per-observation `replayToken`
can suppress a replay. Neither identifier is serialized to WakaTime.
The plugin identity is intentionally producer-aware: native activity is attributed
to `openfork`, OXP activity to `openfork-oxp`, and OFXP activity to
`openfork-ofxp`. A second stable `openfork-wakatime` token identifies the
first-party integration. Carrier-client identity is deliberately omitted from the
WakaTime wire so desktop/CLI/ACP transport details cannot fragment or override the
three producer-attribution buckets. Since one CLI invocation owns one `--plugin`
value for its primary and extra heartbeats, Core partitions a project batch by that
attribution boundary without splitting the project-scoped delivery limiter into
independent rate windows. The automatic scheduler selects one canonical project per
turn and includes all of that project's attribution buckets, bounding one automatic
turn to at most three sequential CLI attempts before yielding and immediately
continuing with another ready project. Explicit flush remains a full settlement
operation. A missing credential or unavailable CLI is not a delivery attempt: it
opens no project window and releases any provisional replay suppression so the same
logical observation can be retried once delivery becomes available.

`projectFolder` is a producer-authority contract rather than a Core filesystem
lookup. V1 instance roots enter through `FSUtil.resolve`, Git worktrees are resolved
at project discovery, and OXP/OFXP approved roots are realpathed before attribution.
The Tier-0 exporter therefore uses the supplied canonical folder directly and does
not stat/realpath on every coding observation.
OpenFork's write marker follows WakaTime's write/save meaning rather than copying any
upstream adapter heuristic that only marks newly-created files. Those differences are
part of the supported OpenFork contract and must not be "fixed" merely to reproduce
plugin internals.

Plugin-owned diagnostics are also outside this exception. OpenFork does not recreate
the plugin's private `opencode.log` file or its `debug = true` config sniffing; WakaTime
CLI configuration remains WakaTime-owned, while first-party exporter diagnostics use
OpenFork's existing logging/observability surfaces.

## Distribution is not compatibility

Retained executable, config, package, and protocol identifiers exist to avoid
gratuitous migration cost. They do not make upstream OpenCode distribution channels
part of OpenFork.

OpenFork-owned update and installation paths must resolve to fork-owned release
artifacts. In particular, an `opencode` executable name or `@opencode-ai/*`
import does not justify fetching or publishing through upstream npm, Homebrew,
Scoop, Chocolatey, GitHub releases, containers, or `opencode.ai/install`.

If an installation came from a channel OpenFork does not own, treat the executable
as externally managed. Update discovery may still inform the user about a matching
OpenFork release, but replacement must fail closed rather than invoking an upstream
package manager.

## OpenChamber comparison

OpenChamber-style products wrap or consume OpenCode while intentionally preserving
OpenCode as the underlying compatible runtime surface.

OpenFork is different: it is a source-level branch fork. It owns and changes the
runtime, client/server contracts, interface, and features. Git ancestry and upstream
tag merges are maintenance mechanisms, not a promise that OpenFork remains a drop-in
OpenCode client or server.

## Upstream source is a donor, not an authority over local behavior

Upstream release tags remain valuable sources of:

- provider/backend contract updates;
- security and correctness fixes;
- model/provider support;
- performance improvements;
- current/V2 architectural ideas worth backporting;
- dependency and ecosystem updates.

Each local upstream change is evaluated against OpenFork's architecture. It may be
taken, adapted, backported, or rejected. Current/V2 code is especially useful as a
semantic/reference implementation for improving V1, but OpenFork is not obligated to
adopt the current/V2 local client or runtime migration.

## Review rule

Whenever documentation or code says "compatibility," identify the target:

1. upstream-operated remote service compatibility;
2. third-party provider compatibility;
3. OpenFork internal migration/backward compatibility;
4. an explicitly supported OpenCode local integration.

Unqualified "OpenCode compatibility" is ambiguous and should not be used.
