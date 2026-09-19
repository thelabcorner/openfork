# OXP — OpenAI Exchange Protocol architecture ledger

Status: architecture/research phase

Date opened: 2026-09-18

Primary objective: make OpenFork the first-party **local support substrate for already-running ChatGPT-side agents**. An OpenFork installation should replace the standalone localMCP-chat client while preserving LocalMCP's mature tunnel/security/tool behavior and adding direct access to OpenFork-native capabilities, supervision of existing OpenFork agents, and delegation into new OpenFork subagent Sessions.

**OXP = OpenAI Exchange Protocol.** OXP is the OpenFork-defined first-party exchange surface purpose-built for ChatGPT/OpenAI Secure MCP Tunnel connectivity. It is not an OpenAI-authored public standard, and it is not an MCP-to-ACP translator.

The load-bearing product distinction is:

> **ACP bootstraps and drives an OpenFork agent. OXP supports an already-running external agent.**

ChatGPT remains the upper-level external agent and retains its own conversation/runtime identity. OXP does not create a mandatory backing OpenFork Session for ChatGPT. Instead, OXP gives that external agent three orthogonal powers:

1. **Augmentation** — directly use OXP-safe OpenFork/local capabilities.
2. **Supervision** — inspect and control authorized existing OpenFork Sessions and their requests/state.
3. **Delegation** — create and supervise new OpenFork worker/subagent Sessions.

OXP is structurally modeled after ACP only at the adapter/lifecycle boundary. MCP is the ChatGPT-facing wire protocol; OXP is the OpenFork semantic/product contract for augmenting, supervising, and delegating on behalf of an external agent.

---

## 0. Ground-truth sources

This plan is derived from executable/source-level behavior first.

### Standalone LocalMCP capability/security oracle

Repository: /webstormprojects/localMCP-chat

Read before implementation:

