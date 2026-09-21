# OXP upstream authentication boundary

Status: **ACTIVE — normative implementation ledger**

Opened: 2026-09-20

Scope: ChatGPT/OpenAI parent -> OXP invocation behavior for operations that are
authentication-relevant.

This document is the source of truth for the current OXP credential/authentication
tranche. Update the implementation ledger in this file as work proceeds. Do not
reconstruct intent from old code, old tests, or older OXP plan text when they
conflict with this specification.

## 1. Problem statement

The problem is **not an OpenFork credential-management problem**.

OpenFork/OpenCode already has the authentication mechanisms required by the
features and upstream services it normally uses. Ordinary OpenFork sessions do not
need a new general credential tool, credential broker, generic secret registry,
credential-manager UI, or generic authenticated-HTTP subsystem to solve this OXP
issue.

The observed failure occurs one boundary earlier:

1. ChatGPT is the external parent agent.
2. ChatGPT formulates an OXP tool invocation.
3. For some authentication-relevant operations, the upstream ChatGPT/OpenAI layer
   can reject the proposed invocation **before it is sent to OXP**.
4. In that failure mode OXP receives no request and therefore cannot remediate,
   redirect, reject, or recover the operation at runtime.

Therefore the primary implementation problem is the **model-visible OXP contract
at the upstream parent boundary**.

The implementation must teach the ChatGPT parent, through OXP's registered tool
descriptions, server instructions, schemas, and capability prose, how to express
an authenticated operation in a form that can actually be invoked without asking
the parent to extract, transform, expose, forward, or synthesize credential
material.

## 2. Boundary model

```text
ChatGPT parent agent
        |
        |  upstream invocation admission
        |  <-- defect/constraint is here
        v
OXP model-visible contract
  - tool descriptions
  - server instructions
  - typed capability semantics
  - schemas / examples
        |
        |  only after the call is admitted
        v
OXP runtime
        |
        v
existing OpenFork capability/runtime
```

The critical negative fact is:

> OXP cannot fix, reroute, or return an actionable runtime error for an invocation
> that the upstream parent refuses to send.

Consequently, adding more OpenFork-side credential machinery is not a solution to
this failure mode.

## 3. Normative invariants

### 3.1 No new OpenFork credential product

This tranche MUST NOT create or imply a general OpenFork credential-management
product.

Specifically, this problem does not justify:

- a normal-session `credential` tool;
- a shared/general `CredentialBroker` for OpenFork sessions;
- a generic OpenFork secret registry;
- a generic OpenFork credential metadata catalog;
- generic `credentialRef` discovery for native agents;
- a generic authenticated-HTTP client owned by a credential subsystem;
- new provider/account credential semantics;
- a credential-manager Settings page;
- a user-visible credential inventory;
- UI for aliases, credential references, auth header names, bearer prefixes,
  origins, scopes, or similar broker internals;
- a new local secret lifecycle merely because OXP exists.

If code introduced for this tranche makes credentials look like an ordinary
OpenFork domain concern, that code is presumed architecturally wrong unless a
separate, independently approved feature requires it.

### 3.2 Normal OpenFork sessions are out of scope

Ordinary OpenFork agents/sessions MUST NOT gain a credential tool or credential
workflow as a side effect of fixing the ChatGPT -> OXP parent boundary.

Parent/child OpenFork credential sharing is also **not part of this problem**.
If delegated OpenFork sessions ever require explicit credential delegation, that
must be designed independently from first principles rather than inherited from
this OXP workaround.

### 3.3 No credential-manager UI

There MUST be no generic credential-management UI for this feature.

In particular, the OXP Settings surface must not ask a human to configure internal
broker mechanics such as:

- `credentialRef`;
- authentication header names;
- bearer/auth prefixes;
- generic service origins for a secret registry;
- secret aliases for agent discovery;
- generic create/edit/rotate/list flows.

Those controls are evidence that an upstream invocation problem has been
incorrectly modeled as a local password-manager problem.

### 3.4 Preserve legitimate, unrelated authentication owners

Removing the incorrect architecture MUST NOT break or conflate authentication
that already has a legitimate owner.

