# Gate P producer, privacy, and safe projection contract

## 1. What may be persisted

Always-safe structural fields:

- local activity/invocation IDs;
- pseudonymous correlation digest;
- correlation scheme;
- operation plane;
- tool/action names;
- approved root ID/alias;
- start/end timestamps;
- observed epoch number;
- terminal status and stable OXP error code;
- mutation attempted/committed truth;
- native resource IDs that are already durable OpenFork identifiers;
- bounded operation-specific safe summaries.

## 2. What must never be generically persisted

- raw upstream correlation IDs;
- ChatGPT/user prompt text;
- OpenAI API keys;
- tunnel credentials;
- secret OXP endpoint URLs;
- provider/plugin credentials;
- process environment;
- arbitrary command environment overrides;
- arbitrary raw MCP arguments;
- arbitrary raw MCP results;
- signed file URLs;
- raw file contents;
- full patch bodies;
- full process stdout/stderr;
- hidden system instructions.

## 3. Projection ownership

Every OXP operation family owns a safe activity projector.

Examples:

### Read/find

Allowed:

- root alias;
- relative path/pattern;
- returned byte/result count;
- truncation flag.

Not allowed:

- returned file content.

### Edit/patch

Allowed:

- relative paths;
- file count;
- additions/deletions when already known safely;
- mutation committed truth.

Not allowed:

- patch body or replacement text.

### Process

Allowed:

- root alias;
- bounded redacted command preview using the existing secret-redaction owner;
- process handle;
- exit code;
- duration.

Not allowed:

- environment;
- unbounded stdout/stderr;
- secret-bearing command material that redaction cannot prove safe.

### Session/worker

Allowed:

- native SessionID/workerID;
- operation/action;
- model/provider/account identity excluding credentials;
- agent;
- group ID;
- durable commit result.

Not allowed:

- Session transcript.

### External MCP

Allowed:

- MCP server identifier;
- tool identifier;
- outcome;
- duration.

Not allowed by default:

- arguments;
- response content.

### File transfer

Allowed:

- direction;
- root alias;
- relative destination/source path;
- byte count;
- provider file ID if non-secret and already part of durable API semantics.

Never:

- signed URLs;
- API key;
- transfer bearer token.

## 4. Redaction failure mode

If a safe projector cannot prove a field safe, omit it.

Gate P prefers:

```text
process · success · 932ms
```

over persisting a questionable command preview.

Observability completeness never outranks credential/privacy boundaries.

## 5. Correlation semantics

The correlation ref records the **mechanism actually observed**, not a stronger
semantic claim.

Canonical ChatGPT tool-call correlation:

```text
_meta["openai/session"] = <opaque anonymized conversation id>

scheme = "openai/session"
scope  = "conversation"
```

OpenAI documents this field specifically for correlating tool calls within the
same ChatGPT session. Its raw value is bounded and HMAC-pseudonymized before Core
sees it.

`_meta["openai/subject"]` is a different primitive: anonymized user identity
for rate limiting/identification. It must not be used as conversation
correlation, because that would merge multiple conversations belonging to the
same user.

Legacy compatibility:

```text
Mcp-Session-Id = <opaque legacy transport-session value>

scheme = "mcp-session-id"
scope  = "unknown"
```

This fallback exists only for handshake-era/unspecified MCP requests and never
asserts conversation identity. MCP `2026-07-28` removed protocol sessions and
`Mcp-Session-Id`. The correlation policy therefore refuses the header as a
fallback for that revision or a later date revision. OpenFork's current MCP SDK
v1.29 transport rejects an explicitly modern request before tool dispatch, so
today no parent activity can be created from such a request in the first place;
the policy-level guard remains as defense in depth for a future v2 transport.

If neither canonical ChatGPT metadata nor an eligible legacy correlation is
present, the invocation remains unattributed. No socket, tunnel, connector,
request, native Session, or user identity is promoted into a substitute parent.

## 6. Renderer projection

Renderer/browser responses must never include:

- raw correlation digest when not required for UI;
- HMAC key;
- native absolute paths;
- secret config fields.

The renderer primarily receives:

- local activity ID;
- local invocation ID;
- root aliases;
- relative paths;
- safe summaries;
- native resource IDs suitable for local navigation.