- AGENTS.md
- docs/tools.md
- docs/opencode-control-architecture.md
- src/clean/main/mcp.ts
- src/clean/main/connection.ts
- src/clean/main/state.ts
- src/clean/main/tools/registry.ts
- src/main/sandbox.ts
- src/main/secrets.ts
- src/main/tunnel/index.ts
- src/main/plugins/**
- src/main/integrations/opencode/backend.ts
- src/clean/main/tools/file-transfer.ts
- src/main/files/**
- src/clean/renderer/views.ts
- src/clean/main/ipc.ts

The standalone project remains the behavioral source of truth for LocalMCP approved-root semantics, tool behavior, file-transfer rules, tunnel resilience, secure-secret behavior, dynamic integration projection, metrics, and operator UX until each capability is explicitly dispositioned below.

### OpenFork protocol/runtime oracle

Repository: /webstormprojects/opencode

Read before implementation:

- root and relevant package AGENTS.md files
- FORK.md
- docs/map/README.md
- docs/map/architecture.md
- docs/map/surfaces.md
- docs/map/v1-v2.md
- docs/handoff/ARCHITECTURE-OWNERSHIP-PLAYBOOK.md
- packages/opencode/src/acp/**
- packages/opencode/src/tool/registry.ts
- packages/opencode/src/session/tools.ts
- packages/opencode/src/mcp/**
- packages/opencode/src/background/**
- packages/opencode/src/session/**
- packages/desktop/src/main/server.ts
- packages/desktop/src/main/index.ts

OpenFork ACP is the structural precedent for treating an external agent protocol as a first-party adapter with protocol-local state, event projection, permission mediation, and lifecycle rather than as an ordinary custom tool/plugin.

OpenFork's mature V1/fork runtime remains the production execution target. Current/V2 semantics are an architectural oracle/donor, not an automatic local API or runtime migration destination.

---

## 1. Product thesis

Standalone LocalMCP proved that a ChatGPT-side agent can securely reach the user's machine, but today it does so through a largely parallel local capability stack:

    ChatGPT agent
      | MCP
      v
    localMCP-chat
      |- read/find/edit/patch/git
      |- shell/PTY/background
      |- project/symbols/typecheck/test
      |- archive/JSON/skills
      |- external MCP lifecycle
      |- OpenAI file transfer
      `- OpenCode Control -> HTTP/SSE -> OpenFork

OpenFork independently owns richer versions of much of that runtime plus durable Sessions, agents, providers/models, provenance, checkpoints, browser/LSP, Goals, memory, workers, requests, and external MCP clients.

OXP should collapse those two worlds without changing who the upper-level agent is.

The target is:

    already-running ChatGPT agent
      |
      | OpenAI Secure MCP Tunnel / MCP
      v
    OpenFork OXP
      |
      +---- AUGMENTATION
      |       |- workspace/filesystem
      |       |- git/process/background
      |       |- project/symbols/LSP/tests/typecheck
      |       |- checkpoints/goals/memory/browser where policy allows
      |       `- external MCP integrations
      |
      +---- SUPERVISION
      |       |- inspect existing OpenFork Sessions
      |       |- read messages/state/children
      |       |- pause/resume/abort/continue
      |       `- mediate authorized Permission/Question requests
      |
      `---- DELEGATION
              |- create OpenFork worker/subagent Sessions
              |- select user-authorized model policy
              |- wait/result/continue/cancel
              `- supervise worker groups/batches

OpenFork remains the authoritative owner of local capabilities and native OpenFork Session/agent state. **ChatGPT remains the external supervising agent.** OXP is the support substrate between them.

The standalone LocalMCP application should become unnecessary for an OpenFork desktop user.

The integrated implementation should be strictly more capable than standalone LocalMCP because OpenFork improvements become available to ChatGPT through one shared runtime instead of a second implementation—and because OXP exposes higher-order supervision/delegation that standalone workstation tools alone cannot provide.

---

## 2. Architectural identity: sibling of ACP, but opposite operating orientation

The correct high-level analogy is:

    external ACP client                ChatGPT agent
           | ACP                          | MCP / OXP
           v                              v
    OpenFork ACP adapter            OpenFork OXP adapter
           \                              /
            \                            /
             +---- OpenFork runtime -----+

ACP and OXP are siblings because both are first-party external protocol adapters over the same OpenFork-owned runtime. They are **not peers in purpose**, however.

The shortest distinction is:

> **ACP bootstraps and drives an OpenFork agent. OXP equips an already-running external agent with OpenFork.**

### 2.1 Initiating-agent protocol vs supporting-agent protocol

ACP is designed around **initiating agents**.

Its protocol center is an OpenFork-backed agent/session lifecycle. The current implementation exposes `newSession`, `loadSession`, `resumeSession`, `prompt`, `cancel`, `forkSession`, session model/mode/config operations, and related event/permission projection. `newSession()` resolves a workspace/model/mode and immediately creates the backing OpenFork Session.

Conceptually:

    human / IDE
       |
       v
    ACP client
       |
       | initiate / load / prompt
       v
    OpenFork Session + Agent
       |
       v
    OpenFork tools/runtime

The external IDE is principally a **client of the OpenFork agent**. The protocol exists so that the IDE can instantiate, configure, prompt, observe, and interact with that agent.

OXP is designed around **supporting already-existing external agents**.

The ChatGPT-side agent already exists, is already reasoning, already has its own conversation/runtime, and does not need OpenFork to instantiate its primary agent identity. OXP augments that agent with OpenFork-owned capabilities and orchestration.

Conceptually:

    ChatGPT agent
       |
       +---- direct OpenFork capabilities
       |       read / find / edit / git / process / project / ...
       |
       +---- inspect/control existing OpenFork Sessions
       |
       +---- create delegated OpenFork subagent Sessions
       |       start / wait / continue / cancel / batch
       |
       +---- interact with OpenFork session requests
       |       permissions / questions
       |
       +---- use OpenFork external MCP integrations
       |
       +---- exchange local/OpenAI files
       |
       `---- access future OXP-safe OpenFork capabilities

There is **no required backing OpenFork Session for the ChatGPT agent itself**.

That is the defining asymmetry.

### 2.2 Primary object differs

For ACP, the primary protocol object is the **agent session**.

For OXP, the primary protocol object is the **external principal plus its authorized capability graph**.

OXP's root semantic state is therefore:

    external principal
      + connector identity
      + approved roots
      + OXP support grant
      + invocation/provenance lineage
      + explicit durable handles

not:

    current backing OpenFork session

OpenFork Sessions are one resource domain OXP can address. They are not the container that gives OXP meaning.

### 2.3 OXP has three simultaneous roles

OXP should explicitly support three modes without conflating them:

1. **Capability augmentation**
   - ChatGPT directly uses local capabilities that OpenFork agents also benefit from.
   - No OpenFork Session is required merely to read a file, inspect a project, run Git, or start an authorized process.

2. **Agent supervision**
   - ChatGPT inspects, prompts, pauses, resumes, aborts, or otherwise interacts with existing OpenFork Sessions.
   - One external ChatGPT agent may observe/control multiple authorized OpenFork Sessions rather than being bound to one backing session.

3. **Agent delegation**
   - ChatGPT creates OpenFork subagent/worker Sessions for work that should execute inside the OpenFork agent runtime.
   - Those workers can use OpenFork's model/provider/tool/runtime features and return results to the supervising ChatGPT agent.
   - OXP preserves explicit model policy, provenance, authorization lineage, cancellation, and durable worker handles.

This is broader than ACP's normal initiating-client role without making OXP a replacement for ACP. ACP remains the correct first-party surface when an IDE wants **OpenFork itself to be the agent**. OXP is the correct surface when an external agent wants **OpenFork to augment and orchestrate its work**.

### 2.4 Session topology consequence

Do not model OXP as:

    ChatGPT connection
       -> OXP backing Session
          -> everything else

Model it as:

    OXP Principal
       |
       +-> Invocation A -> direct capability
       +-> Invocation B -> direct capability
       +-> Existing Session X
       +-> Existing Session Y
       +-> Delegated Worker Session Z
       `-> Worker Group G

A native SessionID appears only when an operation actually addresses or creates a native OpenFork Session.

This is why OXP must not fabricate Sessions merely to reuse `Tool.Context`, process ownership, read grounding, or permission machinery.

### 2.5 Authority consequence

ACP's client is asking OpenFork's agent to act.

OXP's external agent is itself an actor asking for access to several OpenFork domains.

Therefore OXP requires a stronger explicit **principal/capability authority boundary** than ACP's session-centric adapter shape:

    OXP principal grant
      INTERSECT approved location
      INTERSECT addressed domain policy
      INTERSECT native Session permission when a Session is involved
      INTERSECT hard safety invariants

A Session permission is conditional additional authority when OXP crosses into a native Session. It is not the root authority for direct OXP capabilities.

### 2.6 Provenance consequence

An OXP-created OpenFork worker is not the original agent.

Its causal shape is:

    human authorization/configuration
      -> external ChatGPT agent
         -> OXP invocation
            -> delegated OpenFork worker/session

The worker's provenance must retain that delegation lineage without pretending:

- the ChatGPT-side agent is an OpenFork Session;
- the delegated worker turn was directly typed by the human;
- provider role `user` proves human ownership;
- OXP connector identity itself grants privileged instruction authority.

This makes OXP an important consumer of OpenFork's generalized provenance architecture.

### 2.7 Product consequence

ACP primarily makes OpenFork agents accessible **from another client**.

OXP makes OpenFork useful **to another already-running agent**.

That produces two levels of power:

1. **Agent-level capability augmentation** — give the ChatGPT-side agent access to useful OXP-safe capabilities that a native OpenFork agent may also possess.
2. **Meta-agent orchestration** — let the ChatGPT-side agent operate on the OpenFork agent system itself through supervision and delegation.

The meta-agent layer includes:

- inspect Session state/history;
- discover existing agents/Sessions;
- supervise multiple authorized Sessions concurrently;
- answer or reject authorized Session requests;
- create delegated subagent/worker Sessions;
- wait/continue/cancel worker Sessions and groups;
- select user-authorized delegated-worker model/agent policy;
- inspect higher-order runtime state where product policy allows.

OXP also brokers file exchange and external MCP integrations as supporting capabilities.

In that sense OXP is intentionally an **agent-augmentation + meta-agent orchestration substrate**, not merely another agent-client protocol.

### 2.8 Two levels of power: capability-equivalent vs meta-agent

**Capability-equivalent augmentation** gives the external ChatGPT agent useful capabilities that a native OpenFork agent may also use:

- filesystem read/search/mutation;
- Git;
- process execution/background jobs;
- project/symbol/LSP/test/typecheck services;
- archive/JSON/data operations;
- external MCP integrations;
- browser/computer capabilities when explicitly enabled;
- other OpenFork-native tool capabilities that can be extracted to protocol-neutral executors.

These operations execute **as the OXP external principal**. They do not pretend that some OpenFork Session's resident agent made the call.

**Meta-agent operations** act on OpenFork's agent/session system itself and split into two distinct OXP planes:

**Supervision** targets already-existing native OpenFork Sessions:

- list/inspect Sessions;
- read Session messages/state;
- prompt/continue/pause/resume/abort where policy allows;
- inspect children/background agents;
- inspect/reply to Permission and Question requests.

**Delegation** creates or drives subordinate native OpenFork Sessions:

- create worker/subagent Sessions;
- supervise worker groups/batches;
- wait/result/continue/cancel;
- enforce explicitly user-authorized model/agent policy;
- enforce nested-delegation policy.

Meta-agent operations are not ordinary agent tools. They are higher-order orchestration privileges and therefore use explicit supervision/delegation contracts rather than the augmentation capability executor abstraction.

### 2.9 Never impersonate a resident OpenFork agent

If ChatGPT uses OXP to invoke a capability *against* an existing OpenFork Session, the durable system must distinguish at least:

    actor = external OXP agent
    target = OpenFork Session
    operation = <supervisory action>

from:

    actor = resident OpenFork agent
    target = its own Session
    operation = model-emitted tool call

Do not insert an OXP-issued operation into session history/provenance as though the resident model emitted that tool call.

If the operation legitimately creates session-visible state, the producer must persist truthful external/supervisory provenance and let downstream projections render it appropriately.

This distinction is especially important for checkpoints, Goals, permission replies, session selection/model policy, file mutation associated with a Session, and any future capability whose semantics feed replay/recovery.

### 2.10 Session tools are a capability source, not automatically the execution API

The user-facing goal is **useful capability parity** with the tools/capabilities available to OpenFork Sessions, plus higher-order meta-agent operations. Architecturally this does **not** mean OXP should forward arbitrary calls into `Tool.Def.execute()` or promise parity with resident-agent-only mechanics.

For each native tool, classify it:

1. **Session-independent capability** — extract/share the underlying executor and let OXP call it directly.
2. **Session-targeted capability** — require an explicit authorized Session target and preserve external supervisory provenance.
3. **Resident-agent-only mechanic** — do not expose directly if the semantics only make sense as part of a model turn, provider lowering, transcript state machine, or internal recovery path.
4. **Meta-agent operation** — expose through explicit OXP supervision or delegation adapters rather than pretending it is a normal augmentation tool.

This classification is what lets OXP become broader than ACP without punching holes through OpenFork's ownership model.

### Copy from ACP

- an explicit protocol boundary;
- protocol-specific connection/session state only when the protocol requires it;
- request translation into OpenFork domain operations;
- OpenFork event/result projection back into the external protocol;
- explicit cancellation;
- permission mediation;
- bounded protocol-local caches;
- owned lifecycle and teardown;
- no UI scraping or database reconstruction.

### Do not copy ACP mechanics blindly

ACP currently reaches much of OpenFork through generated SDK/HTTP/event-stream surfaces. That is existing implementation evidence, not a requirement for OXP.

For OXP:

1. identify the authoritative domain/runtime owner first;
2. share or extract the lowest correct service where possible;
3. add a narrow fork-owned bridge only where a process boundary requires one;
4. do not make generic HTTP proxying the architecture;
5. do not invent a second copy of OpenFork state in the connector.

OXP should therefore be ACP-like in adapter structure and lifecycle discipline, not an ACP hop in the request path.

---

## 3. Hard architectural laws

### 3.1 One semantic owner

If OpenFork already owns a capability or Session-domain fact, OXP must not create another implementation/source of truth. Standalone LocalMCP is the behavioral/security oracle during migration, not the permanent owner of duplicated runtime code.

### 3.2 Protocol adapters are not domain owners

MCP, ACP, OXP adapters, HTTP, UI, and generated SDKs are projections. They do not become the source of workspace identity, Session identity, model/provider truth, tool authority, provenance, process ownership, worker state, or project state.

### 3.3 The external agent remains external

ChatGPT is already an agent before OXP is invoked. OXP must not manufacture a backing OpenFork Session merely to represent ChatGPT, to reuse Tool.Context, to own a process, or to gain permission state.

A native OpenFork Session exists in OXP only when ChatGPT explicitly **targets** an existing Session or **delegates** work into a newly created Session.

### 3.4 Augmentation, supervision, and delegation are distinct planes

Every OXP operation belongs to one semantic plane:

- **augmentation** — the external agent invokes a local/OpenFork capability directly;
- **supervision** — the external agent observes or controls an existing native OpenFork Session/resource;
- **delegation** — the external agent creates or drives a subordinate OpenFork worker/subagent Session.

Do not collapse these into one generic 'agent control' identity. Their authority, provenance, persistence, and cancellation semantics differ.

### 3.5 Never impersonate a resident OpenFork agent

An OXP-issued operation remains attributable to the external OXP principal. If it targets an OpenFork Session, the Session is the target—not proof that its resident model emitted the action.

Session-visible effects created by OXP must persist truthful external/supervisory/delegation provenance wherever that distinction matters to replay, checkpoints, Goals, authorization, UI attribution, or recovery.

### 3.6 External authority is explicit and narrower

ChatGPT does not automatically inherit everything the local OpenFork user or a native OpenFork agent can do. The connector owns explicit grants for augmentation capabilities, Session supervision, worker delegation, nested delegation, integration/network access, and file ingress/egress.

Every operation rechecks live authority at execution time. A cached tools/list result is never authorization.

### 3.7 No ChatGPT conversation ID as authorization

Preserve standalone LocalMCP's invariant: no request is authorized merely because it claims a ChatGPT conversation identity. Correlation IDs may support tracing/idempotency, but they are not capability tokens.

### 3.8 Stable top-level model-facing schema

Provider/model/Session/worker/integration churn must not continuously change the MCP tool prefix. Runtime state belongs in results/catalogs, not permanent declarations.

### 3.9 No implicit workspace

Missing location on Tier 2/3 operations must not become process.cwd(). A request must name an approved location, derive one from an explicitly targeted authorized Session, or fail.

### 3.10 Disabled means near-zero cost

When OXP is disabled there should be no tunnel-client process, retry loop, MCP listener, workspace instance, tool-catalog hydration, external-MCP enumeration, or connector event stream. Configuration visibility may remain cheap Tier 0 state.

---

## 4. Process topology

The desktop v1 topology is resolved:

    already-running ChatGPT agent
      | OpenAI Secure MCP Tunnel / MCP
      v
    Electron main
      |- OS-secure connector credentials
      |- tunnel-client lifecycle
      |- tray/login-item/window lifecycle
      |- native folder picker
      |
      | privileged utility-process IPC
      v
    existing OpenFork sidecar
      |- dedicated OXP loopback MCP endpoint
      |- OxpAuthority / approved roots
      |- augmentation capability plane
      |- supervision plane -> existing Sessions/requests
      |- delegation plane -> worker/subagent Sessions
      |- external MCP broker
      `- native OpenFork domain/runtime services

Electron main is the OS-native transport/lifecycle owner. The sidecar is the OXP semantic/runtime owner because it already hosts the authoritative OpenFork capability and Session domains.

The OXP endpoint is a dedicated 127.0.0.1 listener inside the existing sidecar, not an ordinary OpenFork HTTP route and not a second heavyweight OXP daemon. The tunnel client is supervised by Electron main and points at the current secret sidecar endpoint generation.

This topology preserves the core orientation: ChatGPT remains outside OpenFork as the supporting-agent principal; the sidecar gives it direct capability access plus explicit bridges into native Session supervision and delegation. See section 31 for the full process-boundary contract.

---

## 5. Ownership tiers applied to OXP

### Tier 0 - connector/process-global

Examples: enabled state, connector name/identity, non-secret tunnel settings, secure-storage availability, connector health, tool fingerprint, aggregate metrics, process-global OpenFork capability/version facts, and materialized global session indexes.

Negative invariant: opening settings or reporting connector health creates zero workspace Instances.

### Tier 1 - durable location/session metadata

Examples: approved root aliases/canonical paths, durable session-to-directory mapping, worker/group ownership metadata, cheap project/session identity.

Negative invariant: listing roots/sessions does not initialize plugins, tools, LSP, VCS, snapshots, or shell runtime.

### Tier 2 - workspace catalog

Examples: agents, provider/model catalog, commands/skills, external MCP catalog, and reasoning variants. Explicit location is required where the answer is workspace-dependent.

### Tier 3 - execution

Examples: live filesystem operations, mutation, shell/PTY, git mutation, tests/typecheck/LSP, model turns, worker start/continue, browser automation, checkpoints/snapshots.

Full runtime construction may be justified here, but must be attributable to the exact external request and approved location.

---

## 6. Conceptual first-party OXP services

These services are organized around an **external supporting-agent principal**, not around an OXP-owned backing Session.

### 6.1 OxpConfig

Owns durable connector enablement, stable connector identity/label, approved roots, augmentation grants, Session-supervision policy, delegation/nested-delegation policy, external-integration policy, and file receive/send policy.

It does not own native OpenFork Session/worker truth, provider/model catalogs, external MCP runtime state, desktop tunnel lifecycle settings, or secrets.

### 6.2 OxpAuthority

Authoritative evaluator for the external agent's grant. Inputs include connector config revision, operation plane (`augmentation | supervision | delegation`), requested capability/action, approved location, explicit target Session/resource when applicable, and native OpenFork policy that belongs to that target domain.

Outputs include allow/ask/deny, canonical addressed location/target, and effective capability metadata suitable for audit/provenance.

This is where LocalMCP approved-root semantics converge with OpenFork's domain-specific permissions without making native Session permission the root authority for all OXP calls.

### 6.3 OxpCatalog

Projects a compact stable ChatGPT-facing catalog across the three OXP planes: direct augmentation capabilities, native supervision/delegation operations, lazy OpenFork capabilities, and configured external MCP servers. Catalog generation is not authorization.

### 6.4 OxpInvocation

One external-agent call admission boundary owning correlation/request ID, connector principal, operation plane, authority reference, explicit location/target, cancellation, timing/metrics, provenance seed, and bounded result projection.

An `OxpInvocation` is **not** an OpenFork Session turn.

### 6.5 OxpProvenance

Converges with OpenFork's generalized provenance work rather than treating mutable metadata.localMcp as immutable origin.

Target semantics:

    origin/lineage:
      actor: external_agent
      protocol: oxp_over_mcp
      connector: <stable connector id>
      request: <correlation id>
      plane: augmentation | supervision | delegation
      targetSession?: <native SessionID>

    authorization lineage:
      grant: <external grant/policy revision>
      initiating human authorization lineage when applicable

    instruction authority:
      conversational unless separately elevated by a trusted OpenFork rule

Supervision must not masquerade as resident-agent tool emission. Delegated workers and native task descendants inherit causal delegation lineage without pretending the ChatGPT-side agent is itself an OpenFork Session or that its request was directly typed by the human.

### 6.6 OxpTunnelSupervisor

Owns the state machine:

    disabled -> starting_endpoint -> connecting_tunnel -> connected
             -> degraded/offline -> reconnecting -> connected

Preserve proven standalone rules: one recovery owner per tunnel, distinguish auth/config failure from network outage, do not kill a healthy tunnel on one missed probe, explicitly own child process trees, make teardown convergent, and push status rather than making each UI consumer poll.

---

## 7. Capability disposition matrix

| Standalone capability | Target disposition | Core rule |
| --- | --- | --- |
| MCP HTTP endpoint | Port protocol behavior | First-party adapter; retain bounded input and loopback hardening where applicable. |
| Secure tunnel | Port/adapt | Native connector supervisor; do not mingle with tool semantics. |
| Connector identity | Port/adapt | Stable connector identity, never an OpenFork agent name. |
| Approved-root sandbox | Port semantics, share path primitives | Explicit external authority boundary. |
| read/find | Reuse OpenFork owners | Preserve LocalMCP batching/bounded-output advantages. |
| edit/patch | Reuse/converge | Preserve stale-read, rollback, concurrent-edit, and EOL invariants. |
| git | Reuse OpenFork Git owner | Typed modes/confirmations; no second Git runtime. |
| exec/write_stdin | Reuse OpenFork process owner | One live-process implementation. |
| shell/background | Reuse OpenFork background/process owners | One job ownership model. |
| archive/JSON | Extract/share lowest correct service | No duplicate implementations. |
| skill | Reuse/converge OpenFork Skill | MCP-approved view may be narrower. |
| project | Reuse OpenFork Project | Preserve metadata-first orientation. |
| symbols/test/typecheck | Reuse/converge OpenFork services | Future OpenFork improvements flow through automatically. |
| file receive/send | Port protocol-specific semantics | Separate ingress/egress authority. |
| external MCP plugins | Replace with OpenFork MCP service | One MCP client runtime. |
| opencode_info | Direct OpenFork projection | Remove same-machine integration hop. |
| opencode_session | Direct OpenFork **supervision** projection | Inspect/control authorized existing native Sessions without impersonating their resident agents. |
| opencode_worker | Direct OpenFork **delegation** projection | Create/supervise subordinate OpenFork worker Sessions and groups. |
| opencode_request | Direct OpenFork **supervision** projection | Mediate Permission/Question requests belonging to authorized target Sessions. |
| metrics/logging | Port into shared observability | MCP dispatch remains measurable and bounded. |
| standalone control UI | Replace with OpenFork V2 settings | Do not port the duplicate renderer. |
| tray/autostart | Add to OpenFork desktop | Required replacement behavior. |

---

## 8. Tool-surface strategy

### 8.1 Do not expose every OpenFork tool permanently

OpenFork already has a larger capability inventory than standalone LocalMCP. Publishing all schemas would increase prompt-prefix size, damage provider prompt-cache stability, worsen tool selection, and create refresh churn.

### 8.2 Compact direct hot set

Candidate direct tools: read, find, edit, patch, git, exec_command/write_stdin, shell/background, project, and possibly symbols/test/typecheck plus file_transfer when configured.

Final membership must be chosen from real standalone call-frequency evidence rather than aesthetics.

### 8.3 Stable progressive gateway for long-tail capabilities

Use a compact progressive discovery surface analogous to LocalMCP integration list/inspect/call and OpenFork lazy tool access, conceptually:

    capability.list
    capability.inspect
    capability.call

This can broker niche OpenFork native capabilities, external MCP tools, and future capabilities without permanent top-level schema churn. Authorization still occurs at the leaf.

### 8.4 Native OpenFork supervision/delegation tools

The current four-tool OpenCode Control experiment is cache-friendly, but OXP should reinterpret the domains explicitly around its supporting-agent role:

- openfork_info
- openfork_session
- openfork_worker
- openfork_request

Preserve and re-evaluate the current action inventory:

- **info/discovery**: status, capabilities, providers, models, agents, limits, usage;
- **session supervision**: list, get, messages, children, selection, set_selection, send/turn where explicitly authorized, pause, resume, abort, background_subagents;
- **worker delegation**: model_policy, set_default_model, clear_default_model, start/list/get/wait/result/continue/cancel, grouped worker operations;
- **request supervision**: list, reply_permission, answer_question, reject_question.

Same-machine service discovery, OpenFork device pairing, realm routing, and LocalMCP-to-OpenFork HTTP mediation should disappear from this first-party path. Those were necessary between independent applications, not permanent semantic requirements.

### 8.5 Deliberate schema cutover

Moving opencode_* to openfork_* is a deliberate model-facing schema break and may require one ChatGPT custom-app refresh. Do not carry permanent top-level aliases if they double schema weight forever. After cutover, dynamic runtime state must not alter the fixed schema.

---

## 9. Approved roots and workspace authority

OpenFork knowing that a project exists is not equivalent to ChatGPT being authorized to access it. OXP therefore retains a dedicated approved-root concept.

Required properties:

- user explicitly selects roots;
- each root has a stable model-facing alias;
- native absolute paths need not cross the MCP boundary;
- symlink/junction escape is rejected at operation time;
- removing a root immediately revokes future operations;
- mutation authority is revalidated at the commit boundary where necessary;
- relative paths are accepted only when unambiguous;
- Session supervision is allowed only when the durable target Session directory resolves inside an approved root unless the user explicitly enables a separately defined broader supervision policy;

The approved-root layer should answer one question: is this external principal authorized to address this OpenFork location? It should then pass a canonical location to the shared capability owner. It should not become another filesystem implementation.

---

## 10. Permission convergence

Standalone LocalMCP exposes useful coarse external grants such as read/write/shell/git/integrations/filesReceive/filesSend. OXP keeps that comprehensibility but adds explicit **supervision** and **delegation** policy because the external ChatGPT agent can now operate on OpenFork's agent system itself.

Authority is not one linear Session-centric pipeline. It branches by OXP plane.

### Direct augmentation

    OXP connector grant
      INTERSECT approved root/location
      INTERSECT capability-specific hard invariants
      -> shared capability executor

No native Session permission is invented for a direct filesystem/Git/process capability.

### Existing-Session supervision

    OXP supervision grant
      INTERSECT approved target Session/root
      INTERSECT operation-specific supervision policy
      INTERSECT native Session/domain permission where applicable
      -> supervision operation

The external agent is the actor; the native Session is the target.

### New-worker delegation

    OXP delegation grant
      INTERSECT approved root
      INTERSECT user-authorized model/agent policy
      INTERSECT nested-delegation policy
      -> create/drive subordinate OpenFork Session

Once created, the worker is a real native OpenFork agent Session with its own native permissions and lifecycle. Its existence does not turn the supervising ChatGPT agent into an OpenFork Session.

Rules:

1. connector grant may narrow OpenFork authority, never widen it;
2. supervision and delegation are independent grants from direct augmentation capabilities;
3. a native Session-specific deny remains authoritative for operations against that Session;
4. connector authority never auto-answers a native Permission/Question request;
5. MCP schema visibility is never enforcement;
6. write and local-file egress remain separate grants;
7. external-directory escalation fails closed;
8. nested delegation requires explicit policy separate from initial worker creation;
9. catastrophic hard blocks remain hard blocks independent of convenience/YOLO modes.

---

## 11. Provenance across augmentation, supervision, and delegation

OXP should be an early consumer of generalized OpenFork provenance rather than another feature-specific metadata island.

Current LocalMCP/OpenCode Control uses metadata.localMcp for delegated model and nested-subagent policy. That policy is useful mutable state, but it must not become the canonical immutable origin of a turn.

Every admitted OXP operation carries truthful external-agent lineage:

- actor/origin = external OXP agent;
- connector principal;
- request/correlation identity;
- authorization lineage/grant revision;
- semantic plane = augmentation | supervision | delegation;
- approved root/workspace;
- explicit target Session/resource for supervision;
- exact user-authorized model/agent policy for delegation descendants where applicable.

Plane-specific law:

- **augmentation** produces capability effects attributable to the OXP principal, not a fake Session/tool turn;
- **supervision** records the OXP principal as actor and the native Session as target; it never impersonates the resident model;
- **delegation** creates a real subordinate OpenFork Session whose producer lineage points back through the OXP invocation/external agent.

Normal OpenFork provenance propagation then applies inside delegated workers for native task children, host continuations, compaction, recovery, Goal continuations, and scheduled work derived from the delegated domain object.

No downstream consumer should infer human ownership from provider role `user`, and no consumer should infer resident-agent authorship merely because an OXP supervisory action affected that Session.

---

## 12. External-agent supervision and delegation

OXP's defining higher-order feature is that the already-running ChatGPT agent can both **supervise existing OpenFork agents** and **delegate new work into OpenFork agents**.

ChatGPT remains the upper-level planner/user-facing agent. OpenFork owns the subordinate/local execution substrate: durable Sessions, model/provider binding, native tools, checkpoints, compaction, background lifetime, child agents, Permission/Question requests, and restart recovery.

### 12.1 Supervision of existing Sessions

Supervision is target-oriented, not ownership transfer. ChatGPT may inspect or control multiple authorized Sessions concurrently without becoming their resident agent or attaching itself as their backing client session.

Operations such as list/get/messages/children/pause/resume/abort/request reply must always preserve:

    actor = OXP external agent
    target = native OpenFork Session

Any Session-visible state created by supervision must retain truthful external provenance.

### 12.2 Delegation into subordinate Sessions

Delegation creates a real native OpenFork worker/subagent Session for work the external agent wants OpenFork to execute autonomously.

The returned worker handle is an explicit durable object. ChatGPT may wait/result/continue/cancel it independently of the MCP request that created it.

### Preserve strict model authority

ChatGPT may not silently choose a delegated worker model/agent policy the user has not authorized.

Move that rule into typed OpenFork delegation policy/provenance rather than a plugin-specific metadata convention.

### Provider account is part of model selection

Provider-account / credential identity is a first-class model-selection dimension whenever a provider exposes multiple selectable accounts. OXP must not repeat standalone LocalMCP's worker defect where the caller can name `providerId`, `modelId`, and `variant` but cannot name the provider account, forcing a downstream account router to perform provider roulette.

The external selection contract is conceptually:

    {
      providerId: "workbuddy",
      modelId: "deepseek-v4.1-flash",
      accountId: "wb-...",   // optional: omission means provider-defined automatic routing
      variant: "max"
    }

Rules:

- `accountId` belongs to model/provider selection. It is not prompt text, Session prompt metadata, connector authority, or an opaque plugin hint.
- The public OXP `modelId` is account-neutral. Do not require or accept callers to smuggle account identity through strings such as `deepseek-v4.1-flash@wb-...`.
- At the provider-adapter boundary only, OpenFork may lower `{ modelId, accountId }` into an existing provider-specific encoded model ID or request header when that is the provider's current internal ABI.
- A supplied `accountId` is exact user intent. If that account is missing, forbidden, exhausted, or otherwise unusable, fail closed with a provider-account error; never silently substitute another account.
- An omitted `accountId` explicitly means automatic provider routing is allowed. That mode must remain distinguishable from explicit-account selection in policy/provenance.
- Model/account catalogs should project account identity and availability as structured fields rather than making account-qualified model IDs the only discovery mechanism.
- Existing native Session selections that internally store account-qualified IDs must be projected back to `{ providerId, modelId, accountId, variant }` before crossing OXP.
- `set_default_model`, worker `start`/`continue`, Session `set_selection`, and worker-group defaults/overrides all reuse this one typed selection contract. Batch workers may inherit a group default selection or provide a per-worker override, but account identity may never disappear during that merge.
- Persist the user-authorized requested selection on the delegated worker/session domain. Where the provider reports the effective account, retain that effective account separately for audit/status; never rewrite requested explicit account authority after the fact.

### Nested delegation is separately authorized

Permission for ChatGPT to create Worker A does not automatically mean Worker A may recursively create arbitrary descendants. Nested delegation remains its own policy dimension and must propagate conservatively.

### Worker groups are not OpenSwarm

Current LocalMCP swarm_* operations are durable batches of independent workers coordinated by ChatGPT, not OpenSwarm peer coordination.

Do not conflate these domains. Prefer terms such as worker group, delegated batch, or batch workers, and reuse OpenFork SessionGroup/worker primitives rather than introducing a second scheduler or database.

---

## 13. External MCP integration

Standalone LocalMCP independently owns an MCP plugin manager. OpenFork already owns local and remote MCP clients, OAuth, tool definition caching, tool-list changes, resources/prompts, runtime status, and permission integration.

Therefore OpenFork's MCP subsystem should become the only external MCP runtime for the integrated product.

Desired flow:

    ChatGPT
      | stable OXP gateway
      v
    OxpCatalog
      |
      v
    OpenFork MCP.Service
      |- remote MCP A
      |- local MCP B
      `- remote MCP C

Do not republish hundreds of third-party schemas directly without evidence that this is worthwhile. Prefer progressive discovery and leaf execution.

The useful parts of standalone LocalMCP integration catalog/configuration UX can move into OpenFork settings, but lifecycle and execution should use packages/opencode/src/mcp/**.

---

## 14. File transfer and connector secrets

File transfer is genuinely LocalMCP-specific protocol functionality and remains a first-class migration workstream.

### Receive

Remote/ChatGPT/OpenAI -> approved local root.

Required:

- explicit receive grant;
- local write grant;
- bounded size;
- atomic publication;
- path containment;
- no invented ChatGPT source handles;
- correct retry/idempotency semantics.

### Send

Approved local file -> OpenAI Files API.

Required:

- explicit send/egress grant;
- local read grant;
- stable-open-file verification;
- symlink refusal;
- source identity verification before/after streaming;
- bounded size;
- inspect state before retrying ambiguous uploads.

### Secret ownership

Do not automatically reuse an arbitrary OpenAI model-provider key. The connector/API key is a distinct authorization surface unless the user explicitly elects to share credentials.

Desktop implementation should use OS-secure storage and fail closed when secure storage is unavailable, matching standalone LocalMCP's security behavior. OpenFork's ordinary auth.json/provider credential stores do not currently provide the same OS-secure-storage contract and should not be treated as equivalent by convenience.

Headless support may retain explicit environment/file secret sources with strict path/mode/size rules, but must never silently downgrade to plaintext persisted connector config.

---

## 15. Desktop product surface

True standalone replacement needs more than a backend endpoint. Create a V2/new-layout OpenFork settings area for OXP.

### Overview

- connector state and connect/disconnect;
- last proven tunnel handshake;
- last MCP request and tool call;
- approved-root count;
- published capability count;
- integration count;
- bounded call/failure/latency metrics.

### Approved folders

- add/remove root;
- model-facing alias;
- native path shown only in local UI;
- reveal in file manager.

### Augmentation capabilities

- read/search;
- write/edit;
- receive files;
- send files;
- git;
- shell/process;
- external MCP integrations;
- browser/computer access only when separately enabled.

### Agent support

- existing-Session supervision policy;
- Permission/Question request supervision policy;
- worker/subagent delegation policy;
- nested-delegation policy.

### Integrations

- OpenFork-configured MCP servers;
- authentication/status;
- per-server/per-tool exposure policy where useful.

### Connection

- OpenAI Secure MCP Tunnel;
- tunnel ID;
- protected credential status;
- auto-connect;
- OXP v1 uses OpenAI Secure MCP Tunnel only; manual/cloudflared transport is not part of the first-party product surface.

### Activity

- bounded redacted logs;
- request/tool metrics;
- copy/export diagnostics.

Do not port standalone LocalMCP's no-framework renderer. Use OpenFork's primary V2 UI and browser-safe contracts.

---

## 16. Always-on lifecycle is a replacement blocker

Current OpenFork desktop quits on window-all-closed on Windows/Linux and no first-party Tray or login-item implementation equivalent to standalone LocalMCP was found.

Standalone replacement therefore requires an explicit desktop lifecycle tranche:

- launch at login;
- optional start hidden;
- close-to-tray;
- tray status/actions;
- connector continues while no OpenFork window is visible;
- sidecar/tunnel lifetime follows the background desktop host;
- explicit Quit convergently tears down connector and sidecar resources.

These behaviors must be opt-in/default-safe. Enabling OXP must not silently change close behavior without clear product UI.

---

## 17. Observability

Preserve the standalone principle: metrics count what the MCP dispatch boundary actually saw, but classify each admitted operation by OXP semantic plane.

Required bounded metrics:

- endpoint requests/rejections;
- total admitted operations/failures;
- augmentation operations by capability;
- supervision operations by action/target class;
- delegation operations by action/worker-vs-group;
- unknown/stale tool or operation calls;
- duration and slowest operation by plane;
- active/durable OXP-owned process jobs;
- supervised/delegated object counts only as bounded summaries, never full background hydration;
- tunnel reconnect/outage state;
- connector config epoch/tool fingerprint.

Add OpenFork-side trace correlation:

    connector request id
      -> OXP invocation id + plane
      -> augmentation capability id
         OR supervision target Session/request id
         OR delegated worker/group id
      -> native message/request/worker ids when actually created

This makes it possible to answer whether ChatGPT directly used a capability, supervised an existing agent, or delegated to a new one without reconstructing intent from logs/history.

Never log API keys, signed ChatGPT download URLs, external MCP secrets, plaintext secure-store contents, or unbounded Session transcript data.

---

## 18. Performance requirements

Unification should delete duplicate work, not merely relocate it.

### Negative invariants when disabled

- zero connector processes;
- zero connector listeners;
- zero workspace instances caused by OXP;
- zero provider/model enumeration;
- zero external MCP connections caused by OXP;
- zero periodic connector UI polling.

### Negative invariants when enabled but idle

- exactly one intended tunnel-client tree;
- bounded connector health/retry timers;
- zero workspace instances solely for health/status;
- no global session-history hydration;
- no per-project/per-session polling loops.

### Catalog invariants

- provider/model/session changes do not alter fixed top-level fingerprint;
- external MCP reconnects do not force top-level schema churn;
- long-tail discovery is lazy.

### Execution convergence invariants

- one authoritative TypeScript/toolchain path;
- one process/job ownership system;
- one Git policy;
- one project/symbol implementation;
- one snapshot/checkpoint mutation boundary.

### Benchmarks

Measure at minimum:

1. disabled startup delta;
2. enabled-idle startup delta;
3. first tools/list;
4. cached tools/list;
5. read/find adapter overhead;
6. mutation adapter overhead excluding actual filesystem write;
7. shell start to first output;
8. worker start;
9. worker wait wake-up latency;
10. 1 / 3 / 6 concurrent externally delegated worker turns;
11. connector reconnect during idle;
12. sidecar restart while the desktop/tunnel host remains alive.

Record wall time, CPU, RSS, listener/timer count, spawned processes, workspace-instance count, event-stream count, and model-facing schema bytes.

---

## 19. Migration from standalone LocalMCP

### Stage A - coexistence

Standalone LocalMCP remains available while OpenFork OXP is experimental. Do not automatically mutate standalone configuration.

### Stage B - parity importer

Offer one-way import of non-secret configuration where safe: connector label, approved roots, capability toggles, tunnel kind/ID if treated as non-secret configuration, preferences, and external MCP declarations that map cleanly to OpenFork MCP configuration.

Do not assume standalone secrets.bin is portable merely because both applications use Electron. Prefer re-authentication/re-entry unless a separately reviewed migration can prove secure decryption without unintended plaintext exposure.

### Stage C - connector cutover

User enables OpenFork OXP and verifies ChatGPT connectivity. Only then offer to disable standalone launch-at-login/connector startup.

Never race two connector implementations against the same tunnel without an explicit coexistence design.

### Stage D - standalone maintenance mode

After parity and reliability proof, new capability work lands in OpenFork first and standalone receives critical compatibility/security fixes only.

### Stage E - standalone retirement

Retire only after packaged Windows proof, tunnel reliability parity, approved-root/security parity, file-transfer parity, integration parity, always-on lifecycle parity, measured performance advantage, and real ChatGPT usage soak.

---

## 20. Implementation tranches

These tranches intentionally prove OXP in the same order as its semantic model: establish the external principal/authority boundary, prove augmentation, then add supervision, then delegation.

### Tranche 0 - architecture proof and capability inventory

Deliver this ledger, a complete capability ownership matrix, exact owner for every LocalMCP operation, schema/fingerprint strategy, and provenance review. No production behavior change.

### Tranche 1 - external principal + authority + root model

Build OxpConfig, OxpAuthority, OxpPlane classification, approved-root alias/canonicalization contracts, and redacted settings projection. No tunnel yet.

Required tests: symlink/junction escape, root removal, ambiguous relative path, no implicit cwd, augmentation/supervision/delegation grant separation, zero Instance creation for config/root listing.

### Tranche 2 - read-only augmentation vertical slice

    already-running ChatGPT agent
      -> Secure MCP Tunnel
      -> OXP augmentation
      -> read/find/project
      -> bounded result

This proves the crucial no-backing-Session path: the external agent can use OpenFork-backed local capabilities without being instantiated as an OpenFork agent.

### Tranche 3 - mutation/process augmentation convergence

Add edit/patch, git, process/background jobs, archive/JSON, test/typecheck/symbols as OXP-safe shared capabilities. Do not port duplicate implementations when an OpenFork owner exists.

### Tranche 4 - existing-Session supervision

Replace the supervision half of standalone OpenCode Control with direct `openfork_info`, `openfork_session`, and `openfork_request` projections.

Prove external-actor -> target-Session provenance, approved-root/target filtering, no resident-agent impersonation, and native Permission/Question preservation.

### Tranche 5 - worker/subagent delegation

Replace the worker half of standalone OpenCode Control with direct `openfork_worker` delegation.

Prove worker creation, explicit durable handles, wait/result/continue/cancel, user-authorized model/agent policy, nested-delegation policy, worker groups, recovery, and external-agent -> delegated-worker lineage.

Delete the first-party need for LocalMCP-to-OpenFork service discovery, pairing, and cross-product realm routing. Preserve those mechanisms only where genuinely external clients still need them.

### Tranche 6 - provenance closeout across all OXP planes

Audit augmentation, supervision, and delegation producers/consumers against generalized OpenFork provenance. Retire feature-specific mutable-origin inference.

### Tranche 7 - external MCP broker

Project OpenFork's existing MCP catalog through the OXP augmentation broker. Port useful standalone catalog/config UX, not the standalone MCP runtime.

### Tranche 8 - file exchange + secure secrets

Port receive/send with explicit ingress/egress authority and OS-secure credential handling.

### Tranche 9 - desktop replacement UX/lifecycle

Add settings, activity, tray, launch at login, start hidden, close to tray, and a migration importer.

### Tranche 10 - parity/performance/security closeout

Run packaged Windows tests, augmentation/supervision/delegation concurrency, network outage/recovery, sidecar restart, tool-schema cache stability, stale-read/mutation races, root/symlink/junction adversarial tests, file-egress tests, external MCP auth/reconnect, and long-running ChatGPT soak.

Only then declare standalone replacement.

---

## 21. Security/adversarial test matrix

### Filesystem

- traversal cannot escape;
- symlink/junction cannot escape;
- path swap between authorization and open is handled safely;
- approved root deletion/replacement cannot silently retarget authority;
- stale known read blocks unsafe mutation;
- patch rollback never overwrites a newer external edit.

### Process

- shell workdir must resolve inside authorized location;
- PID alone never grants ownership after restart;
- connector teardown kills only owned process trees;
- background job IDs cannot access an unauthorized job.

### Git

- typed reads remain read-only;
- broad stage/restore/commit requires the expected confirmation;
- hostile inherited Windows Git EOL config cannot override OpenFork policy.

### Connector/tunnel

- secret local endpoint path uses constant-time comparison where applicable;
- request bodies are bounded;
- loopback Host/Origin validation remains correct;
- invalid tunnel credentials do not cause infinite retry;
- transient outage does not restart a healthy client unnecessarily;
- one missed readiness probe cannot kill an in-flight connector.

### OXP plane authority

- cached schema cannot bypass a newly disabled grant;
- direct augmentation does not acquire implicit Session authority;
- supervised Sessions outside approved roots/policy are invisible/refused;
- a target Session ID never becomes caller identity;
- supervision cannot impersonate the resident agent;
- delegation disabled means no subordinate Session creation;
- nested delegation cannot widen `nestedDelegation=false`;
- external-directory permission cannot widen roots;
- connector policy can narrow but never widen native Session permissions;
- arbitrary external MCP tools remain conservative snapshot mutators unless stronger semantics are known.

### Secrets

- no plaintext connector secret crosses renderer/browser-safe APIs;
- no secret appears in config/log output;
- insecure Linux secure-storage fallback is rejected;
- failed decrypt/mutation cannot overwrite unreadable existing secret state.

### File transfer

- receive and send remain independent grants;
- upload verifies stable file identity;
- signed ChatGPT sources never receive a local OpenAI API key;
- ambiguous external mutation/upload is inspected before blind retry.

---

## 22. Design-resolution ledger

This section tracks questions that were open early in the audit and records the later source-grounded resolution so discarded alternatives are not accidentally revived.

| Question | v1 resolution | Evidence / remaining work |
| --- | --- | --- |
| ACP vs OXP operating model | **Resolved:** ACP initiates/drives OpenFork agents; OXP supports already-running external agents through augmentation, supervision, and delegation. | Sections 1-3. No mandatory OXP backing Session. |
| MCP endpoint process | **Resolved:** dedicated loopback MCP listener inside the existing OpenFork sidecar process. | Section 31. Existing sidecar already owns runtime services and privileged Electron parentPort IPC. |
| Secret bridge | **Resolved for v1:** Electron main owns OS-secure credentials; tunnel uses them locally; file exchange may request a purpose-specific credential over privileged sidecar IPC only for the operation lifetime. | Sections 31.15-31.16. |
| Headless support | **Resolved for v1:** desktop first; independent headless/CLI host is a follow-up. | Avoids duplicating desktop lifecycle and connector lease logic before a real headless use case exists. |
| Transport scope | **Resolved:** OpenAI Secure MCP Tunnel only in OXP v1. | Section 31.1. cloudflared/manual are not first-party OXP product transports. |
| Direct hot-tool set | **Provisional:** 14-tool Surface Manifest v0. | Section 30. Freeze only after call-frequency/model-trace measurements. |
| Long-tail gateway | **Resolved:** stable `capability { list | describe | call }` broker. | Section 30.5; converges conceptually with OpenFork's existing lazy tool broker without exposing arbitrary Tool.Def directly. |
| Root persistence | **Resolved:** dedicated fork-owned `Global.Path.config/oxp.json` for sidecar authority config. | Sections 28.8 and 31.7. Electron-native lifecycle/tunnel settings stay with desktop owner. |
| Connector identity | **Resolved:** stable machine/profile-local random connector ID + mutable human label. | Section 28.1. Label is never authority. |
| Multi-process connector lease | **Resolved for desktop v1:** no extra lease. | Electron already holds `app.requestSingleInstanceLock()`; section 31.6. Revisit only for independent headless hosts. |
| Sidecar restart behavior | **Resolved:** stop tunnel, generate fresh OXP endpoint generation/token, reconnect. | Section 31.11. |
| OpenAI Files credential | **Resolved for v1:** dedicated OXP connector/file-exchange secret; never silently reuse an arbitrary provider key. | Sections 14 and 31.16. Explicit future opt-in reuse could be separately designed. |
| Standalone config importer | **Still open in detail:** one-way non-secret import only. | Exact field compatibility and UX need implementation-time audit; secrets require re-entry unless a separately reviewed migration proves safe. |
| External MCP resources/prompts | **Still open:** start with tool brokering; resource/prompt projection needs usage-driven schema decision. | Section 30.7. |
| Browser/computer-use exposure | **Resolved for v1:** unavailable/off by default. | Requires explicit OXP browser grant + separate threat model before exposure. |
| Goal/scheduled-task exposure | **Deferred:** brokered only after provenance/authority semantics are complete and reviewed. | Do not add direct top-level tools in v1. |

---

## 23. Decisions already made by this ledger

Unless later evidence disproves them:

1. OXP is a first-party OpenFork product surface, not an ordinary external MCP plugin.
2. OXP is a sibling of ACP in adapter architecture, but their operating orientation differs: **ACP initiates/drives OpenFork agents; OXP supports already-running external agents**.
3. The ChatGPT-side agent remains the external upper-level agent. OXP never requires a backing OpenFork Session merely to represent that agent.
4. OXP has three first-class semantic planes: **augmentation, supervision, delegation**. They must remain distinct in authority, provenance, lifecycle, and tests.
5. OpenFork is the authoritative support substrate: owner of local capabilities and native OpenFork Session/agent state.
6. OXP supervision must never impersonate the resident agent of a target Session.
7. OXP delegation creates real subordinate OpenFork Sessions with explicit causal lineage back to the external OXP principal.
8. Standalone LocalMCP is the behavioral/security oracle during migration.
9. Duplicate coding/process/project/toolchain implementations should be deleted from the target architecture, not copied.
10. Approved roots remain a distinct external authority boundary.
11. Dynamic runtime state must not churn the fixed top-level MCP schema.
12. OpenFork's existing MCP subsystem becomes the external-MCP runtime.
13. Standalone OpenCode Control becomes unnecessary in the first-party path; its semantics split into native OXP discovery, supervision, and delegation projections.
14. Provenance uses generalized OpenFork semantics and preserves `external OXP actor -> target Session` or `external OXP actor -> delegated worker` lineage rather than permanent metadata.localMcp origin inference.
15. True standalone replacement requires tray/autostart/background lifecycle parity.
16. Replacement is incomplete until file transfer, secure secrets, and packaged tunnel reliability are proven.

---

## 24. Early next-step checkpoint — completed

The original immediate task was to build a source-level LocalMCP -> OpenFork capability ownership matrix before copying any standalone tool implementations.

That work is complete in section 25. Its main conclusion remains load-bearing:

> Do not copy `localMCP-chat/src/clean/main/tools/*` wholesale into OpenFork, and do not make `Tool.Def.execute()` the OXP runtime API.

The audit then completed the OXP Authority Contract (section 28), Capability Context (29), Surface Manifest (30), Process Boundary (31), desktop IPC/settings contract (32), security/recovery oracle (33), gated roadmap (34), and quantitative acceptance plan (35).

The current next move is therefore implementation Gate A from section 34, followed by the read-only Gate B/C augmentation vertical slice. Mutation/process work and all native Session supervision/delegation must remain behind those gates.

---

## 25. Source-level capability ownership matrix — tranche 0 findings

This section records the first source-level pass. It is deliberately stricter than the coarse disposition matrix above: an existing agent tool is not automatically a reusable OXP capability merely because its behavior is close.

### 25.1 Reuse categories

- **Direct domain reuse**: an existing service is already protocol-neutral enough for OXP.
- **Extract shared executor**: OpenFork owns the implementation, but the current Tool.Def adapter bakes in agent/session context and should be split.
- **Project existing service**: no new execution logic; OXP needs only authority/result projection.
- **Semantic convergence required**: standalone LocalMCP currently has a property the OpenFork implementation does not preserve under the same external grant.

| Capability | Current standalone oracle | OpenFork candidate owner | Classification | Important gap / rule |
| --- | --- | --- | --- | --- |
| read | localMCP tools/read.ts + sandbox/common read cache | tool/read.ts over FSUtil, Ripgrep, LSP, outline cache, edit/prior-read | Extract shared executor | OpenFork read is session-oriented: prior-read grounding is keyed by sessionID and permissions use Tool.Context. OXP needs invocation/principal grounding without inventing a fake chat session. Preserve 50 KiB bounded windows, batching, binary refusal, and deterministic multi-root addressing. |
| find | localMCP tools/read.ts/find path + sandbox | tool/find.ts -> GlobTool/GrepTool -> FSUtil/Ripgrep | Extract/shared search service | OpenFork find defaults path to current working directory; OXP must never gain an implicit cwd. OXP location must be explicit or uniquely derived from one approved root. |
| edit | localMCP tools/edit.ts + readCache + sandbox | tool/edit.ts + edit/plan.ts + edit/strategy.ts + edit/commit.ts + edit/prior-read.ts | Extract shared mutation executor | Excellent OpenFork mutation machinery already exists: locks, re-read/revalidation, atomic temp+rename, format/LSP/event resync. commitPlan still requires Tool.Context/session grounding. Generalize authorization/progress/read-grounding instead of fabricating Session IDs. |
| patch | localMCP tools/patch.ts + rollback preimages | tool/patch.ts + patch/core.ts + patch/resolve.ts + patch/rollback.ts | Extract shared mutation executor | OpenFork is the preferred implementation, but runPatchEffect is Tool.Context/InstanceState-facing. Preserve all-hunks-preflight, file locks, conditional rollback, EOL/BOM behavior, and prior-read enforcement. |
| foreground shell | localMCP tools/exec.ts | core AppProcess + tool/shell/launch.ts + tool/shell.ts | Extract shared execution service | ShellLaunch is already an excellent protocol-neutral command planning boundary. Full ShellTool adds session permissions, snapshot and plugin behavior. OXP should reuse ShellLaunch/AppProcess through an external execution service with explicit approved cwd and OXP ownership. |
| background shell/jobs | localMCP tools/background.ts manager | core BackgroundJob + background/shell-job.ts + background/shell-jobs.ts | Generalize owner then direct reuse | Current ShellJob launch contract requires SessionID and delivery is session-oriented. Introduce typed job ownership such as session vs oxp invocation/connector. Never fake a session solely to own an OXP process. Monitor-to-session wake semantics should remain session-specific. |
| git | localMCP tools/git.ts | tool/git.ts over AppProcess + core GitRuntime | Extract shared typed Git executor | The safe argv/env/read-only shell allowlist is already OpenFork-owned. Separate typed operation execution from Tool.Context prompts so OXP can compose connector grant + root authority + confirmation semantics. |
| project | localMCP tools/project.ts | tool/project.ts | Extract Project inspection service | OpenFork implementation is richer but mostly embedded in the tool adapter. OXP needs metadata-first repository orientation without arbitrary source hydration or implicit workspace creation. |
| symbols | localMCP tools/symbols.ts TypeScript AST + bounded LRU | tool/symbols.ts + symbols/{outline,search,usages}.ts + Ripgrep | Extract Symbols service | Both are mature but not identical implementations. OpenFork should be authoritative after parity testing. OXP must retain approved-root scoping and honest unattributed-reference reporting. Avoid global duplicate AST/index caches. |
| test list | localMCP tools/test.ts, available under read grant | tool/test.ts + TestScope | Extract read-only discovery service | Preserve shell-free discovery. This can remain an OXP read capability if listing performs no process execution. |
| test run | localMCP tools/test.ts, gated by shell | tool/test.ts + TestScope + AppProcess/heavy-process slot | Extract execution service | Map to OXP process/shell authority, not merely read authority. Preserve process-tree timeout/kill behavior and bounded parsed results. |
| typecheck | localMCP tools/typecheck.ts in-process TS compiler with approved-root-filtered compiler host; exposed under read grant | tool/typecheck.ts + typecheck-scope.ts using repo tsgo/tsc and temp tsconfig | **Semantic convergence required** | This is a major mismatch. Standalone typecheck is no-emit, no source writes, and filters compiler filesystem access to approved roots. OpenFork scoped typecheck writes a temporary .opencode-typecheck-* file inside the project and spawns the repo compiler. OXP MUST NOT expose that behavior as a read-only capability. Either preserve the standalone safe compiler-host path for external read-only typecheck, or redesign TypecheckScope so it proves equivalent non-mutating containment. |
| archive | localMCP tools/archive.ts | tool/archive.ts + archive/* + heavy-process slot | Extract/shared service | OpenFork already carries the mature implementation. OXP list/read can be read grant; extract/create require write. System-backed formats may additionally require external-process policy if they can escape filesystem mediation. |
| JSON | localMCP tools/json.ts + json/core.ts | tool/json.ts + json/core.ts | Extract/shared service | Core algorithms already align closely. OXP validate/scaffold/query/search/schema/diff/stats are read; format/patch dry-run is read; commit requires write and stale-content protection. |
| skill | localMCP tools/skill.ts over approved roots | OpenFork Skill service/tool | Project existing service with narrowed catalog | OXP must not expose every OpenFork/global skill automatically; root/grant visibility is narrower than native agent visibility. |
| external MCP | localMCP plugin manager + integration list/inspect/call | MCP.Service + mcp/catalog.ts + existing lazy tool broker | Direct domain reuse + OXP projection | Do not port the standalone MCP child/plugin runtime. Reuse OpenFork clients/OAuth/resources/prompts and publish them through a stable progressive OXP gateway. |
| lazy capability broker | localMCP integration tool | tool/access.ts + SessionTools.catalog concepts | Extract protocol-neutral catalog/broker | OpenFork already has the exact stable list/describe/call pattern. Current implementation calls Tool.Def with Tool.Context; OXP needs a broker over OXP-safe capability definitions, not arbitrary agent tools by default. |
| Session info/history | OpenCode Control backend HTTP/SSE | Session.Service + durable database/read projections | **Supervision projection** | Eliminate same-machine discovery/pairing/HTTP hop. Filter every target Session through OXP supervision grant + approved-root authority. Reading it does not make ChatGPT that Session's resident agent. |
| Session send/turn/pause/resume/abort | OpenCode Control opencode_session | SessionPrompt.Service + SessionRunState/SessionStatus + Session.Service | **Supervision projection with external provenance admission** | OXP-issued Session actions need actor=external OXP principal + target=native Session provenance. Do not inject them as ordinary human turns or resident-model tool emissions. |
| Worker/group start/wait/continue/cancel | OpenCode Control opencode_worker + plugin ownership groups | SessionPrompt dispatch + SessionGroup + BackgroundJob + Session metadata/provenance | **Delegation projection** after policy convergence | Creates/drives subordinate OpenFork Sessions. Preserve durable recovery, user-authorized model/agent selection, nested-delegation policy, and causal lineage. Rename LocalMCP swarm semantics to worker groups/batches; do not conflate with OpenSwarm. |
| Permission/Question mediation | OpenCode Control opencode_request | Permission.Service + Question.Service | **Supervision projection** | OXP only exposes requests belonging to authorized target Sessions. Replying is an external supervisory action and must never be attributed to the resident agent. |

### 25.2 Consequence: do not make ToolRegistry the OXP runtime API

ToolRegistry is valuable as a capability inventory and schema donor, but Tool.Def.execute is explicitly agent/session-facing. Tool.Context requires sessionID, messageID, agent, messages, metadata updates, and Permission.ask. SessionTools.resolve also adds plugin hooks, tool-call persistence, interrupt tracking, snapshots, and model-specific schema transforms.

Therefore the preferred layering is:

    domain/shared executor
       |- native OpenFork Tool.Def adapter
       |- OXP adapter
       |- future HTTP/ACP projection where appropriate

not:

    OXP -> fabricate Session/Message IDs -> Tool.Def.execute()

A temporary adapter may be acceptable for a prototype only when the invoked tool semantically requires a real OpenFork session. It must not become the foundation for workspace capabilities such as read, git, or project inspection.

### 25.3 Candidate shared execution context

Several existing tools need the same non-model-specific capabilities: cancellation, authorization, progress, provenance/owner identity, explicit workspace, and read-grounding. Before extracting every tool independently, evaluate a narrow shared contract conceptually like:

    CapabilityContext {
      principal
      workspace
      invocationID
      abort
      authorize(request)
      progress(update)
      provenance
      readGrounding
    }

Native agent tools can adapt Session/Tool.Context into this contract. OXP can adapt OxpInvocation + OxpAuthority into it. The contract must remain smaller than Tool.Context and must not import model/provider/message-history semantics unless a capability actually needs them.

### 25.4 Typecheck is the first explicit parity gate

Typecheck demonstrates why source-level parity matters more than matching tool names. Standalone LocalMCP intentionally provides a read-authorized, in-process TypeScript compiler host whose filesystem reads are constrained to approved roots plus the packaged TypeScript standard library. OpenFork's current typecheck optimizes for repository fidelity by invoking the repository compiler through a temporary tsconfig written beside the project config.

For native OpenFork agents that tradeoff may be correct. For OXP's external read grant, it is not equivalent.

Before OXP exposes typecheck under read authority, choose and prove one of:

1. retain/extract the standalone approved-root compiler-host implementation as the OXP read-only typecheck executor;
2. redesign OpenFork TypecheckScope so scoped execution requires no workspace write and cannot follow compiler/config resolution outside the authorized root;
3. expose repo-compiler typecheck only under OXP process/shell authority and separately offer a safe read-only diagnostic mode.

Do not silently broaden the read grant to process execution or transient writes just to reuse the existing agent tool.

---

## 26. OXP protocol profile over current MCP

OXP is not a replacement wire protocol for ChatGPT. ChatGPT's external contract remains MCP over OpenAI Secure MCP Tunnel. OXP is the OpenFork-defined semantic/profile layer that specifies how that MCP surface maps into OpenFork.

### 26.1 Current external standards baseline

As of 2026-09-18:

- OpenAI documents Secure MCP Tunnel as the supported path for connecting ChatGPT and other supported OpenAI products to MCP servers on a developer machine/private network without exposing the local server directly to the public internet.
- ChatGPT custom-app discovery is explicitly refreshed/scanned; server action changes are not something OXP should assume become live inside existing model context automatically. This reinforces a deliberately stable top-level schema.
- MCP revision 2026-07-28 removed protocol-level initialize/initialized sessions and the Mcp-Session-Id transport session. Request identity/capabilities are carried per request and application state should use explicit model-visible handles when state must span calls.
- The same MCP revision adds stateless multi-round-trip input requests and moves tasks to an extension. OXP should prefer the simplest ChatGPT-supported subset and must not require an optional MCP feature for its core workstation capability path.

External references used for this baseline:

- OpenAI Help Center: Developer mode and MCP apps in ChatGPT.
- Model Context Protocol: 2026-07-28 specification release.

### 26.2 Architectural consequence: stateless wire, explicit durable OpenFork handles

OXP must not recreate a hidden protocol/backing agent Session merely because OpenFork itself has durable Sessions/workers. The stateless MCP request belongs to the already-running external agent; native OpenFork Session handles appear only for explicit supervision/delegation.

Examples:

    tools/call read(...)
      -> independent OXP invocation

    openfork_worker.start(...)
      -> returns explicit durable worker/session handle

    openfork_worker.wait({ handle })
      -> explicitly addresses that durable OpenFork object

    shell(background:true)
      -> returns explicit OXP-authorized job handle

Transport connection identity, ChatGPT conversation identity, OpenFork Session identity, and OXP durable object handles are separate concepts.

### 26.3 OXP semantic planes and supporting layers

OXP has exactly three **actor-operation planes**. These are the valid `OxpInvocation.plane` values:

1. **Augmentation** — the already-running external agent directly uses an OXP-safe capability.
2. **Supervision** — the external agent observes/controls an authorized existing native OpenFork Session/request as an explicit target.
3. **Delegation** — the external agent creates/drives a subordinate native OpenFork worker/subagent Session or group.

Everything else is a supporting protocol/runtime layer, not a fourth actor plane:

- **Transport** — Streamable HTTP MCP endpoint behavior and OpenAI tunnel compatibility.
- **Connector Identity** — stable local connector identity, endpoint secret, config revision, tunnel lifecycle.
- **Authority** — approved roots plus augmentation, supervision, delegation, integration, and egress policy.
- **Workspace Addressing** — virtual approved-root aliases and explicit OpenFork location resolution; no implicit cwd.
- **Exchange Services** — ChatGPT/OpenAI file ingress/egress and external MCP resource/tool brokering.
- **Provenance** — external-agent origin, connector/grant lineage, request correlation, target Session when applicable, and delegated-worker lineage/model authority.
- **Observability** — bounded per-plane metrics, tracing, schema fingerprint, version/capability reporting.

`file_transfer`, `capability`, external MCP brokering, and `openfork_info` are classified as **augmentation** unless an operation explicitly crosses into a target Session/worker domain. Supporting exchange/discovery machinery must not create an implicit fourth plane.

### 26.4 Protocol identity/versioning

Do not overload the MCP protocol version with OXP versioning.

OXP needs an independent semantic version/capability identity, for example:

    oxp:
      version: 1
      implementation: openfork
      implementationVersion: <OpenFork version>
      schemaFingerprint: <sha256>
      features:
        approvedRoots: 1
        fileExchange: 1
        sessionSupervision: 1
        workerDelegation: 1
        capabilityBroker: 1

Where possible this should live in non-model-facing MCP metadata/server discovery. A compact oxp_info/status operation may expose the same information when ChatGPT needs it explicitly. Do not consume permanent tool-schema bytes just to repeat static implementation metadata in every tool.

### 26.5 Explicit-handle rule

Any OXP object that must survive across MCP calls receives a typed opaque handle.

Candidate handle domains:

- approved workspace/root alias: stable user-facing alias, not a secret;
- foreground interactive process session: short-lived opaque handle;
- background process/job: durable OXP-owned job handle;
- supervised OpenFork Session: native SessionID only after supervision authority filtering;
- delegated worker: native/durable OpenFork Session or worker-group identity created under delegation authority;
- file-transfer operation when asynchronous/idempotent recovery requires one.

Never use a ChatGPT conversation ID, transport socket, MCP request ID, PID, or display label as durable authority.

### 26.6 Error taxonomy

OXP should have stable structured error classes in addition to human-readable text. Initial families:

- OXP_INVALID_ARGUMENT
- OXP_AUTH_DENIED
- OXP_AUTH_REVOKED
- OXP_ROOT_REQUIRED
- OXP_ROOT_NOT_FOUND
- OXP_ROOT_CHANGED
- OXP_PATH_ESCAPE
- OXP_STALE_READ
- OXP_CONFLICT
- OXP_NOT_FOUND
- OXP_HANDLE_STALE
- OXP_BUSY
- OXP_TIMEOUT
- OXP_CANCELLED
- OXP_DEPENDENCY_UNAVAILABLE
- OXP_INTEGRATION_OFFLINE
- OXP_AMBIGUOUS_EXTERNAL_RESULT

Do not force ChatGPT to parse prose to distinguish retryable state, stale authority, and ordinary user input errors.

### 26.7 Dependency boundary

Standalone localMCP-chat already uses the Model Context Protocol v2 server/client/node packages. OpenFork currently uses @modelcontextprotocol/sdk 1.29.0 for its outbound MCP client subsystem.

Do not upgrade or rewrite OpenFork's outbound MCP client merely because OXP needs a current MCP server implementation. Treat them as separate adapters and dependency surfaces until a compatibility audit proves convergence is safe.

Preferred first implementation: port/adapt the proven LocalMCP v2 endpoint behavior into the OXP ingress package while it dispatches into OpenFork-owned OXP services.

That preserves current tunnel compatibility without making the standalone tool implementations authoritative.

---

## 27. Package placement and module boundaries

This section supersedes the earlier generic package-placement uncertainty.

### 27.1 Do not place OXP runtime in packages/protocol

OpenFork's map explicitly defines packages/protocol and packages/client as upstream-current donor/transitional surfaces rather than the OpenFork product compatibility destination. Moving a new fork-owned product protocol into that package would invert the repository's documented ownership direction.

Therefore OXP should not be implemented as another ServerApi group merely because its name contains the word protocol.

### 27.2 Recommended source layout

Authoritative runtime and semantic adapter:

    packages/opencode/src/oxp/
      config.ts
      authority.ts
      root.ts
      invocation.ts
      catalog.ts
      capability.ts
      supervision.ts
      delegation.ts
      provenance.ts
      result.ts
      error.ts
      server.ts
      file-exchange.ts
      metrics.ts

Names are conceptual and should be collapsed where evidence shows fewer owners are sufficient.

Desktop-native host:

    packages/desktop/src/main/oxp/
      credentials.ts
      tunnel.ts
      lifecycle.ts
      bridge.ts

Responsibilities here are restricted to OS/native concerns: safeStorage, tunnel-client child supervision, launch-at-login/tray/close-to-tray integration, folder picking, and a narrow local bridge to the sidecar.

Browser-safe shared contracts only when needed:

    packages/schema/src/oxp.ts

Potential contents:

- connector status enum;
- redacted settings DTO;
- approved-root public projection;
- bounded metrics DTO;
- OXP feature/version descriptor;
- UI event payloads.

Do not move filesystem, process, MCP server, tunnel, credential, or authority implementations into Schema.

UI:

    packages/app/src/components/settings-v2/...

The exact component decomposition should follow the current V2 settings conventions rather than creating an OXP-specific UI framework.

### 27.3 OXP server library dependency

Standalone LocalMCP already uses the split Model Context Protocol v2 packages:

- @modelcontextprotocol/server
- @modelcontextprotocol/node
- @modelcontextprotocol/client

OpenFork's outbound MCP client currently uses @modelcontextprotocol/sdk 1.29.0.

OXP ingress should initially treat these as independent dependency domains. Port the proven v2 server/node endpoint boundary into the OXP side without forcing an unrelated outbound-MCP migration.

Only converge the MCP dependencies after a separate compatibility/performance audit proves that doing so preserves OpenFork's existing outbound clients/OAuth/resources behavior.

### 27.4 Recommended runtime boundary

Within the sidecar, OXP should have direct Effect/service access to fork-owned domain owners. The desktop main process should not proxy arbitrary OpenFork routes or tools.

Conceptually:

    already-running ChatGPT agent
      | MCP via Secure MCP Tunnel
      v
    OXP MCP endpoint
      |
      v
    OXP Invocation / Authority
      |
      +--> AUGMENTATION -> shared capability executors / MCP.Service / process services
      +--> SUPERVISION  -> Session.Service / SessionPrompt / Permission / Question
      +--> DELEGATION   -> Session creation/worker/group services
      `--> shared provenance / checkpoint / snapshot owners

Electron main participates only where an OS-native action is required.

### 27.5 Planning checkpoint — completed

The source-level ownership matrix replaced section 24's original 'build the matrix' step, and the four concrete contracts identified here have now been specified in sections 28-31. They remain the required implementation contracts:

1. **OXP Authority Contract**
   - root/grant data model;
   - canonical path/address resolution;
   - capability-to-grant mapping;
   - live revocation semantics;
   - composition with direct augmentation authority, target-Session supervision policy, and delegated-worker policy.

2. **OXP Capability Context**
   - principal/connector identity;
   - explicit workspace;
   - invocation ID;
   - cancellation;
   - authorization callback;
   - progress callback;
   - provenance;
   - read-grounding;
   - no model/message-history fields.

3. **OXP Surface Manifest v0**
   - exact direct hot tools;
   - long-tail broker schema;
   - OpenFork discovery, supervision, and delegation tools;
   - structured result/error envelope;
   - tool-surface fingerprint/version rules;
   - feature exposure under each grant combination.

4. **OXP Process Boundary Contract**
   - endpoint ownership;
   - tunnel supervisor ownership;
   - secret retrieval protocol;
   - sidecar restart/rebind semantics;
   - singleton Electron-main connector ownership for desktop v1; revisit lease/election only for future independent headless hosts;
   - shutdown and crash recovery.

Those contracts are now defined below. Implementation begins with the read-only **augmentation** vertical slice; native Session supervision and worker delegation remain later gated tranches.

---

## 28. OXP Authority Contract v0

### 28.1 Principal

Initial product scope should have exactly one active OXP connector principal per durable OpenFork profile.

Conceptual identity:

    OxpPrincipal {
      connectorID: stable random UUID
      label: user-editable display name
      profileRealm: local OpenFork durable profile identity
    }

The display label is never authority. Renaming a connector does not change its principal.

A future multi-connector design can add principals without changing the capability model.

### 28.2 Approved root identity

Do not make the model-facing alias the durable identity of an approved root.

Conceptual root:

    OxpRoot {
      id: stable random RootID
      alias: model-facing slug
      path: canonical native path // local-only
      approvedAt: timestamp
      identityFingerprint?: filesystem identity
    }

Rules:

- alias remains the readable /<alias>/... virtual namespace;
- RootID survives alias rename;
- native path never crosses the MCP/OXP model boundary unless a specific operation intentionally returns native shell output;
- approval stores the canonical path, not the user's unresolved spelling;
- each access re-proves that the approved root path has not become a symlink/junction/reparse redirect;
- whole filesystem roots/drives remain forbidden;
- overlapping roots remain forbidden initially because they create ambiguous virtual authority;
- UNC/network shares remain forbidden initially unless a separate threat model is completed.

Research enhancement: evaluate persisting a platform filesystem identity tuple in addition to canonical path (for example device/inode or Windows file identity where reliable) so deleting and replacing the root directory at the same pathname cannot silently transfer an existing grant to a different directory object.

### 28.3 External support grant

Keep user-facing policy coarse and comprehensible, but make the internal capability classes explicit.

Suggested v0 grant:

    OxpGrant {
      // augmentation plane
      read: boolean
      write: boolean
      process: boolean
      git: boolean
      integrations: boolean
      browser: boolean
      filesReceive: boolean
      filesSend: boolean
      automation: boolean

      // supervision plane
      sessionSupervision: 'none' | 'approved-roots'
      requestSupervision: boolean

      // delegation plane
      delegation: 'disabled' | 'spawn'
      nestedDelegation: boolean
    }

Notes:

- augmentation grants authorize capabilities used directly by the external ChatGPT agent;
- `sessionSupervision` authorizes inspection/control of existing native OpenFork Sessions only within the approved target domain;
- `requestSupervision` controls whether the external agent may mediate Permission/Question requests for supervised Sessions;
- `delegation` controls creation/driving of subordinate native worker Sessions;
- `nestedDelegation` is distinct from initial delegation so one delegated worker cannot silently expand the agent tree;
- rename standalone shell -> process internally because the authority class covers shell, PTY, tests, repo compilers, watchers, and other child processes;
- UI may still say Shell / local processes for clarity;
- filesSend is explicit opt-in and never implied by read;
- filesReceive requires write at execution time but remains a distinct remote-ingress grant;
- automation is a distinct default-off grant for durable future execution; read/write/process authority does not imply it;
- browser should default off until its separate external-control threat model is closed.

### 28.4 Effective authority

Every leaf operation computes:

    effective authority
      = connector grant
      INTERSECT approved root/location
      INTERSECT native OpenFork session/agent permission when a native session is involved
      INTERSECT hard capability invariants

No layer may widen a deny from an earlier layer.

ChatGPT-side app confirmation is an additional platform control, not a replacement for OXP enforcement.

### 28.5 Plane-specific authority vs native-Session permission

Direct augmentation capabilities such as read/find/edit/git do not need a fake OpenFork Session and therefore do not use Session Permission as their primary authority owner. OXP augmentation grant + root authority own those calls.

Supervision operations require `sessionSupervision` plus an explicitly authorized target Session/location; where the native Session/domain has additional permission semantics, those remain authoritative.

Delegation requires `delegation` plus approved root and explicit user-authorized worker model/agent policy. Once created, the delegated Session has normal native OpenFork permissions. `nestedDelegation` controls whether that subordinate agent may further expand the tree.

OXP must never auto-reply to a native pending Permission/Question merely because the connector's coarse grant permits the underlying capability. External support authority and native Session permission are distinct facts.

### 28.6 Grant revision

Persist a monotonically increasing config/grant revision.

Each invocation records the revision admitted at start, but sensitive boundaries re-read live authority instead of trusting the captured snapshot.

Revalidation points:

- before opening/reading local bytes that will be returned externally;
- before mutation commit/rename;
- before process spawn;
- before Git mutation;
- before local file upload/egress begins;
- before publishing a received file into an approved root;
- before supervising an existing Session;
- before creating/continuing/cancelling a delegated worker or worker group;
- before returning sensitive read results when practical.

### 28.7 Revocation behavior

Revocation must have operational meaning.

Recommended semantics:

- connector disabled: reject new calls; cancel active OXP foreground invocations; stop tunnel; terminate OXP-owned interactive/background process trees after bounded graceful shutdown;
- root removed: reject all new references and terminate OXP-owned jobs whose cwd/authority is rooted there;
- process disabled: reject new process/test/compiler launches and terminate OXP-owned live processes;
- write disabled: in-flight mutations fail at commit revalidation;
- git disabled: in-flight Git writes fail before mutation subprocess launch;
- filesSend disabled: cancel/prevent new local-byte egress; recheck immediately before network upload;
- filesReceive disabled: do not atomically publish newly downloaded bytes after revocation;
- read disabled: prevent new reads and, where bytes have not yet crossed the response boundary, suppress result egress.

An already completed external side effect cannot be rolled back merely because policy changed afterward; report the actual committed state.

### 28.8 Persistence owner

Do not place OXP connector configuration inside project-level OpenFork config merging.

Recommended split:

- non-secret durable OXP configuration: a dedicated fork-owned global document under Global.Path.config, e.g. oxp.json;
- ephemeral runtime state, metrics caches, leases: Global.Path.state or Global.Path.data as appropriate;
- connector/tunnel/API secrets: Electron main OS-secure storage, never ordinary OpenFork JSON config/database;
- native OpenFork Session/worker truth: existing durable database/services; OXP persists only its external grant/config and lineage references, never a shadow Session graph.

Why Global.Path.config for oxp.json: approved roots and connector grants are explicit user configuration and should not disappear with ordinary transient state cleanup, while a dedicated file avoids accidental per-project config inheritance/merging.

Use a file lock + atomic temp/rename update and a schema version. Browser clients see only a redacted projection; native root paths remain local-UI-only.

### 28.9 Root resolution algorithm

Port the proven LocalMCP sandbox semantics as the behavioral oracle, then converge its low-level path primitives with OpenFork FS utilities where equivalence is proven.

Resolution order:

1. classify input as OXP virtual path, approved native path copied from output, or relative shorthand;
2. relative shorthand is allowed only with exactly one unambiguous addressed root/workspace;
3. validate raw path segments before normalization so traversal cannot disappear inside path.resolve;
4. resolve and verify the approved root's current canonical identity;
5. canonicalize the deepest existing target ancestor;
6. prove that ancestor and final path remain inside the root;
7. reject symlink/junction/reparse escape;
8. for create paths, allow only missing suffixes beneath a proven in-root existing ancestor;
9. return canonical native path + virtual model-facing spelling + RootID.

Never fall back to the raw path after an OXP resolver refusal.

### 28.10 Read grounding under stateless MCP

Prior-read freshness is safety state, not a transport session.

Maintain a bounded in-memory OXP grounding cache keyed by connector principal + RootID + canonical file identity/path. A successful file-content read records the observed fingerprint used by mutation freshness checks.

Do not key this cache by ChatGPT conversation ID.

Restart may lose grounding state. As in standalone LocalMCP, missing grounding is not automatically permission to blind-write: exact/context mutation verification still applies, and the mutation path may warn or require stronger preconditions.

Future option: return explicit opaque read-grounding tokens for operations that need cryptographically precise read-to-write causality, but do not burden the default edit protocol with them unless evidence shows connector-level grounding is insufficient.

---

## 29. OXP Capability Context v0

The OXP capability layer needs a protocol-neutral execution contract that is deliberately smaller than OpenFork Tool.Context.

### 29.1 Why Tool.Context is not the contract

Tool.Context is an agent-turn adapter. It requires sessionID, messageID, agent, message history, progress metadata persistence, and Permission.ask. Those fields are correct for a model tool call inside an OpenFork Session, but direct OXP workstation operations do not inherently have any of them.

Creating synthetic Sessions or Messages merely to call read/find/git/project would:

- write unnecessary durable state;
- create false provenance;
- couple OXP latency to session infrastructure;
- make direct capabilities require a model/agent identity they do not need;
- confuse native Permission requests with OXP connector grants;
- make background process ownership accidentally session-scoped.

Therefore OXP invokes shared executors through its own narrow context. Native agent tools may adapt Tool.Context into the same lower contract.

### 29.2 Core types

Conceptual shape:

    type OxpInvocationID = branded string

    type OxpPlane = 'augmentation' | 'supervision' | 'delegation'

    interface OxpInvocation {
      id: OxpInvocationID
      principal: OxpPrincipal
      grantRevision: number
      startedAt: number
      plane: OxpPlane
      operation: string
      rootID?: OxpRootID
      workspace?: OxpWorkspaceRef
      target?:
        | { kind: 'session'; id: SessionID }
        | { kind: 'worker'; id: SessionID }
        | { kind: 'worker-group'; id: string }
        | { kind: 'job'; id: string }
      correlation?: string
    }

    interface CapabilityContext {
      invocation: OxpInvocation
      abort: AbortSignal
      authority: CapabilityAuthority
      progress: CapabilityProgress
      provenance: CapabilityProvenance
      grounding: ReadGrounding
    }

The context contains no provider, model, transcript, resident-agent identity, ChatGPT conversation id, or **ambient** OpenFork SessionID. A native SessionID may appear only as the explicit target of a supervision/delegation operation.

This prevents a target Session from silently becoming the caller identity.

### 29.3 Workspace reference

OXP must never carry only a free-form cwd.

Conceptual shape:

    interface OxpWorkspaceRef {
      rootID: OxpRootID
      directory: canonical native directory
      virtualDirectory: string
      projectID?: native OpenFork project identity
      worktree?: canonical OpenFork worktree
    }

The native fields remain internal. A workspace reference is produced only after OXP root resolution/authority succeeds.

Workspace construction is staged:

1. Tier 0/1 operations use root metadata only and must not instantiate an OpenFork workspace runtime.
2. Tier 2 operations may resolve project/worktree identity if needed.
3. Tier 3 operations may enter InstanceRef/WorkspaceRef only for the exact duration required by the shared executor.

#### 29.3.1 Scheduled automation ownership decision — 2026-09-19

`schedule.create` is a Tier-1 durable mutation after OXP has authorized and
canonicalized an approved target directory. Its persistence path is the existing
Core `ScheduledTask` writer; it does not create a Session, workspace,
scheduler, timer, runner, or executor.

Core currently has no cheap durable reverse resolver from an arbitrary canonical
directory/worktree to a native project ID. `ProjectDirectories` can
list/check directories for an already-known project, but does not own a
directory -> project lookup. `ProjectV2.resolve()` is not such a lookup: it
performs live filesystem and Git discovery (including repository/remote/root-
commit resolution). The legacy OpenCode `Project.fromDirectory()` goes
further by migrating/upserting project state and publishing host-side effects.
Neither path may be invoked merely to decorate an OXP-created schedule with
attribution.

Therefore an OXP-created Scheduled Task persists the already-authorized canonical
`targetDirectory` and leaves `projectID` absent. The directory is
authoritative for later execution, exactly as the Scheduled Task schema permits.
This avoids inventing identity, guessing from resident state, or paying Tier-2/3
bootstrap cost at a Tier-1 boundary.

The canonical native `targetDirectory` is durable internal truth, not
model-facing output. OXP projects the freshly revalidated approved-root virtual
path (`/alias/...</BT>) back across the protocol boundary, so schedule
creation does not become an accidental native-path disclosure channel.

If Core later gains an authoritative bootstrap-free reverse index, OXP may reuse
that owner and populate `projectID` only on an exact durable match. Until
then, absence is intentional. Tests must prove the schedule bridge has no
Project/Instance resolver dependency and that same-name projectless collisions
fail closed rather than inferring ownership.

### 29.4 CapabilityAuthority

Authorization is a service, not a boolean captured at tools/list time.

Conceptual API:

    authorize({
      capability,
      phase,
      rootID?,
      path?,
      sessionID?,
      resource?,
    }) -> allow | ask | deny

Initial phases:

- discover: may this capability/resource be surfaced?
- read: may local/external data be observed?
- egress: may bytes/data cross from local machine to ChatGPT/OpenAI?
- mutate: may local durable state be changed?
- commit: revalidation immediately before a durable mutation becomes visible;
- spawn: revalidation before child process creation;
- supervise: inspect/control an existing native OpenFork Session/request;
- delegate: create/continue/cancel a subordinate OpenFork worker/group;
- control: OXP-owned process/job handle control;
- network: external integration invocation.

Do not create phase-specific permission names merely for model visibility. These phases are internal enforcement/audit boundaries.

### 29.5 External-plane grants vs interactive OpenFork permission requests

Direct augmentation capabilities should generally resolve OXP connector policy synchronously: allow or deny.

An OXP direct read must not create a native OpenFork Permission request just because OpenFork's agent-facing ReadTool would call ctx.ask().

When OXP invokes a real OpenFork Session turn, that Session may naturally produce native Permission or Question requests. Those are durable session-domain objects and are surfaced through openfork_request rather than being collapsed into the direct OXP authorization callback.

This preserves two distinct questions:

1. Is ChatGPT externally authorized to ask OpenFork to perform this class of action?
2. Does this particular OpenFork Session/agent require user permission for this action?

Both must pass when both apply.

### 29.6 Progress

Progress must be optional and cheap.

Conceptual sink:

    progress({
      phase,
      title?,
      completed?,
      total?,
      preview?,
    }): void

Rules:

- no durable DB write per progress chunk for direct OXP capabilities;
- coalesce/drop cosmetic progress under load;
- final result is authoritative;
- progress cannot mutate authority;
- do not expose raw unbounded shell output as progress;
- MCP progress support is an adapter concern; shared executors see only the sink.

### 29.7 Provenance seed

CapabilityProvenance is immutable invocation lineage, not a mutable policy bag.

For every OXP operation it records:

- external actor;
- OXP connector principal;
- OXP invocation id;
- semantic plane (`augmentation | supervision | delegation`);
- grant revision admitted;
- addressed root/workspace;
- explicit target Session/worker/group where applicable;
- parent external correlation when provided.

For augmentation, this lineage remains attached to the direct capability effect/audit path. For supervision, the target Session domain persists the truthful external-actor attribution wherever the operation creates durable Session-visible state. For delegation, the new worker domain derives the proper persisted SessionTurnProvenance/producer lineage from this seed.

### 29.8 Read grounding

ReadGrounding owns stale-read causality for direct OXP mutations.

Responsibilities:

- note successful content reads;
- query freshness at mutation planning/commit;
- update/remove entries after successful mutations;
- bound memory and use O(1) expected lookup;
- namespace by OXP principal/root so unrelated native Sessions do not share accidental read authority.

Do not merge OXP's direct grounding cache into SessionTools' session-keyed globalReadCache by pretending the connector is a Session.

Longer-term, both caches may share a lower fingerprint/grounding engine with separate namespaces.

### 29.9 Shared executor result

Do not make shared capabilities return MCP CallToolResult or Tool.ExecuteResult.

Use a protocol-neutral result:

    interface CapabilityResult {
      title?: string
      output: string
      structured?: unknown
      attachments?: CapabilityAttachment[]
      metadata?: Record<string, unknown>
      mutation?: {
        attempted: boolean
        committed: boolean
      }
    }

The OXP MCP adapter converts this into MCP content/structuredContent. The native Tool adapter converts it into Tool.ExecuteResult.

### 29.10 Output projection

Every OXP result crosses exactly one final model-facing projection boundary.

Requirements:

- preserve producer/domain pagination/caps;
- apply one final UTF-8 byte bound;
- never double-truncate an already bounded result unnecessarily;
- retain structured pagination/continuation metadata;
- spill large local diagnostic output only to OXP-authorized locations or an OpenFork-owned private tool-output store with an explicit OXP read handle;
- attachments must be typed and independently authority-checked.

OpenFork's new ToolOutputProjection/retention work should be reused below adapters wherever possible rather than creating OXP-only truncation logic.

### 29.11 Cancellation

One AbortSignal flows from MCP request cancellation through OXP invocation into the leaf executor.

For process-backed operations cancellation additionally owns the child/process-tree kill path.

For durable workers/background jobs, cancellation of the initiating MCP request does not necessarily cancel the durable object after creation. The operation must define the commit point:

- before durable handle creation: request cancellation aborts creation;
- after durable handle creation/result acknowledgement: object lifetime is controlled through its explicit handle.

This avoids ambiguous 'request disconnected, did my worker start?' behavior.

### 29.12 Capability registration

OXP capability registration should describe semantics without requiring model/session construction:

    OxpCapability {
      id
      description
      input schema
      plane: 'augmentation'
      exposure: direct | brokered
      authority class
      workspace tier
      mutation class
      execute(input, CapabilityContext)
    }

The registry may reuse schemas/descriptions from native Tool definitions only when contracts are truly identical. Schema sharing must not force executor sharing through Tool.Context.

### 29.13 Supervision/delegation operation contracts

Supervision and delegation are **not** registered as ordinary `OxpCapability` executors merely because they are exposed as MCP tools.

They should have explicit typed operation descriptors/adapters that preserve target semantics:

    OxpSupervisionOperation {
      id
      input schema
      target: 'session' | 'request'
      required grant
      execute(input, OxpInvocation /* plane=supervision */)
    }

    OxpDelegationOperation {
      id
      input schema
      target: 'worker' | 'worker-group'
      required grant
      modelPolicyRequirements
      execute(input, OxpInvocation /* plane=delegation */)
    }