Examples include:

- OpenFork provider/account authentication;
- OpenCode Go/Zen authentication consumed by OpenFork;
- OXP connector/tunnel identity and the credentials required to establish that
  transport;
- purpose-specific credentials already required by an independently justified
  OXP capability such as OpenAI file exchange.

Those are separate domains. Their existence is not evidence that OpenFork needs a
generic credential broker.

### 3.5 Parent-facing prose is load-bearing behavior

For this problem, OXP's tool descriptions and server/capability instructions are
part of the behavioral contract, not decorative documentation.

They MUST make the boundary obvious to the parent agent:

- do not extract or print a locally stored secret;
- do not author shell/program code whose purpose is to read a secret and construct
  authentication;
- do not ask OXP to return secret bytes;
- prefer the existing high-level operation whose trusted implementation already
  owns authentication;
- express the intended authenticated action, not secret-handling implementation
  steps;
- when a purpose-specific OXP operation legitimately performs authenticated work,
  its model-visible schema should describe the operation rather than expose the
  secret plumbing.

The prose must be concise enough to remain effective in the permanent OXP tool
surface and specific enough to prevent the parent from choosing the known
pre-invocation failure path.

### 3.6 Do not disguise secret handling

The solution is not prompt obfuscation.

Do not attempt to bypass upstream invocation admission by:

- renaming obvious secret fields;
- encoding credential-access code;
- splitting extraction across multiple shell calls;
- hiding secret reads behind aliases;
- constructing equivalent authentication through less obvious syntax.

The correct abstraction is to avoid asking the parent to perform secret handling
at all.

### 3.7 Runtime guards are not the primary fix

An OXP runtime guard can only act on a request that actually arrived.

Therefore process/shell credential-routing guards, secret scanners, credential
brokers, or runtime redirection logic MUST NOT be justified as the solution to the
upstream pre-call failure.

Any such guard already introduced during this tranche must be audited:

- remove it if its only purpose was to compensate for the upstream pre-call block;
- retain it only if it has a separate, explicit security/product invariant that
  remains valid without the credential-manager architecture;
- document that independent invariant in the owning subsystem rather than in this
  spec.

## 4. What a correct OXP solution looks like

The default solution order is:

1. Identify the authenticated action the user actually wants.
2. Identify the existing trusted owner that already knows how to perform that
   action/authentication, if one exists.
3. Expose or reuse a high-level OXP operation that calls that owner without making
   ChatGPT author credential extraction or auth construction.
4. Make the parent-facing OXP prose/schema explicitly teach that route.
5. Empirically validate through the live ChatGPT parent that the invocation is
   admitted and reaches OXP.
6. Only add new privileged machinery when the operation itself genuinely lacks an
   owner, not merely because ChatGPT rejected a lower-level secret-handling command.

This is an **adapter-contract problem first**.

## 5. Explicit non-goals

This tranche does not attempt to:

- redesign OpenFork auth;
- unify every provider credential source;
- create a local secrets platform;
- expose arbitrary third-party API keys to OpenFork agents;
- add a password manager;
- add generic secret import/export;
- solve hypothetical child-session credential delegation;
- make shell a secret-injection API;
- work around upstream protections through payload tricks.

## 6. Relationship to older OXP planning

The older OXP architecture ledger correctly records the empirical observation that
an authentication-relevant model-authored command may be rejected by the ChatGPT
parent before OXP receives it.

However, any subsequent plan or implementation that responds by creating a
general local credential registry, native OpenFork credential tool, generic
credential broker, credential-manager Settings UI, or generic credential-bound
HTTP layer is **superseded by this specification**.

When old prose and this file disagree on that architecture, this file wins.

## 7. Implementation ledger

Ledger rule: update this table during implementation. A task is not complete until
the live tree and focused tests support the stated evidence.

| ID | State | Work item | Completion evidence |
| --- | --- | --- | --- |
| UAB-00 | DONE | Establish the corrected architectural boundary in a durable spec. | This file exists under `docs/specs` and is linked from the codebase map / OXP ledger. |
| UAB-01 | DONE | Inventory every credential-related source/test/UI/doc addition associated with the OXP pre-call workaround. | Scoped inventory below classifies each item as remove, retain-independent, or rewrite-parent-contract. |
| UAB-02 | DONE | Remove any normal-session OpenFork `credential` tool/broker introduced for this issue. | Native tool/registry/exposure and OXP catalog no longer expose a generic credential tool; rejected source modules/tests were removed. |
| UAB-03 | DONE | Remove generic OXP credential-manager UI and its dedicated CRUD/state plumbing. | OXP Settings has no generic credential inventory/editor; renderer/controller/IPC/preload prompt plumbing was removed while the purpose-specific OpenAI key UI remains. |
| UAB-04 | DONE | Remove generic local credential registry/broker/HTTP machinery introduced solely for this workaround. | Generic broker/registry/HTTP/sidecar secret-return paths are gone. Secure storage retains only a purge shim for obsolete registry entries plus independently owned purpose-specific secrets. |
| UAB-05 | DONE | Audit OXP process/shell credential-routing guards and secret-environment changes. | Workaround-only payload scanning/redirection was removed. Child-process secret-environment projection remains as an independent least-authority invariant and is tested separately. |
| UAB-06 | DONE | Rebuild parent-facing OXP auth-relevant prose around the pre-invocation boundary. | Server/tool/capability prose directs OpenAI Files authentication to direct `openai_files`; generic `capability` explicitly says not to route authenticated work through it when a purpose-specific direct tool exists. |
| UAB-07 | DONE | Preserve legitimate unrelated auth domains while removing the false generic architecture. | Provider/Go/Zen auth, OXP connector identity, tunnel auth, and the purpose-specific OXP OpenAI key remain separately owned; live OpenAI Files auth succeeded after cleanup. |
| UAB-08 | DONE | Remove/supersede stale docs/tests that encode the rejected credential-manager model. | Old OXP-plan credential-manager proposals are explicitly superseded; remaining `credentialRef`/old sidecar strings occur only in negative regression tests or rejection prose. |
| UAB-09 | DONE | Validate with focused unit/boundary tests. | Gate C/L 20/20, process/environment 16/16, capability 22/22, desktop credential store 10/10, desktop Gate D/E/F 19/19, sidecar protocol 3/3. Negative assertions cover the removed product surfaces. |
| UAB-10 | DONE | Validate through the live ChatGPT -> OXP path. | After refreshing the connector manifest, ChatGPT directly invoked `openai_files { action: "list", limit: 1 }`; OXP returned `Found 0 OpenAI files.` with structured action `list_openai_files`, proving admission and purpose-specific authentication without model-authored secret handling. |
| UAB-11 | DONE | Close out the tranche against this ledger. | All UAB rows are resolved. The only surviving credential-related behaviors are independently owned provider/tunnel/file auth, OS secure storage for the purpose-specific OXP key, obsolete-registry purge compatibility, and least-authority process environment projection. |

### 7.1 UAB-01 scoped inventory

`remove` — architecture created to compensate for the upstream pre-invocation failure:

- native-session `packages/opencode/src/tool/credential.ts` plus its ToolRegistry wiring;
- `packages/opencode/src/credential/{bridge,broker,request}.ts`;
- generic OXP `credential` capability/bridge and its capability-catalog/tool-coverage entries;
- generic Electron credential prompt host/controller/contracts/IPC/preload bridge;
- generic sidecar credential request/response protocol and desktop bridge routing;
- generic `cred_...` metadata/catalog, alias/service/header/prefix registry, secret CRUD, and credential-bound HTTPS execution;
- runtime process payload scanners/redirection whose only disposition is “use credentialRef”;
- tests and current-architecture prose that encode those surfaces.

`retain-independent` — separately owned behavior that remains valid without the rejected architecture:

- OpenFork provider/account authentication, including OpenCode Go/Zen credential ownership;
- OXP connector/tunnel identity;
- the OXP OpenAI API key used by the Secure MCP Tunnel and purpose-specific OpenAI Files exchange;
- OS-backed secure storage needed by that purpose-specific OXP OpenAI key;
- model-authored OXP process environment projection that prevents accidental inheritance of ambient host/provider secrets;
- provider/tunnel/file-exchange authentication owned by their existing purpose-specific adapters.