This keeps the shared capability executor abstraction narrow and prevents higher-order agent orchestration from being mis-modeled as a filesystem/tool call.

### 29.14 Performance invariant

Creating CapabilityContext must be allocation-light and must not initialize:

- provider catalogs;
- LLM clients;
- SessionProcessor;
- plugin runtime unless the called capability requires plugins;
- LSP unless the leaf capability needs it;
- MCP clients unless the leaf capability targets an integration;
- snapshot/checkpoint services for proven read-only operations.

The OXP admission path should resolve principal + grant + root in Tier 0/1 before deciding whether any workspace runtime is needed.

---

## 30. OXP Surface Manifest v0

This is the proposed first clean OXP model-facing surface. It is intentionally not a 1:1 preservation of standalone LocalMCP tool names.

Standalone LocalMCP currently exposes 21 direct tools in the live ChatGPT connector. The current harness representation is roughly 23.4k characters of tool descriptions/schema metadata before broader OpenFork capabilities are added.

OXP should provide substantially more total capability while keeping the permanent manifest at or below that baseline.

### 30.1 Surface laws

1. Top-level schemas are versioned product contracts, not runtime inventory.
2. Permission toggles, roots, providers, models, sessions, workers, and MCP integrations do not add/remove top-level tools.
3. A disabled capability returns a structured OXP_AUTH_DENIED result at execution; it does not mutate the manifest.
4. Dynamic/niche capability goes through one stable broker.
5. Direct tools are reserved for high-frequency, latency-sensitive, or state-machine-sensitive operations.
6. Do not expose aliases forever. One deliberate OXP cutover + ChatGPT Refresh is cheaper than permanent duplicated schema.