`rewrite-parent-contract` — model-visible surfaces that must teach the actual boundary:

- OXP server instructions;
- `process`, `capability`, and authenticated capability descriptions;
- file-transfer descriptions/schemas where authenticated OpenAI work is exposed;
- stale OXP planning prose that currently presents the generic credential product as the solution.

### 7.2 Closeout evidence

The final parent contract uses two distinct file-exchange projections over the
single authoritative `OxpFileExchange` owner:

- brokered `file.transfer` is limited to ChatGPT-native `save_chatgpt_file`
  ingress and performs no OpenAI API authentication;
- direct `openai_files` exposes only semantic `list|get|upload|download`
  operations. Its model-visible schema contains no credential, token, secret,
  authorization-header, origin, or API-key field.

The live failure that motivated this correction was reproduced against the
generic broker: ChatGPT rejected
`capability -> file.transfer -> list_openai_files` before OXP received the call.
After projecting the authenticated operation as direct `openai_files` and
refreshing the ChatGPT-side connector manifest, the same parent successfully
invoked `openai_files { action: "list", limit: 1 }`. OXP returned
`Found 0 OpenAI files.` with structured action `list_openai_files`.

Focused verification at closeout:

- OXP Gate C/L boundary + performance: 20/20;
- OXP process/environment: 16/16;
- OXP capability catalog/execution: 22/22;
- desktop purpose-specific credential store: 10/10;
- desktop Gate D/E/F boundary: 19/19;
- desktop sidecar protocol: 3/3.

The broad `test/oxp/server.test.ts` harness is currently prevented from starting
by a concurrent, unrelated System One test-layer fixture
(`@opencode/OxpSystemOneControl` is unbound). This does not affect the focused
UAB evidence above and is not counted as a UAB failure.

## 8. Required negative regression assertions

Closeout must include tests or structural assertions sufficient to catch recurrence
of the original architectural drift:

1. no generic credential manager in OXP Settings;
2. no generic native-session credential tool introduced by this feature;
3. no model-visible API that reads/returns arbitrary secret bytes;
4. no requirement for ChatGPT to author secret extraction/auth-header construction
   in order to perform an authenticated high-level OXP action;
5. no claim that a runtime guard solves a request rejected before OXP invocation;
6. legitimate OXP connector identity remains distinct from generic credentials.

## 9. Decision log

### 2026-09-20 — Corrected problem ownership

Decision: the credential/authentication failure under investigation is owned by
the **upstream ChatGPT -> OXP invocation boundary**, not by ordinary OpenFork
sessions or OpenFork credential storage.

Consequence: remove architecture introduced under the false assumption that
OpenFork needs a generalized credential subsystem to solve it.

### 2026-09-20 — UI disposition

Decision: there is no generic credential-manager UI.

Consequence: OXP Settings may expose legitimate OXP connection/trust configuration,
but not a generic password-manager/credential-broker product surface.

### 2026-09-20 — Implementation discipline

Decision: this file is the implementation ledger for the tranche.

Consequence: implementation work must update Section 7 as evidence is gathered;
completion is judged against these invariants rather than against the currently
implemented credential code.

### 2026-09-20 — Direct authenticated-operation projection

Decision: an authentication-relevant operation that the upstream parent cannot
reliably admit through a generic broker must be projected as a narrow,
purpose-specific OXP tool when a trusted owner already exists.

For OpenAI Files, `OxpFileExchange` remains the authoritative owner.
`openai_files` is the parent-facing authenticated adapter; brokered
`file.transfer` is limited to ChatGPT-native file intake. The direct adapter
calls the authoritative owner rather than recursively routing through the generic
capability broker.

Live evidence: after the connector manifest refresh, ChatGPT admitted
`openai_files { action: "list", limit: 1 }` and OXP returned a valid authenticated
OpenAI Files result without any model-authored secret handling.