### 30.2 Proposed direct set

Provisional OXP v0 direct tools, grouped by semantic plane:

    AUGMENTATION
      read
      find
      edit
      patch
      git
      process
      project
      symbols
      file_transfer
      capability

    DISCOVERY / SUPERVISION
      openfork_info
      openfork_session
      openfork_request

    DELEGATION
      openfork_worker

14 direct tools versus standalone LocalMCP's current 21.

The grouping is semantic, not a request-routing requirement. It exists so the model-facing contract, authority code, provenance, and tests all agree about what kind of actor relationship each tool represents.

This is a planning target, not yet a frozen wire contract. Before implementation freeze, compare against standalone call-frequency telemetry and representative ChatGPT coding traces.

### 30.3 Why each stays direct

**read**

- highest-frequency repository primitive;
- batching/windowing is latency-sensitive;
- read-grounding state belongs at direct admission;
- useful outside coding agents and without any OpenFork Session.

**find**

- high-frequency discovery primitive;
- keeps trial-read cost low;
- deterministic root scoping is central to OXP authority.

**edit**

- common precision mutation;
- direct schema lets model select exact/line/range/batch editing without broker discovery;
- mutation preconditions are security-sensitive and deserve explicit contract.

**patch**

- overlaps edit.patchText, but multi-file atomic change is common and semantically distinct enough to preserve a first-class tool;
- models reliably select patch for coherent bulk work;
- avoids forcing a large overloaded edit schema to carry all structural mutations.

**git**

- very common repository state/verification path;
- typed safe modes materially outperform shell choreography;
- its confirmation/write semantics warrant a visible contract.

**process**

- replaces standalone exec_command + write_stdin + shell + background;
- explicit stateful handles match stateless MCP;
- central for builds, dev servers, tests, scripts, and local diagnostics;
- consolidating four overlapping schemas saves prefix bytes and one duplicated process ontology.

**project**

- cheap orientation should occur before broad exploratory reads;
- direct availability improves both cost and safety.

**symbols**

- high-value code navigation that avoids broad grep/read loops;
- direct discovery/search/usages is frequent enough in coding workflows to justify the schema;
- future OpenFork indexing/LSP improvements can improve it without surface churn.

**file_transfer**

- OpenAI/ChatGPT exchange is an OXP-defining capability, not a niche plugin;
- explicit ingress/egress grant boundaries are easier to reason about when first-class;
- schema remains fixed even when egress is disabled.

**capability**

- stable progressive broker for all long-tail OpenFork and external MCP capabilities;
- this is what allows OXP to grow without growing the permanent prefix.

**openfork_info/session/worker/request**

- these are not merely a generic control API: `openfork_session` + `openfork_request` form the **supervision plane**, while `openfork_worker` is the **delegation plane**;
- `openfork_info` provides discovery/catalog context used by both;
- four semantic domains are clearer to models than one giant multiplexer;
- the existing LocalMCP OpenCode Control experiment already validated the stability of this split;
- these higher-order operations are the core reason OXP supports an existing external agent rather than simply exposing another workstation tool server.

### 30.4 Process tool replaces four standalone tools

Conceptual schema:

    process({
      action:
        'start' |
        'poll' |
        'write' |
        'list' |
        'status' |
        'read' |
        'wait' |
        'kill' |
        'remove',

      command?,
      commands?,
      workdir?,
      mode?: 'foreground' | 'background',
      tty?,
      shell?,
      login?,
      yieldMs?,
      timeoutMs?,

      handle?,
      chars?,
      offset?,
      maxBytes?
    })

Semantics:

- start foreground behaves like current exec_command: return terminal result or an explicit live process handle when it outlives the initial yield;
- poll/write continue an interactive live process;
- start background returns an explicit durable OXP job handle and persistent output log;
- list/status/read/wait/kill/remove operate on OXP-authorized job/process handles;
- process handle type distinguishes ephemeral interactive process from durable background job internally even if one tool manages both;
- workdir is always an explicit resolved OXP workspace/root location;
- command remains an opaque script string and is never path-rewritten;
- ShellLaunch remains the single interpreter/transport owner.

Compatibility note: do not expose exec_command/write_stdin/shell/background aliases in the permanent OXP v1 manifest. If migration testing proves they are needed, provide a temporary opt-in compatibility profile with a documented removal date and separate fingerprint.

### 30.5 Capability broker

Conceptual schema:

    capability({
      action: 'list' | 'describe' | 'call',
      namespace?: 'openfork' | 'integration',
      capability?: string,
      query?: string,
      args?: object,
      cursor?: string
    })

`list` returns compact catalog rows only:

- canonical id;
- namespace/source;
- one-line description;
- authority class;
- exposure status;
- optional unavailable reason.

`describe` returns exact current schema/instructions for one capability.

`call` validates against the canonical schema and dispatches through the same OXP authority/execution boundary.

Do not put all long-tail schemas into the result of list.

### 30.6 Initial brokered OpenFork capabilities

Candidates:

- archive;
- json;
- skill;
- test;
- typecheck;
- lsp;
- browser;
- refactor;
- sqlite;
- memory;
- checkpoint;
- goal;
- web/research tools where product policy allows;
- future scheduled-task control once provenance/authority is settled.

Typecheck remains unavailable through the OXP read grant until the section 25 parity gate is resolved.

Browser/computer-control should initially report unavailable unless an explicit OXP browser grant and threat model are implemented.

### 30.7 External MCP through the same broker

Do not create one permanent ChatGPT-visible tool for every tool in every OpenFork-configured MCP server.

Example IDs:

    integration/github/create_issue
    integration/postgres/query

The broker list/describe/call flow resolves these through OpenFork MCP.Service.

Resources/prompts can either use the same capability namespace with typed operation kinds or receive a separate stable resource tool later. Do not multiply permanent top-level tools before usage data requires it.

### 30.8 openfork_info

Keep a compact action union:

- status;
- capabilities;
- providers;
- models;
- agents;
- limits;
- usage.

Add OXP-specific connector/runtime status only if ChatGPT has a real use case. Local desktop settings remain the primary connector diagnostics surface.

### 30.9 openfork_session

Initial actions:

- list;
- get;
- messages;
- children;
- selection;
- set_selection;
- send;
- turn;
- pause;
- resume;
- abort;
- background_subagents.

All Session lookup/control is **supervision**, filtered by `sessionSupervision` + approved-root authority before native Session services are called. The OXP principal remains the actor and the Session remains the target. Any durable Session-visible effect must preserve that distinction in provenance.

`selection` and `set_selection` use the same first-class provider/model/account/variant contract as delegation. If a native provider stores an account-qualified model ID internally, the OXP projection splits it before returning it; callers never need to synthesize account suffixes.

### 30.10 openfork_worker — delegation plane

This tool creates and supervises subordinate native OpenFork worker Sessions; it does not represent the ChatGPT agent itself.

Initial actions:

- model_policy;
- set_default_model;
- clear_default_model;
- start;
- list;
- get;
- wait;
- result;
- continue;
- cancel;
- batch_start;
- batch_list;
- batch_get;
- batch_wait;
- batch_cancel;
- batch_continue.

Use batch_* rather than swarm_* for OXP independent-worker groups. OpenSwarm remains a distinct native coordination system.

Every start/continue operation must enforce delegation/nested-delegation policy and user-authorized model/agent policy. Returned handles name subordinate OpenFork objects, not transport sessions.

Model policy includes provider account identity. `model_policy`, `set_default_model`, `start`, `continue`, `batch_start`, and `batch_continue` expose/consume `accountId` alongside `providerId`, `modelId`, and `variant`. Explicit `accountId` is exact routing authority and may not fall back to another provider account. Omission is the only form that authorizes provider-defined automatic account routing.

### 30.11 openfork_request — supervision plane

This tool mediates native Permission/Question objects belonging to Sessions the external agent is authorized to supervise.

Initial actions:

- list;
- reply_permission;
- answer_question;
- reject_question.

Never expose requests for an OpenFork Session outside OXP's authorized supervision/root domain. A reply is attributable to the external OXP supervisor; it is never silently rewritten as a resident-agent decision.

### 30.12 File transfer schema stability

Unlike standalone LocalMCP's current permission-dependent file_transfer action enum, OXP should keep one fixed schema:

- save_chatgpt_file;
- download_openai_file;
- upload_openai_file;
- get_openai_file;
- list_openai_files.

Runtime authority determines whether an action is allowed.

This avoids tool-schema churn when filesSend/filesReceive toggles change.

### 30.13 Server instructions

Keep MCP server instructions short and mostly invariant.

Do not inject full root lists, provider catalogs, or dynamic integration inventory into the permanent instruction prefix if that causes prompt-cache churn.

Stable instructions should explain only:

- this is OpenFork OXP for **supporting an already-running ChatGPT agent**;
- ChatGPT is not represented by a backing OpenFork Session;
- OXP has augmentation, supervision, and delegation semantics;
- supervision targets native Sessions without impersonating their resident agents;
- delegation creates subordinate native OpenFork Sessions;
- no implicit ChatGPT conversation workspace;
- paths use approved root aliases;
- direct vs brokered augmentation capability pattern;
- explicit durable handles;
- never infer authorization from schema visibility.

Dynamic roots/grants/status are returned through compact status/catalog operations when needed.

### 30.14 Fingerprint rules

Compute a canonical SHA-256 over exact model-facing:

- tool names;
- descriptions;
- input/output schemas;
- stable server instructions;
- OXP major surface version.

The fingerprint MUST remain unchanged across:

- connector connect/disconnect;
- root add/remove/rename;
- grant changes;
- OpenFork restart;
- provider/model changes;
- session/worker lifecycle;
- external MCP connect/disconnect;
- file-transfer credential presence;
- browser availability;
- quota/usage changes.

A deliberate schema release changes the fingerprint and requires one explicit ChatGPT app refresh.

### 30.15 Quantitative surface target

Before freezing OXP v1, generate the canonical serialized manifest and compare it to the standalone baseline.

Initial acceptance target:

- <= 14 direct tools;
- <= current standalone direct manifest serialized bytes;
- ideally <= 75% of the current standalone description/schema character budget while retaining equivalent common-path ergonomics;
- unlimited practical long-tail growth through the broker without top-level fingerprint changes.

Do not optimize tool count alone. Measure model call count, wrong-tool selection, broker round trips, prompt bytes, and completion latency on representative repository tasks.

---

## 31. OXP Process Boundary Contract v0

This contract resolves the first desktop implementation topology.

### 31.1 OXP v1 transport scope

Because OXP is explicitly the OpenAI Exchange Protocol and is purpose-built for ChatGPT/OpenAI exchange, OXP v1 supports **OpenAI Secure MCP Tunnel only**.

Standalone LocalMCP's cloudflared/manual adapters are not part of the first-party OXP product contract.

Reasons:

- dramatically smaller threat surface;
- no public quick-tunnel URL mode;
- one health/recovery model;
- one authentication model;
- one setup UX;
- fewer packaged binaries/branches;
- the product name and implementation purpose remain aligned.

A developer-only/manual transport can be reconsidered later as a separate debug facility, not as part of normal OXP authority or setup.

### 31.2 Physical topology

Initial desktop topology:

    Electron main process
      |- OXP desktop lifecycle preferences
      |- OS-secure OpenAI connector secret
      |- tunnel-client binary discovery/supervision
      |- tunnel health/reconnect state machine
      |- tray / login-item / start-hidden behavior
      |
      | Electron utility-process IPC (privileged, non-renderer)
      v
    existing OpenFork sidecar utility process
      |- ordinary OpenFork HTTP server
      |- OpenFork runtime/services
      `- dedicated OXP loopback MCP listener
           |- secret random path
           |- MCP v2 server
           |- OXP authority/catalog/invocation
           `- direct OpenFork domain/service access

    tunnel-client
      |- CONTROL_PLANE_API_KEY in child environment
      |- MCP_SERVER_URL=<secret sidecar loopback OXP URL>
      `- outbound OpenAI Secure MCP Tunnel

Do not add a second heavyweight OpenFork/OXP sidecar process for v1. The existing sidecar already owns the authoritative runtime and has a privileged Electron parentPort channel.

### 31.3 Dedicated OXP loopback listener, not an OpenFork HTTP route

The preferred v0 design is a separate loopback listener inside the existing sidecar process rather than mounting OXP under the ordinary OpenFork HTTP server.

Benefits:

- OXP can start/stop independently while OpenFork stays running;
- its random secret path and localhost Host/Origin policy remain isolated from OpenFork Basic-auth/API routing;
- tunnel-client gets exactly the MCP endpoint it expects;
- no generic HTTP route becomes a privileged OXP capability proxy;
- protocol implementation can use the proven MCP v2 server/node packages without forcing the ordinary OpenFork HTTP stack to adopt them;
- OXP still has direct in-process access to OpenFork services.

Bind to 127.0.0.1 on an ephemeral port unless IPv6 support is separately proven. Never bind OXP directly to LAN/public interfaces.

### 31.4 Sidecar lifecycle messages

Extend the existing sidecar parentPort protocol rather than introducing another localhost control server.

Conceptual main -> sidecar commands:

    { type: 'oxp.start-endpoint', requestID }
    { type: 'oxp.stop-endpoint', requestID }
    { type: 'oxp.status', requestID }
    { type: 'oxp.revoke', revision, reason }

Conceptual sidecar -> main events/results:

    {
      type: 'oxp.endpoint-ready',
      requestID?,
      generation,
      localUrl,          // privileged; includes secret endpoint token
      schemaFingerprint,
      oxpVersion
    }

    { type: 'oxp.endpoint-stopped', generation }
    { type: 'oxp.status', ...redactedStatus }
    { type: 'oxp.error', class, message }

The secret localUrl must never be forwarded to renderer/browser-safe state or ordinary logs.

### 31.5 Main-side message bus change

packages/desktop/src/main/server.ts currently installs a temporary child message listener during startup and removes it once the sidecar reports ready.

OXP requires a small persistent typed sidecar-event subscription after startup.

Do not create ad hoc global listeners in feature code. Extend the sidecar wrapper to expose one multiplexed typed message/event channel with bounded listener ownership and cleanup.

This channel is useful beyond OXP only if another first-party native feature genuinely needs it; do not prematurely turn it into a generic RPC framework.

### 31.6 Single connector ownership

OpenFork desktop already calls app.requestSingleInstanceLock().

Therefore desktop OXP v1 has one natural tunnel supervisor: the singleton Electron main process.

No additional file lease/election is required for the first desktop implementation.

Revisit a cross-process profile lease only if OXP is later supported by an independent headless daemon/CLI that can run concurrently with desktop.

### 31.7 Configuration ownership refinement

Split configuration by semantic owner instead of one monolithic oxp.json.

**Sidecar/core OXP config** — dedicated Global.Path.config/oxp.json:

- enabled;
- connector stable id/label;
- approved roots;
- OxpGrant augmentation capabilities;
- Session-supervision policy;
- request-supervision policy;
- worker-delegation and nested-delegation policy;
- OXP semantic config revision.

**Electron-main transport/lifecycle config** — desktop native store:

- OpenAI tunnel ID;
- optional tunnel-client binary override;
- auto-connect;
- launch at login;
- start hidden;
- close to tray.

**Electron safe storage**:

- OpenAI control-plane API key;
- any dedicated OpenAI Files API credential if OXP file exchange requires one.

This refines section 28: tunnel/lifecycle settings do not belong in the sidecar core OXP config merely because they are non-secret. They belong to the desktop transport owner that consumes them.

Browser-safe settings projections combine redacted data from these owners without creating a third source of truth.

### 31.8 Startup sequence

Normal desktop launch:

1. Electron main acquires the existing single-instance lock.
2. Main applies lifecycle preference needed before window creation, including start-hidden behavior.
3. Main starts the ordinary OpenFork sidecar as it does today.
4. Sidecar initializes OpenFork services and reads core OXP config.
5. If OXP is enabled, sidecar starts the dedicated OXP loopback MCP listener and emits oxp.endpoint-ready with generation + secret local URL.
6. Main receives the endpoint descriptor over privileged utility-process IPC.
7. If auto-connect/user-connect policy says connect, main reads the OpenAI API key from OS-secure storage.
8. Main starts tunnel-client with the local URL and tunnel ID in environment/config fields, never command-line secrets.
9. Main reports tunnel health to the local UI through a redacted browser-safe projection.

OXP endpoint readiness and OpenAI tunnel readiness are separate states. Do not label the connector connected merely because the local endpoint is listening.

### 31.9 User Connect flow

Renderer sends a narrow native action such as oxp.connect; it never receives API key or local secret endpoint URL.

Main:

1. verifies secure-storage availability;
2. verifies tunnel ID/API key presence;
3. ensures sidecar/OXP endpoint is ready;
4. starts exactly one tunnel supervisor;
5. publishes redacted connection status.

Repeated Connect is idempotent. It must not spawn parallel tunnel trees.

### 31.10 Tunnel supervision

Port the standalone LocalMCP OpenAI tunnel supervisor behavior as the oracle.

Keep:

- API key in child environment, not argv;
- MCP server URL in child environment, not argv;
- health listener on 127.0.0.1:0;
- authoritative readyz startup proof;
- control-plane poll freshness as remote-route proof;
- distinguish network outage from broken local tunnel-client;
- let tunnel-client's own control-plane retry handle ordinary offline periods;
- confirm readiness failure across more than one probe before replacement;
- one restart owner/CAS;
- exponential bounded restart backoff;
- fail closed if an old tunnel tree cannot be proven stopped;
- process-tree termination;
- bounded structured log parsing;
- terminal auth-failure state for bad tunnel ID/API key.

Do not rewrite this state machine from memory during porting. Move it with its existing tests and then adapt ownership/logging.

### 31.11 Sidecar restart semantics

Prefer convergent restart over attempting to preserve tunnel-client across sidecar endpoint death.

When the sidecar exits/restarts:

1. main marks the local OXP endpoint unavailable;
2. main stops the current tunnel-client tree;
3. restarted sidecar creates a new OXP endpoint generation with a new secret path;
4. main receives the new endpoint descriptor;
5. auto-connect restarts tunnel-client against the new URL.

Rationale:

- the old MCP URL is dead anyway;
- keeping tunnel-client alive while its local upstream vanished adds ambiguous in-flight failure modes;
- a fresh random endpoint token per sidecar generation is desirable;
- tunnel restart cost is acceptable compared with correctness.

### 31.12 OXP endpoint restart without sidecar restart

Each endpoint start creates a new generation and fresh random path token.

Main compares generation before acting on asynchronous tunnel/status results so stale stop/start completions cannot kill a newer connector.

### 31.13 Shutdown order

Explicit application Quit:

1. mark app/OXP supervisor stopping;
2. reject new OXP endpoint calls;
3. cancel foreground OXP invocations;
4. stop tunnel-client tree and wait boundedly;
5. terminate/cancel OXP-owned live local process jobs according to shutdown policy;
6. stop OXP endpoint;
7. stop ordinary OpenFork sidecar;
8. exit Electron.

Close-to-tray is not Quit and performs none of these teardown steps.

### 31.14 OXP disable sequence

Disabling OXP while OpenFork remains open:

1. increment/revoke core grant/config revision;
2. reject new OXP invocations;
3. cancel active foreground OXP invocations;
4. terminate OXP-owned process trees;
5. main stops tunnel-client;
6. sidecar stops OXP MCP listener;
7. preserve non-secret configuration and approved roots unless user explicitly clears them;
8. preserve OS-secure credential unless user explicitly removes it.

### 31.15 Secret-store port

Port standalone LocalMCP's safeStorage implementation/invariants rather than merely calling safeStorage.encryptString once.

Preserve:

- async secure-storage availability checks;
- Linux rejection of Chromium basic_text/v10 hard-coded-key fallback based on ciphertext authority, not only backend label;
- no plaintext credential over renderer IPC;
- encrypted atomic temp+rename persistence;
- serialized read-modify-write mutations;
- single-flight decrypt/load;
- generation invalidation so delete cannot race a stale decrypt and resurrect secrets;
- preserve unknown string fields for forward compatibility;
- unreadable/malformed existing ciphertext is never treated as authoritative empty state for mutation;
- re-encryption/rotation support when Electron requests it;
- runtime environment/file override only for explicitly designed headless support.

OXP should use its own secret namespace/file rather than silently adopting OpenFork provider auth storage.

### 31.16 File-transfer secret bridge

For v1, prefer a narrow privileged main<->sidecar request for the dedicated OpenAI Files API credential when a file-transfer operation actually needs it.

Recommended flow:

1. OXP sidecar resolves root authority and local file identity itself.
2. Immediately before remote OpenAI request, sidecar requests the credential from Electron main over privileged utility-process IPC using a request ID and operation purpose.
3. Main returns the plaintext only to the sidecar process, never renderer; sidecar holds it only for the operation lifetime.
4. Sidecar performs the network request and local stable-file/atomic-publication checks, so filesystem authority remains in one place.
5. Credential is never persisted or logged by sidecar.

This is preferable to making Electron main read arbitrary approved local files merely because it owns safeStorage.

If later security review prefers keeping plaintext completely out of sidecar, replace this with a purpose-built streaming OpenAI request proxy. Do not prebuild that complexity before evidence requires it.

### 31.17 Renderer/UI boundary

Renderer gets only redacted DTOs:

- enabled;
- connection state;
- secure-storage available boolean/detail;
- tunnel ID presence or masked display, not API key;
- approved root aliases plus local native paths only where the local desktop settings UI needs to display them;
- redacted OxpGrant projection, including augmentation/supervision/delegation policy;
- last handshake/request/operation timestamps;
- bounded per-plane metrics;
- integration status.

Renderer never receives:

- OpenAI API key;
- plaintext secret store;
- secret local MCP URL/token;
- signed ChatGPT download URLs;
- plugin/integration secrets.

### 31.18 Background desktop lifecycle

To replace standalone LocalMCP, add opt-in desktop lifecycle behavior:

- app.setLoginItemSettings or platform-equivalent launch-at-login owner;
- start-hidden handling before initial window show;
- Tray owner created only when background behavior is enabled;
- window-all-closed must keep app alive when OXP close-to-tray/background policy requires it;
- tray action opens/focuses window;
- explicit Quit bypasses close-to-tray and runs full shutdown.

Reuse the existing single-instance deep-link/focus behavior rather than creating an OXP-specific second-instance path.

### 31.19 Crash recovery

Main-side tunnel supervisor is ephemeral and reconstructible from:

- native transport config;
- OS-secure key;
- current sidecar endpoint descriptor.

No tunnel supervisor database is needed.

OXP durable worker/session truth remains in OpenFork's existing database.

OXP direct background-process recovery must be decided per actual OpenFork job durability semantics; do not promise restart recovery for process handles until the process owner can prove the child still exists and ownership is unambiguous.

### 31.20 Desktop v1 resolved decisions

These open questions are resolved for the initial desktop implementation:

- transport: OpenAI Secure MCP Tunnel only;
- one desktop connector owner: singleton Electron main;
- no extra distributed connector lease;
- OXP MCP endpoint: dedicated loopback listener inside existing OpenFork sidecar;
- main/sidecar lifecycle control: typed utility-process IPC;
- connector secrets: Electron OS-secure store;
- capability/session execution: sidecar direct domain services;
- sidecar restart: stop tunnel and reconnect to fresh endpoint generation;
- no secret OXP endpoint details cross into renderer.

---

## 32. Desktop IPC and settings contract v0

### 32.1 Do not use the generic renderer store IPC as OXP's API

OpenFork desktop currently exposes generic store-get/store-set/store-delete operations for ordinary renderer persistence. OXP must not use those calls as its product control plane.

Reasons:

- OXP settings span three semantic owners: sidecar authority config, Electron lifecycle/tunnel config, and OS-secure secrets;
- generic key/value writes cannot enforce cross-field invariants or revocation ordering;
- secrets must never enter renderer-managed persistence;
- a root add/remove operation must run canonicalization/overlap checks before persistence;
- connect/disconnect are lifecycle actions, not setting writes;
- future config migrations need one typed owner.

Create a dedicated native OXP API.

### 32.2 Renderer-facing platform contract

Prefer one optional typed platform capability rather than importing Electron globals into shared app components:

    interface OxpPlatform {
      getState(): Promise<OxpDesktopState>
      subscribe(cb: (state: OxpDesktopState) => void): Promise<() => void> | (() => void)

      setEnabled(enabled: boolean): Promise<OxpDesktopState>
      setGrant(patch: OxpGrantPatch): Promise<OxpDesktopState>

      addRoot(): Promise<OxpDesktopState>
      renameRoot(rootID: string, alias: string): Promise<OxpDesktopState>
      removeRoot(rootID: string): Promise<OxpDesktopState>
      revealRoot(rootID: string): Promise<boolean>

      setTunnelID(value: string): Promise<OxpDesktopState>
      setTunnelApiKey(value: string): Promise<OxpDesktopState>
      clearTunnelApiKey(): Promise<OxpDesktopState>

      setLifecycle(patch: OxpLifecyclePatch): Promise<OxpDesktopState>
      connect(): Promise<OxpDesktopState>
      disconnect(): Promise<OxpDesktopState>

      exportDiagnostics?(): Promise<string>
    }

Then add `oxp?: OxpPlatform` to the shared Platform contract. The desktop renderer supplies it; web/PWA do not.

The exact mutation shapes should use schema-validated DTOs rather than broad Record<string, unknown> patches.

### 32.3 Preload surface

Expose a dedicated namespace:

    window.api.oxp = {
      getState, subscribe,
      setEnabled, setGrant,
      addRoot, renameRoot, removeRoot, revealRoot,
      setTunnelID, setTunnelApiKey, clearTunnelApiKey,
      setLifecycle, connect, disconnect, exportDiagnostics
    }

Do not expose:

- getSecret;
- raw safeStorage ciphertext;
- secret local MCP endpoint URL;
- arbitrary sidecar-message send;
- arbitrary filesystem root path setters;
- arbitrary tunnel-client argv/env setters.

`addRoot()` should open the trusted native directory picker inside the main process and return only after sidecar authority validation/persistence succeeds. Do not let the renderer submit an arbitrary unvalidated path as a root through a generic settings field.

### 32.4 IPC ownership

Do not keep growing the already-large generic main/ipc.ts with OXP internals.

Recommended structure:

    packages/desktop/src/main/oxp/
      contracts.ts
      controller.ts
      ipc.ts
      credentials.ts
      tunnel.ts
      lifecycle.ts

`registerIpcHandlers` may call one `registerOxpIpc(controller)` integration point, analogous to the existing WSL/browser subsystem split.

Renderer sender validation should follow the stricter native IPC paths: only the app's trusted main frame may mutate OXP state.

### 32.5 State subscription

OXP state is push-driven.

One main-process controller owns the current aggregate redacted state and publishes only when its semantic projection changes.

Renderer flow:

1. `getState()` for initial state;
2. `subscribe()` for changes;
3. unsubscribe on owner destruction/unmount.

Do not poll tunnel health, sidecar OXP status, safe-storage status, or metrics from the renderer.

Main internally merges:

- sidecar OXP authority/config status;
- endpoint generation/readiness;
- tunnel supervisor status;
- secure-storage status;
- desktop lifecycle settings;
- bounded metrics summaries.

The merged DTO is a projection, not a new source of truth.

### 32.6 Suggested redacted desktop DTO

Conceptually:

    OxpDesktopState {
      version: 1
      enabled: boolean
      connector: { id: string; label: string }
      configRevision: number

      roots: Array<{
        id: string
        alias: string
        path: string // local desktop UI only; never MCP/model-facing
        available: boolean
      }>

      grant: OxpGrant

      endpoint: {
        state: 'stopped' | 'starting' | 'ready' | 'error'
        generation?: number
        schemaFingerprint?: string
      }

      tunnel: {
        state: 'disconnected' | 'starting' | 'connected' | 'offline' | 'auth-failed' | 'unavailable'
        tunnelID: string
        apiKeyPresent: boolean
        lastHandshakeAt?: number
        detail?: string
      }

      secureStorage: { available: boolean; detail?: string }

      lifecycle: {
        autoConnect: boolean
        launchAtLogin: boolean
        startHidden: boolean
        closeToTray: boolean
      }

      metrics: {
        lastRequestAt?: number
        lastOperationAt?: number
        calls: number
        failures: number
        augmentationCalls: number
        supervisionCalls: number
        delegationCalls: number
      }
    }

Do not include any secret-valued field with masking as a substitute for omission.

### 32.7 Root mutation flow

`addRoot()` is intentionally a cross-process command because native folder selection belongs to Electron while canonical root authority belongs to OXP sidecar.

Flow:

1. main opens native directory picker;
2. main sends candidate native path over privileged sidecar IPC;
3. sidecar OXP Root service canonicalizes, rejects whole-drive/root, UNC, overlap, and unstable/reparse conditions;
4. sidecar allocates stable RootID + deterministic/default alias;
5. sidecar atomically persists oxp.json and increments config revision;
6. sidecar returns redacted root projection to main;
7. main publishes updated state.

Renderer never becomes the canonicalizer.

Rename changes alias only; RootID/path authority stays stable.

Remove increments revision before returning success and triggers live revocation behavior from section 28.

### 32.8 Settings placement

OXP deserves a dedicated V2 settings tab rather than being buried in General or Servers.

Proposed section:

    Desktop
      General
      Shortcuts
      OpenAI Exchange   <-- OXP

or, if product language should emphasize the user outcome:

    Desktop
      General
      Shortcuts
      ChatGPT

with 'OpenAI Exchange Protocol (OXP)' inside the page.

The protocol name is useful in diagnostics/developer language; `ChatGPT` may be clearer as the navigation label.

Do not place OXP under Servers: the OpenFork sidecar/server is not what the user is configuring. They are configuring a first-party ChatGPT bridge into the local product.

### 32.9 Platform visibility

The OXP settings tab is present only when `platform.oxp` exists.

Web/PWA clients connected to the same OpenFork server must not gain local Electron tunnel/secret controls merely because they can see server settings.

A future remote-admin OXP surface, if desired, must be designed explicitly with its own trust/authentication model.

### 32.10 Settings page structure

Recommended page order:

1. **Connection** — enable, state, Connect/Disconnect, last verified handshake.
2. **Approved folders** — root alias/path table, add/remove/reveal.
3. **Augmentation capabilities** — read/write/process/git/integrations/files receive/files send/browser policy.
4. **Agent support** — existing-Session supervision, request supervision, worker delegation, nested delegation.
5. **OpenAI tunnel** — tunnel ID, API key presence/set/clear, secure-storage status.
6. **Background behavior** — auto-connect, launch at login, start hidden, close to tray.
7. **Activity/diagnostics** — schema fingerprint, last request/operation, bounded per-plane metrics, export diagnostics.

File egress should have conspicuously distinct copy from local read access because it crosses the machine boundary.

### 32.11 First-run behavior

Do not auto-enable OXP because OpenFork is installed.

Initial state:

- disabled;
- zero approved roots;
- filesSend false;
- browser false;
- Session supervision disabled until explicitly configured;
- request supervision disabled until explicitly configured;
- worker delegation disabled until explicitly configured;
- nested delegation false;
- background lifecycle preferences false;
- no tunnel process.

Setup can be a single guided flow inside the settings page:

1. Enable OXP.
2. Add at least one folder.
3. Enter tunnel ID + API key.
4. Review augmentation, supervision, delegation, and file-exchange grants.
5. Connect.
6. Show one concise instruction to select/refresh the connector in ChatGPT.

Do not create a separate standalone-style control window.

---

## 33. OXP security and recovery oracle

### 33.1 Threat boundaries

OXP crosses four distinct trust boundaries:

1. **ChatGPT/OpenAI -> tunnel-client** — remote external requests.
2. **tunnel-client -> loopback MCP endpoint** — local protocol ingress.
3. **OXP adapter -> OpenFork runtime/OS** — local capability execution.
4. **renderer -> Electron/sidecar administration** — local human configuration.

Do not collapse them into one 'trusted local app' assumption.

### 33.2 External request invariants

Every OXP MCP request must satisfy:

- loopback-only listener;
- unguessable endpoint path token;
- constant-time path comparison where applicable;
- Host/Origin validation equivalent to standalone LocalMCP;
- bounded request body;
- parser/schema bounds before expensive work;
- no implicit root/workspace;
- live connector grant check;
- request cancellation propagation;
- bounded result projection;
- metrics recorded at the actual MCP dispatch boundary.

### 33.3 Renderer administration invariants

Renderer is trusted UI code but not a secret store or unrestricted native principal.

Native OXP IPC handlers must:

- validate sender is a current trusted OpenFork main-frame webContents;
- schema-validate every payload;
- expose semantic methods rather than arbitrary key/value or path/process commands;
- never return credentials or secret endpoint addresses;
- ensure subscriptions are removed when sender is destroyed;
- rate/bound diagnostics/log export operations.

### 33.4 Root adversarial suite

Minimum cross-platform test cases:

- `..` traversal before normalization;
- absolute native path inside approved root translates and succeeds;
- absolute native path outside root rejects;
- nested symlink/junction escaping root rejects;
- approved root itself replaced with symlink/junction rejects as OXP_ROOT_CHANGED;
- root deleted rejects clearly;
- root renamed externally rejects until re-approved unless filesystem-identity design proves safe relocation;
- missing final path allowed only for create/mutation flows;
- UNC/network path rejects on Windows;
- whole-drive/whole-filesystem approval rejects;
- overlapping roots reject;
- case-insensitive containment behavior on Windows;
- root alias collision is deterministic and case-safe;
- alias rename cannot retarget RootID;
- removing root while mutation is planned prevents commit.

### 33.5 Mutation race oracle

For edit/patch/file receive:

    authorize plan
      -> capture/resolve
      -> lock
      -> re-read current bytes/identity
      -> revalidate grant/root
      -> rebuild/refuse stale plan
      -> atomic commit
      -> update grounding/events

Tests must inject concurrent file modifications between every meaningful boundary.

A rollback may restore only a preimage that OXP itself just wrote and can still prove unchanged; it must never overwrite a newer third-party edit.

### 33.6 Process ownership oracle

OXP-owned processes must carry typed ownership independent of PID:

    owner = { kind: 'oxp', connectorID, invocationID/jobID, rootID }

Tests:

- PID reuse cannot grant control;
- process handle from another principal/profile rejects;
- root revocation kills owned process tree;
- process-grant revocation kills owned process tree;
- MCP request cancellation before handle commit kills child;
- cancellation after durable background handle commit leaves job governed by explicit handle policy;
- app Quit kills owned process trees;
- close-to-tray does not;
- stale job metadata after restart cannot be used to signal an unrelated PID.

### 33.7 Tunnel recovery oracle

Port standalone tests around:

- bad tunnel ID/API key => terminal auth-failed without hot retry loop;
- local endpoint unavailable => tunnel not launched;
- network outage => offline status after confirmation window, client remains recovery owner;
- one missed readyz probe => no tunnel kill;
- sustained local unready => one replacement owner;
- child exits => bounded restart/backoff;
- stop racing reconnect => stopped state wins;
- endpoint generation changes => stale tunnel callbacks cannot kill/relabel new generation;
- sidecar exit => tunnel stopped, fresh endpoint + reconnect;
- application Quit => no child tunnel remains.

### 33.8 Secret-store oracle

Bring standalone LocalMCP's tests with the implementation.

Critical races:

- concurrent get + set cannot republish stale decrypted cache;
- concurrent mutations serialize;
- clear/delete invalidates in-flight decrypt generation;
- malformed/unreadable ciphertext blocks mutation rather than becoming `{}`;
- Linux basic_text/v10 fallback is detected from ciphertext and refused;
- renderer never receives plaintext in successful or error paths;
- secret values are redacted from logs/exceptions.

### 33.9 Supervision/delegation authority oracle

Tests must prove:

- supervision list cannot reveal Sessions outside approved roots/policy;
- direct SessionID for an unauthorized target rejects even if the ID exists;
- fork/child Session location authority is evaluated from durable Session truth, not caller metadata;
- a supervisory send/turn/pause/resume/abort is attributed to the external OXP actor targeting the Session, never to its resident agent;
- public MCP input cannot forge OXP external-agent or human provenance;
- delegated worker model/agent choice obeys exact user-authorized policy;
- worker creation is impossible when delegation is disabled;
- nested worker creation cannot widen `nestedDelegation=false`; 
- a worker created through delegation has real native Session identity and normal native permissions;
- native Permission/Question requests are surfaced only for Sessions allowed by `sessionSupervision` and `requestSupervision`; 
- connector grants never auto-answer native permissions;
- root/supervision revocation prevents further supervision without corrupting the native Session;
- delegation revocation prevents new/continued delegation according to commit semantics without rewriting already completed worker history.

### 33.10 External MCP oracle

Tests must prove:

- integration list/describe never widens runtime call authority;
- same-name tools from multiple MCP servers cannot silently route ambiguously;
- server reconnect/schema changes do not change OXP top-level fingerprint;
- stale describe schema is revalidated against live canonical tool before call;
- integration disconnect yields OXP_INTEGRATION_OFFLINE;
- mutating external call failure is treated as potentially ambiguous and does not blind-retry.

### 33.11 Schema/cache oracle

Generate the exact canonical OXP manifest in tests and assert:

- deterministic serialization/fingerprint;
- permission toggles do not change fingerprint;
- root changes do not change fingerprint;
- tunnel state does not change fingerprint;
- providers/models/sessions/workers do not change fingerprint;
- external MCP catalog changes do not change fingerprint;
- changing a declared direct schema intentionally changes fingerprint.

Keep a checked-in golden fingerprint only after the v1 surface freezes. Before freeze, compare normalized manifest snapshots in review rather than making iteration artificially painful.

---

## 34. Implementation roadmap with hard gates

### Gate A — no-runtime contract tranche

Implement only types/services with no listener/tunnel and no user-visible behavior:

- OXP schemas/errors;
- core config parser/store;
- root authority/canonicalization;
- grant/revision service;
- CapabilityContext/result contracts;
- unit tests for root/grant/revocation.

Acceptance:

- no new process/listener;
- no new startup Instance construction;
- no renderer API yet;
- root adversarial suite green.

### Gate B — in-process read-only capability tranche

Implement OXP capability registry + shared executors for:

- read;
- find;
- project;
- capability list/describe for safe read-only entries.

No MCP endpoint yet. Exercise them through direct service tests.

Acceptance:

- no fake Session/Message creation;
- explicit root/workspace required;
- output bounds identical or better than standalone;
- read-grounding captured;
- benchmark adapter/executor overhead separately from filesystem IO.

**Implemented Gate B status (2026-09-19):** the in-process read-only slice now has direct `OxpRead`, `OxpFind`, and `OxpProject` services plus an `OxpCapability` registry/broker for compact list/describe/call testing. `read` and the native `ReadTool` converge on `src/read/filesystem.ts` for bounded line/window/tail/sample/binary behavior; `find`/native glob+grep converge on `src/search/filesystem.ts`; project orientation converges on `src/project/inspection.ts`. No MCP endpoint or workspace Instance is introduced by these services.

The Read extraction deliberately keeps **Instruction/AGENTS injection and LSP outline warming native-Session-only**. Direct OXP read has no resident Session, so it returns filesystem truth only; it does not manufacture Session messages, resolve Session instructions, or warm LSP as a side effect. OXP stale-read evidence is instead captured in a bounded connector+root namespaced `OxpGrounding` cache, never in the Session-keyed native `globalReadCache`.

Supported image/PDF reads return typed OXP attachment handles using virtual approved-root paths rather than embedding native absolute paths or eagerly constructing data URLs. The later MCP adapter remains responsible for independently reauthorizing/materializing those handles at the transport boundary.

Gate B cancellation is propagated into the shared streaming read primitive, process-backed search, and project inspection. Direct regression tests now prove already-cancelled read, find, and project calls all fail as `OXP_CANCELLED`. All read/find/project results perform live egress revalidation before external projection.

The provider-account correctness requirement discovered during Gate B is now frozen separately in the OXP model-selection contract: `{ providerId, modelId, accountId?, variant? }`, with account-qualified provider model IDs treated only as an internal adapter ABI. Explicit account selection may fail, but must never silently rotate to another credential; omission is the only automatic-routing authorization.

### Gate C — local MCP endpoint tranche

Port/adapt LocalMCP v2 server endpoint into `packages/opencode/src/oxp/server.ts`.

Expose only Gate B capabilities plus compact status/info necessary for testing.

Acceptance:

- 127.0.0.1 ephemeral listener;
- random secret path;
- host/origin/body hardening;
- stable tools/list pagination/fingerprint;
- tools/call live authority recheck;
- cancellation;
- no tunnel yet;
- integration test talks MCP directly over loopback.

**Implemented Gate C status (2026-09-19):** the dedicated MCP listener is live in packages/opencode/src/oxp/server.ts and remains independent of the ordinary OpenFork HTTP server. It binds only 127.0.0.1:0, creates a fresh 32-byte base64url secret route per start, validates Host/Origin/path/method/content length, bounds streamed request bodies, drains rejected oversized chunked bodies without retaining them, bridges client disconnect to cancellation, and creates request-scoped stateless MCP transports. The protected-resource metadata endpoint is GET-only and drains unexpected request bodies. Endpoint stop is single-flight/joinable: concurrent stop callers wait on the same listener-retirement proof instead of one returning early.

Runtime roots/grants/provider/session state still do not churn `tools/list`; the canonical fingerprint is derived only from the fixed versioned surface. **Current worktree truth differs from the earlier Gate-C-only snapshot because concurrent Gate G edit/patch work landed during this B–F audit:** the live fixed surface is now seven tools and serializes to 8,489 bytes, about 36.3% of the recorded 23,400-character standalone planning baseline. That Gate G surface expansion was not introduced or counted as B–F implementation work here. The explicitly enumerated pre-G/B–F OXP verification set is 81/81 green across 17 files and 2,516 assertions.

### Gate D — sidecar/main OXP transport coordination tranche

Extend sidecar utility-process protocol with typed persistent OXP events/requests.

Main gets:

- endpoint generation descriptor;
- redacted OXP status;
- start/stop/revoke operations.

Acceptance:

- no secret endpoint data reaches renderer;
- sidecar restart creates new generation/token;
- stale generation events ignored;
- ordinary OpenFork HTTP server remains semantically independent.

**Implemented Gate D status (2026-09-19):** the existing utility-process sidecar now owns a closed typed OXP request/event union; no generic sidecar RPC bridge was introduced. Sidecar OXP restore runs only after ordinary HTTP readiness and optional OXP failure does not fail the ordinary server. Electron main validates every privileged OXP state before consuming it: connector/root IDs must be UUIDs, aliases obey the root-alias grammar, config revisions are positive, ready surface fingerprints are exact 64-hex values, ready endpoint descriptors are exact `http://127.0.0.1:<port>/mcp/<43-char token>` plus a same-origin/same-token protected-resource metadata URL, and stopped/error states cannot smuggle endpoint URLs or fingerprints.

Desktop endpoint generation is monotonic across sidecar epochs and rejects both stale local generations and older sidecar epochs. A connect attempt captures the desktop endpoint generation it started against; callbacks and the returned tunnel handle are rejected if that identity changes before installation, closing the old-secret-URL in-flight connect race. Live endpoint changes invalidate both installed and starting tunnel generations, retire the old tree, and reconnect only after retirement succeeds. Replacement sidecars remain observable even when an old tunnel tree is retained fail-closed. Controller shutdown closes admission before draining prior serialized work so a late renderer action cannot create a new endpoint/tunnel behind Quit teardown. Sidecar request publication also removes its pending request/timer immediately when utility-process `postMessage` fails synchronously.

### Gate E — Secure MCP Tunnel tranche

Port OpenAI tunnel supervisor + secure secret store into desktop OXP owner.

Acceptance:

- real packaged Windows tunnel smoke test;
- auth/offline/recovery tests;
- exactly one tunnel-client process tree;
- no secret argv/log exposure;
- secureStorage fallback hardening preserved;
- sidecar restart converges automatically.

At this gate OXP becomes usable from ChatGPT for read-only repo work.

**Implemented Gate E status (2026-09-19):** Electron main owns one tunnel supervisor and the OpenAI credential. The pinned OpenAI tunnel-client is v0.0.14 with platform/arch SHA-256 verification, release `--version` verification, license/NOTICE/SBOM evidence, and packaging outside app.asar. The supervisor keeps API key and secret MCP URL in child environment only and now constructs the child environment from an explicit process/TLS/proxy allowlist instead of inheriting arbitrary Electron/provider credentials. Regression coverage proves unrelated OpenAI-provider, Anthropic, AWS, sidecar-password, and arbitrary private environment variables are not forwarded.

Health discovery accepts only a bounded exact `http://127.0.0.1:<port>` origin; health response bodies and structured child log records are byte-bounded before parsing. Local `/readyz` success is not remote-route proof: `connected` now requires an actual successful OpenAI control-plane poll timestamp, while zero/absent successful polls remain `starting`. The supervisor distinguishes sustained control-plane outage from local process failure, treats auth rejection as terminal, uses one restart owner with bounded backoff, and retains ownership when directed process-tree retirement cannot be proven. Windows directed shutdown uses `taskkill /T /F`; Unix uses detached process-group TERM -> KILL with bounded liveness proof. Real child-process tests exercise healthy remote-route proof, parent+descendant teardown, terminal auth failure without hot retry, one-owner crash recovery, stop-vs-reconnect ordering, stale-route offline projection, and no-connected-before-first-poll behavior.

The secure credential store is independently tested for async safeStorage availability, Linux basic_text/v10 ciphertext rejection, serialized full read-modify-write, single-flight decrypt, generation invalidation on delete, malformed-ciphertext fail-closed mutation, unknown-field preservation, and re-encryption. Renderer IPC has a browser-safe error projector; privileged sidecar startup/control errors are additionally prevented from reflecting secret loopback routes. Diagnostic export strips native approved-root paths and replaces the configured tunnel ID with presence-only information.

**Packaged Windows evidence:** a fresh `bun run build` completed successfully from the final audited source state; `electron-builder --win --dir --config electron-builder.config.ts` produced `dist/win-unpacked`; `scripts/verify-oxp-package.ts dist` verified the packaged `resources/tunnel/tunnel-client.exe` plus LICENSE/NOTICE/license inventory/SPDX sidecars. Direct execution of that packaged binary reports `0.0.14`, git SHA `0f870e50a973fa820d4c409000059e181e8d242b`. The builder emitted the unrelated existing warning that `packages/desktop/native` is absent, but exited successfully and the packaged runtime verification passed.

### Gate F — first-party desktop UX tranche

Add typed `window.api.oxp`, Platform.oxp, and dedicated V2 settings page.

Acceptance:

- desktop only;
- push-driven state;
- native root picker -> sidecar validation flow;
- no secret fields in browser-safe DTO;
- enabling/disabling/revocation affects runtime immediately;
- disabled idle cost remains near-zero.

**Implemented Gate F status (2026-09-19):** desktop exposes a dedicated typed `window.api.oxp` namespace and shared `Platform.oxp`; web/PWA receive no OXP platform. The V2 settings page is push-driven and rejects stale async projections by monotonically increasing `stateRevision`. Native folder selection happens in Electron main and the sidecar remains the canonical root validator. API-key plaintext and secret endpoint/metadata URLs never enter the renderer DTO. The current B–F UI promotes only the certified augmentation controls from this tranche; supervision/delegation remain explicitly policy-only. Concurrent Gate G edit/patch backend work is now present in the worktree, but Gate G is not closed and this B–F audit did not promote that moving backend tranche into the desktop settings contract.

Disabled core OXP state now uses a deliberately small Config/Root runtime rather than constructing the active capability/Ripgrep/process graph merely to restore or render Settings. Activation disposes that idle Config cache before constructing the active server runtime, so there is never a pair of competing OXP config caches. Enabled and connected are mechanically separate: disabling revokes authority and retires the local endpoint, while Disconnect is transport-only and deliberately leaves an enabled local OXP endpoint ready.

Application Quit now has one teardown barrier: Electron prevents normal quit until OXP tunnel retirement and sidecar teardown finish; close-to-tray remains a window lifecycle action rather than Quit. Desktop non-secret config serializes the complete read-modify-write transaction so concurrent lifecycle/tunnel setting changes cannot lose fields.

**Current verification snapshot:** explicitly enumerated pre-G/B–F `packages/opencode` OXP suite: **81 pass / 0 fail / 2,516 assertions across 17 files**. Desktop OXP + sidecar protocol: **57 pass / 0 fail / 207 assertions across 9 files**. Native shared read/glob/grep/find/project compatibility: **89 pass / 0 fail / 303 assertions across 5 files**. WorkBuddy provider-routing regression suite: **42 pass / 0 fail / 274 assertions**, including explicit forbidden-account selection failing on that exact account with no substitution. The production Electron build completes successfully.

Full `packages/opencode` typecheck is currently blocked by unrelated/concurrent SPAD, provenance/session, control-plane/API, and test-fixture changes; concurrent Gate G edit-rails tests are also moving independently. Full Desktop typecheck is blocked by unrelated concurrent `packages/app` React/context/test typing failures. Neither compiler run emitted a B–F `src/oxp` implementation diagnostic. The B–F verification count above deliberately excludes direct concurrent Gate G `edit.test.ts` / `patch.test.ts` so ownership of evidence remains explicit.

**Remaining external verification, not an implementation claim:** a real authenticated ChatGPT/OpenAI control-plane connection requires an actual tunnel ID/API key and is therefore not represented by the fake-client supervisor tests or the packaged --version smoke. Gate E's local auth/offline/restart/process-tree state machine is covered; remote OpenAI account/control-plane acceptance remains environment-dependent evidence.

### Gate G — mutation tranche

Extract/shared executors for edit + patch, then Git.

Acceptance:

- stale-read and concurrent-edit test oracles;
- commit-time grant/root revalidation;
- atomic writes;
- conditional rollback;
- Git typed read/write classification;
- no broad shell substitution for Git.

**Gate G progress (2026-09-19): edit + patch mutation owners are now live; Git remains.** OxpEdit reuses the native precision edit planner/matcher and the shared atomic-write primitive without manufacturing a Session or Tool.Context. It requires explicit approved-root addressing, performs live write admission, uses connector/root read-grounding when present, serializes same-file mutation, re-reads/revalidates under the file lock, revalidates grant/root authority immediately before commit, and atomically publishes the replacement. Grounded external changes hard-conflict; ungrounded concurrent changes are rebuilt against current bytes rather than blindly overwritten.

OxpPatch now owns direct multi-file patch semantics for both native OpenFork patch syntax and translatable unified diffs. One explicit RootID scopes the entire operation; absolute/escaping paths and pre-existing add/move destinations are rejected through the canonical root authority. Planning is mutation-free when apply:false. Apply performs a whole-plan compare-and-swap check under sorted multi-file locks before the first write, commit-time authority revalidation, sibling-temp atomic publication, and conditional rollback. Rollback restores a file only while it still matches the state this OXP invocation published, so a newer concurrent writer is never overwritten. Move journaling begins immediately after destination publication, closing the destination-written/source-delete-failed partial-move seam. Successful mutation refreshes/removes connector-scoped grounding without introducing Session identity.

The permanent MCP surface now contains eight tools after Git landed. Current packages/opencode/test/oxp verification is **93 pass / 0 fail**. Scoped TypeScript checking reports no OXP-file diagnostic; the remaining compiler diagnostics are pre-existing/concurrent repository errors in control-plane/session/SPAD/archive/tool dependencies. Gate G is therefore **not closed**: the final Gate G closeout should add adversarial injected-failure coverage for conditional multi-file rollback rather than treating the current happy-path/authority/path tests as exhaustive.

**Gate G Git continuation (2026-09-19):** concurrent work has now landed the missing shared typed Git owner in packages/opencode/src/git/typed.ts plus the OXP adapter in packages/opencode/src/oxp/git.ts. OXP Git is explicitly rooted at one approved RootID and additionally requires that approved root itself equal Git's resolved worktree root. Read and write classification is semantic: status/summary/diff/log/show/help and restricted shell are read-only; stage/unstage/restore are writes; commit is read-only while dry-run remains true and mutating only for the explicitly confirmed real commit. Every real mutation invokes commit-time OXP grant/root revalidation immediately before the Git write command. Restricted shell retains a read-only subcommand allowlist plus forbidden global/write options rather than exposing a generic shell escape. Direct regression coverage proves read+stage operation without Session manufacture, commit dry-run versus confirmed mutation, exact-root confinement, and Git-grant independence. The public status projection now truthfully exposes the executable Git grant, and server instructions identify the live direct patch/Git surface.

### Gate H — process tranche

Introduce typed OXP process/job ownership and one process tool.

Acceptance:

- one ShellLaunch owner;
- foreground/background semantics;
- explicit handles;
- process tree kill;
- root/process revocation;
- no fake session owner;
- no PID authority.

**Gate H implementation progress (2026-09-19):** the first direct process owner now exists in packages/opencode/src/oxp/process.ts and is wired through the fixed MCP surface/capability broker. It reuses ShellLaunch as the single shell interpreter/transport planner and AppProcess/CrossSpawnSpawner as the process-tree spawn/kill owner; it does not construct a Tool.Context or fake Session. Start requires process authority plus one explicit approved RootID, and optional workdir resolution is confined through OxpAuthority. Handles are opaque proc_* capabilities bound to connector identity + RootID rather than PIDs. Foreground start yields for bounded time and returns either terminal output or the same explicit live handle; background start returns immediately. Poll/status/list/wait/kill/remove operate on owned handles, with bounded retained output and no native root path in projections.

Process revocation is active: disabling OXP, removing process authority, changing connector identity, or removing the owning root retires matching live process trees through the shared ChildProcess handle kill path. OXP runtime finalization also retires all remaining owned trees. Focused Gate H tests prove foreground execution, opaque non-PID handles, active process-grant revocation, independent process grant enforcement, and workdir path-escape rejection. The full OXP suite is now **96 pass / 0 fail** and the fixed manifest is **9 direct tools / 12,493 bytes / 53.4% of the recorded standalone planning baseline**, still below the <=14-tool and <=75% stretch budgets.

Gate H is **not yet closed**. The current first slice deliberately omits interactive stdin/write and durable background-log recovery semantics; those require a protocol-neutral live-process/job owner rather than smuggling Session-scoped ShellJobs into OXP. Root revocation is enforced from config removal immediately, but an approved root becoming unavailable/replaced without config mutation still needs an active lifecycle oracle for long-running jobs. Those seams must be closed before claiming the complete Gate H acceptance contract.

### Gate I — existing-Session supervision tranche

Implement `openfork_info`, `openfork_session`, and `openfork_request` directly over OpenFork services.

Acceptance:

- no LocalMCP OpenCode Control HTTP hop;
- every operation classified as supervision/discovery, not resident-agent execution;
- root/target-Session filtering;
- external-actor -> target-Session provenance for durable effects;
- no resident-agent impersonation;
- list/get/messages/children/pause/resume/abort semantics grounded in native Session truth;
- native Permission/Question semantics preserved;
- request replies require `requestSupervision`; connector grant never auto-answers native permission;
- supervision revocation prevents further control without corrupting the target Session.

**Gate I certification (2026-09-19): CLOSED.** The fixed OXP surface now projects native Session discovery/control and native Permission/Question supervision directly, without the LocalMCP OpenCode Control hop or a backing Session for the OXP principal. Session lookup/control is filtered through approved-root + `sessionSupervision` authority; request enumeration/replies additionally require `requestSupervision`. Durable supervisory turns and selection changes use canonical `oxp.supervisor` host provenance with external correlation identity, while Permission/Question reply events carry typed external-actor attribution instead of impersonating the resident agent.

Certification deliberately exercised producers rather than only adapters. OXP request tests are **5/5**, server tests **7/7**, Gate-I architecture-boundary tests **7/7**, and the complete OXP suite is **122/122**. Native Permission tests prove external attribution survives the `always` reply cascade; native Question tests prove answer/reject attribution; Core Session tests prove provider/model/**account**/variant selection plus OXP provenance survives the durable Session event/projection. That last oracle exposed and fixed a real Core read-side bug: `SessionInfo.fromRow()` and the search projection were dropping `accountID` even though the Session row/event retained it. The fix is at the Core projection owner, not an OXP compensation layer.

### Gate J — delegated-worker tranche

Implement `openfork_worker` directly over OpenFork worker/Session/group services.

Acceptance:

- explicit delegation operation classification;
- no backing Session is created for ChatGPT itself;
- worker start creates a real subordinate OpenFork Session;
- returned worker/group handles are durable explicit objects;
- external-actor -> delegated-worker causal lineage;
- user-authorized model/agent policy;
- `nestedDelegation` enforced independently;
- wait/result/continue/cancel and batch operations;
- durable delegated-worker recovery;
- cancelling an MCP request after worker-handle commit does not ambiguously erase the worker.

**Gate J certification (2026-09-19): CLOSED.** Delegation is now implemented through the lower native owners rather than the resident-agent `task.ts` adapter. `openfork_worker` sits above an abstract worker-control port; its V1 adapter lazily enters the workspace runtime only for executable operations and then reuses real Session creation, SessionPrompt durable admission/execution, SessionExecutionOwner/SessionRunState, BackgroundJob only as process-local execution state, and SessionGroup `kind="delegation"`. No backing Session is manufactured for ChatGPT, no Tool.Context is fabricated, and the durable worker handle is always the native worker **SessionID**.

Core has one bootstrap-free delegation inspection owner, `SessionDelegationInspection`, for durable worker and delegation-group reads. It projects the protected producer-owned `workerDelegation` metadata envelope plus SessionExecutionOwner state directly from SQLite; the duplicate delegated-worker query path formerly living in generic `SessionInspection` was removed. The envelope preserves producer/principal/invocation/root identity, exact agent + provider/model/**account**/variant policy, nested-delegation policy, and optional parent-worker identity. Native task descendants inherit the canonical policy while their turn provenance correlates to the originating OXP invocation, not merely the broad principal. Legacy `metadata.localMcp` remains compatibility-read-only and is not the new origin authority.

Authority is revalidated at the last durable commit boundary. Start, continue, batch start, and batch continue recheck current delegation/root authority and current user-authorized model/agent policy; nested delegation additionally requires its independent live grant. Durable `rootRef` identity is matched against the currently approved RootID, so remove/reapprove cannot silently retarget an old worker. Explicit `accountID` remains exact routing intent. Batch identity is a native SessionGroup bound to principal + durable root + invocation. Partial start/continue/cancel failures preserve every already-committed worker SessionID and, where applicable, the committed group ID rather than implying rollback.

Restart/recovery no longer treats BackgroundJob as durable truth. When process-local job state is absent, delegated-worker snapshot/wait reconstruct from protected Session history plus SessionExecutionOwner generation/ownership; durable ownership projects `running`, while an admitted user turn with no owner is recoverable. Cancellation observed after Session/prompt/group commit returns explicit committed handles. Certification is **149/149 OXP tests**, including **10/10 Gate-J architecture-boundary tests** and **9/9 delegated-worker domain tests**, plus a Core executable delegation-inspection test proving protected-origin filtering and idle -> owned generation -> released execution projection without workspace bootstrap. The fixed surface remains within budget at **12 direct tools / 17,203 bytes / 73.52%** of the recorded standalone planning baseline.

### Gate K — external MCP + long-tail augmentation tranche

Wire OXP capability broker to OpenFork MCP.Service and OXP-safe native augmentation capabilities.

Acceptance:

- no second MCP client manager;
- no top-level schema churn;
- list/describe/call ambiguity handling;
- external mutation retry discipline;
- brokered operations remain augmentation unless explicitly defined as another plane;
- resource/prompt behavior explicitly decided.

**Gate K certification (2026-09-19): CLOSED for external MCP tool brokering.** OXP now projects OpenFork's existing location-scoped `MCP.Service` through the already-fixed `capability` gateway under `namespace="mcp"`; it does not create a second MCP client/plugin manager and does not add a top-level tool. Every MCP discovery/describe/call requires an explicit approved RootID plus live `integrations` authority. The V1 adapter enters the existing location runtime lazily, so OXP startup/listing does not hydrate MCP clients merely because the connector exists.

The native MCP owner now exposes a narrow exact-tool catalog and exact invocation primitive in addition to its legacy flattened provider-facing projection. Exact identity is `{server, native tool name}`, and OXP canonical capability IDs percent-encode both components as `server/tool`; this prevents sanitized-name collisions. Native MCP lifecycle tests explicitly prove that two server names which collapse to the same legacy sanitized provider key remain distinct through `exactTools()`, and that `invokeTool()` targets exactly the requested server. Bare tool names are accepted only when unique and otherwise fail with explicit canonical candidates. Describe returns the live native input schema plus a broker contract fingerprint; schema churn invalidates stale contracts without changing the fixed top-level MCP manifest.

External MCP execution performs exactly one native invocation. OXP deliberately does **not** trust MCP `readOnlyHint` as mutation or retry authority: it is retained only as informational `declaredReadOnlyHint`, while every external MCP tool call is conservatively treated as potentially mutating until a future trusted per-tool policy exists. Any failure after invocation begins therefore projects `OXP_AMBIGUOUS_EXTERNAL_RESULT` and is never automatically retried. Live integrations/root authority is revalidated at the final network commit guard, and non-object call arguments fail locally before network execution. Non-text MCP payload bytes are not blindly copied into ChatGPT text output; structured content remains structured and omitted non-text items are counted. MCP prompts/resources are deliberately **not** projected in Gate K: tool brokering is the supported v1 integration surface, while transferable resource/file semantics remain Gate L work.

Certification is **164/164 OXP tests**, including **5/5 Gate-K architecture-boundary tests** and **10/10 external-MCP broker tests**. The complete native MCP suite is **62/62**. The fixed surface remains **12 direct tools** and **17,212 bytes / 73.56%** of the recorded standalone planning baseline, below the 75% hard budget with restored headroom. Scoped TypeScript checking reports only the same 16 pre-existing/concurrent repository diagnostics outside the touched MCP/OXP files.

### Gate L — file exchange tranche

Port ChatGPT/OpenAI file receive/send semantics.

Acceptance:

- independent receive/send grants;
- OS-secure credential path;
- stable source-file checks;
- atomic local publication;
- signed URL/API-key separation;
- ambiguous upload recovery.

### Gate M — standalone replacement tranche

Add tray/start-hidden/launch-at-login/close-to-tray and one-way LocalMCP config migration.

Acceptance:

- OXP survives window close when configured;
- explicit Quit tears everything down;
- login startup works packaged;
- importer never moves plaintext secrets;
- standalone connector can be disabled after successful OXP verification.

### Gate N — closeout

Run packaged soak + performance/security matrix across augmentation, supervision, and delegation.

Do not call OXP a standalone LocalMCP replacement until all replacement blockers pass.

---

## 35. Quantitative acceptance plan

### 35.1 Startup/idle budget

Measure against the same OpenFork build with OXP feature code present but disabled.

Disabled target:

- 0 OXP listener sockets;
- 0 tunnel processes;
- 0 periodic OXP timers;
- 0 workspace Instances;
- no provider/MCP catalog hydration;
- no measurable startup regression beyond module-registration noise; target <1 ms median main-thread work attributable to OXP and <1 MiB steady RSS, then tighten with data.

Enabled but disconnected target:

- one loopback MCP listener;
- no tunnel process;
- no workspace Instances until request;
- no per-root filesystem watchers;
- no provider/MCP catalog hydration until requested.

Connected idle target:

- exactly one tunnel-client tree;
- only the proven bounded health/recovery timers;
- no renderer polling;
- no workspace/session polling.

### 35.2 Call-path budget

Benchmark median/p95 over warm runs:

- tools/list first + cached;
- OXP admission/root resolution;
- read 100 lines from warm filesystem cache;
- find small/medium repo;
- project summary;
- capability list;
- capability describe;
- no-op denied call;
- existing-Session supervision list projection;
- delegated worker start + wait handle path.

Record both total wall time and OXP wrapper overhead by instrumenting around the underlying executor.

Initial design target: OXP admission/projection overhead should be sub-millisecond median for pure in-process calls and should not dominate filesystem/tool work. Treat data, not this provisional threshold, as release authority.

### 35.3 Manifest budget

Standalone live connector baseline observed during planning:

- 21 direct tools;
- approximately 23.4k characters in the harness tool metadata/schema descriptions.

OXP v1 target:

- <=14 direct tools;
- <= standalone canonical serialized manifest bytes;
- stretch target <=75% of standalone prefix size;
- common coding traces do not materially increase model tool-call count due to broker use.

### 35.4 Concurrency matrix

Test:

- 1, 3, 6 concurrent direct reads/finds;
- 1, 3, 6 concurrent supervision reads/controls across existing Sessions;
- 1, 3, 6 concurrent delegated worker turns;
- concurrent mutation on same file;
- concurrent mutation on different files;
- background process + worker + filesystem calls;
- connector disable during each category;
- root removal during each category;
- sidecar restart under idle and active calls.

Track CPU, RSS, event loop delay, SQLite writer occupancy where session operations are involved, and spawned process count.

### 35.5 Success criterion

OXP is successful only if unification produces a measurable architectural gain:

- smaller or no-larger permanent ChatGPT tool prefix;
- no duplicated MCP client/process/toolchain runtimes;
- lower setup/maintenance burden than standalone LocalMCP;
- equal or stronger root/secret/mutation security;
- direct augmentation capabilities plus explicit supervision of existing OpenFork Sessions and delegation into subordinate OpenFork workers, with truthful provenance throughout;
- near-zero disabled cost;
- no meaningful latency tax on common direct filesystem operations.

If integration merely embeds the standalone application inside OpenFork without deleting duplicated owners, it has failed the architectural objective.

---

## 36. Gate A exact implementation map

Gate A should be small enough to review as architecture, not hidden inside a giant feature patch.

### 36.1 Files to create first

Recommended minimal initial module set:

    packages/opencode/src/oxp/error.ts
    packages/opencode/src/oxp/schema.ts
    packages/opencode/src/oxp/config.ts
    packages/opencode/src/oxp/root.ts
    packages/opencode/src/oxp/authority.ts
    packages/opencode/src/oxp/context.ts
    packages/opencode/src/oxp/result.ts

Tests:

    packages/opencode/test/oxp/config.test.ts
    packages/opencode/test/oxp/root.test.ts
    packages/opencode/test/oxp/authority.test.ts
    packages/opencode/test/oxp/context.test.ts

Do not create `packages/opencode/src/oxp/index.ts` as a barrel if the directory contains multiple independent siblings. Follow AGENTS.md multi-sibling rules and import the specific module.

### 36.2 error.ts

Use Effect tagged errors, not string matching.

Initial classes should cover the enforcement distinctions already defined in section 26:

- InvalidArgument;
- AuthDenied;
- AuthRevoked;
- RootRequired;
- RootNotFound;
- RootChanged;
- PathEscape;
- Conflict;
- NotFound;
- HandleStale;
- Busy;
- Timeout;
- Cancelled;
- DependencyUnavailable;
- ProviderAccountUnavailable;
- IntegrationOffline;
- AmbiguousExternalResult.

Each error should have:

- stable internal/OXP code;
- bounded human message;
- optional non-secret metadata useful to protocol projection.

Do not put MCP response types in this file.

### 36.3 schema.ts

Own only OXP semantic data types:

- OxpConnectorID branded schema;
- OxpRootID branded schema;
- OxpInvocationID branded schema;
- OxpGrant;
- OxpRoot persisted shape;
- OxpConfig persisted shape;
- versioned config envelope;
- redacted/public root shape if needed by sidecar APIs;
- `OxpPlane = augmentation | supervision | delegation`;
- augmentation authority classes plus supervision/delegation policy enums.
- bounded provider/model/account/variant selection shape for supervision/delegation adapters; provider-account identity remains separate from `modelID`.

Use Effect Schema and explicit size/pattern bounds.

Do not place Electron lifecycle/tunnel config or secrets in the sidecar OxpConfig schema.

### 36.4 config.ts

This is a process-global Tier 0 service, never InstanceState.

Dependencies:

- `@opencode-ai/core/global` for `Global.Path.config`;
- `FSUtil.Service` / Effect FileSystem for IO;
- `EffectFlock.Service` for cross-process serialization;
- Effect Scope only if a future subscription needs cleanup.

File:

    Global.Path.config/oxp.json

Requirements:

- schema version;
- absent file -> safe defaults;
- malformed file -> fail/read as disabled-safe state, but do not silently overwrite it during mutation;
- stable connector ID generated once;
- monotonically increasing config revision;
- immutable snapshot returned to callers;
- serialized read-modify-write;
- atomic sibling-temp + rename commit;
- 0600 where meaningful/supported;
- subscribers receive the committed semantic projection only.

Important: existing `FSUtil.writeJson()` is not atomic. Do not reuse it directly for OXP authority configuration. Implement/extract one atomic JSON write primitive using Effect FileSystem, ideally at the lowest shared owner if another durable global config demonstrably needs it.

### 36.5 root.ts

Port semantics from standalone `src/main/sandbox.ts`, not its application structure.

Public service responsibilities:

- validate candidate root approval;
- allocate RootID/default alias;
- rename alias;
- remove root;
- resolve an OXP virtual/native/relative path to a canonical authorized path;
- resolve whole root by ID/alias;
- translate canonical native path -> virtual OXP spelling;
- verify root liveness/identity.

Do not own grant policy. Root service answers location/containment truth; OxpAuthority composes that truth with the OXP support grant. Augmentation capabilities, Session supervision, request supervision, delegation, and nested delegation remain distinct policy dimensions.

Prefer Effect FileSystem primitives; use platform/native helpers only where Effect's abstraction cannot expose the required link/reparse identity semantics.

### 36.6 authority.ts

Process-global Tier 0/1 service.

Responsibilities:

- read current committed config/revision;
- map OXP plane + operation + enforcement phase to the required grant;
- resolve requested root/location through Root service;
- return a typed authorization result/context;
- expose lightweight discovery decisions;
- provide revalidation at commit/spawn/egress/supervise/delegate/job-control phases.

Do not import:

- Provider;
- Agent;
- SessionPrompt;
- ToolRegistry;
- LSP;
- Snapshot;
- Plugin runtime.

Native Session permission composition belongs in the later **supervision** adapter; worker model/agent/nested policy belongs in the later **delegation** adapter. Direct augmentation calls do not have a native Session.

### 36.7 context.ts

Define protocol-neutral interfaces only:

- OxpPlane;
- OxpInvocation with explicit optional target;
- CapabilityContext;
- CapabilityAuthority interface;
- CapabilityProgress sink;
- CapabilityProvenance seed;
- ReadGrounding interface;
- OxpWorkspaceRef.

No concrete registry or MCP imports.

Keep constructor/admission helper allocation-light.

### 36.8 result.ts

Define `CapabilityResult` and structured error/result projection metadata independent of MCP and Tool.ExecuteResult.

Attachments must be typed enough that later MCP/native adapters can independently authorize/projection-check them.

Do not implement final model truncation here if the shared ToolOutputProjection owner can be used without dragging in session state. Gate B will decide the exact projection dependency after inspecting that service's runtime requirements.

### 36.9 Test oracles for Gate A

`config.test.ts`:

- defaults are disabled-safe;
- first creation generates stable connector ID;
- repeated read does not mutate;
- revisions increase exactly once per committed semantic mutation;
- concurrent mutations do not lose updates;
- write failure leaves old file intact;
- malformed existing config is not overwritten by an unrelated update;
- no secrets/tunnel API key fields are accepted/persisted.

`root.test.ts`:

- all section 33.4 path/root cases;
- Windows case behavior;
- missing suffix create resolution;
- root replacement/change detection;
- alias collision/rename;
- native-inside-root translation;
- no implicit relative location with multiple/no roots.

`authority.test.ts`:

- augmentation, supervision, delegation, and nested-delegation grants are independent;
- requestSupervision is distinct from sessionSupervision;
- filesSend independent from read;
- filesReceive requires receive + write;
- process/git independent classifications;
- config revision change causes revalidation failure where expected;
- root removal revokes;
- discovery visibility never substitutes for call authorization.

`context.test.ts`:

- contains no ambient Session/model/provider/resident-agent identity fields;
- an explicit target Session may appear only on supervision/delegation invocations;
- cancellation propagated by reference;
- workspace is only constructible from resolved root data;
- provenance seed cannot claim human/System authority from external connector input.

### 36.10 Gate A dependency ceiling

Gate A should not add production dependencies beyond modules already present in the OpenFork workspace.

It must not import the MCP server package yet.

It must not add Electron dependencies to `packages/opencode`.

It must not add database schema/migrations.

It must not modify generated clients/API schemas.

It must not create an HTTP route.

It must not initialize a workspace Instance.

### 36.11 Gate A performance proof

Add a microbenchmark or focused test probe for:

- parse/load already-cached config;
- authorize a direct read against one root;
- authorize against 8/32 approved roots;
- resolve a warm existing path;
- resolve a denied escaping path.

The root count lookup should not stay O(N) forever if measurement shows meaningful cost at realistic counts. A committed config snapshot can materialize immutable maps by RootID and normalized alias once per revision, keeping hot authorization lookups O(1) expected while filesystem canonicalization remains the dominant unavoidable cost.

Do not prematurely cache canonical realpaths across authorization calls unless the cache has an explicit invalidation/identity model; stale canonicalization can become an authority bug.

### 36.12 Gate B extraction order

Once Gate A is green, extract shared read-only execution in this order:

1. **Find/search primitive** — lowest semantic complexity and easiest no-session proof.
2. **Project inspection** — bounded metadata-only orientation.
3. **Read** — include grounding/binary/windowing semantics and explicitly decide whether LSP outline warming remains native-tool-only or belongs in shared read execution.
4. **Capability registry** — register those three OXP-safe definitions and the broker itself.

Do not start with ReadTool wholesale because its current dependency graph includes LSP, Instruction, Scope, and session-oriented grounding. Extract the actual filesystem/read/search semantics downward instead.

### 36.13 First code review boundary

The first production PR/slice should stop after Gate A.

Review questions:

- Did OXP create any workspace/runtime work while disabled? It must not.
- Did any file/session/model/provider concept leak into core config/authority unnecessarily?
- Are roots explicit external grants rather than inferred OpenFork projects?
- Can malformed config or a root replacement widen authority?
- Can revocation race a later commit?
- Is every durable config write atomic and serialized?
- Did we create a generic abstraction wider than OXP actually needs?

Only after those answers are mechanically strong should Gate B begin.