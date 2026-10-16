# OXP tunnel health and retry ownership

The pinned OpenAI tunnel-client owns remote control-plane polling, exponential
backoff, jitter, and `Retry-After`. Electron owns the client process lifetime and
its compact health projection. A remote retryable response does not justify
restarting the client or replaying an MCP operation.

## Data ownership

OpenAI poll response / client metrics -> Electron tunnel supervisor ->
`OxpController` state projection -> existing IPC subscription -> OXP Settings.

In reverse, Settings subscribes to the controller's existing projection; the
controller consumes supervisor reports; the supervisor probes the owned client's
loopback readiness and metrics. No workspace Instance, Session history, renderer
polling, or second control-plane connection is needed to display tunnel health.

`/readyz` proves local readiness only. A positive, fresh
`commands_poll_last_successful_timestamp_seconds` proves a completed remote poll.
An empty successful poll also counts. Zero or absent metrics never prove a remote
connection. A confirmed outage remains offline even if no poll has ever succeeded
or metrics temporarily disappear.

## Remote failures

Only control-plane **poll** failures are classified here:

| Evidence | Desktop treatment | Retry owner |
| --- | --- | --- |
| Network timeout, DNS or connection failure | Network outage | Existing client |
| HTTP 5xx, including 503 `tunnel_transport_unavailable` | Remote service outage | Existing client |
| HTTP 429 | Remote rate limiting | Existing client |
| 401 / 403 | Existing terminal authentication handling | Operator |
| Other errors, including response delivery failures | Preserve diagnostic warning | Existing client semantics |
| Successfully forwarded MCP `isError` result | Application feedback | No transport retry |

The v0.0.14 [wire protocol](https://github.com/openai/tunnel-client/blob/v0.0.14/docs/protocol.md)
and [OpenAPI contract](https://github.com/openai/tunnel-client/blob/v0.0.14/docs/openapi.json)
define retryable poll responses and `Retry-After`. Service unavailability means
the remote service returned a failure; it is not proof of a local network outage
or a rejected API key. Local changes cannot repair an unavailable OpenAI service.

The supervisor emits one sanitized informational diagnostic per observed outage
episode and one recovery diagnostic with duration and poll-error count. Repeated
failures update the episode's latest failure time without multiplying logs or
creating processes. The existing 35-second confirmation and 95-second freshness
windows absorb transient failures. Only a successful poll timestamp strictly
after the latest observed failure clears an episode: stderr and metrics can
arrive out of order, so a newly read older success is insufficient. Second-level
timestamps may conservatively require another successful poll.

Process exit and sustained local unresponsiveness retain the existing bounded
restart owner and process-tree retirement rules. Stop still wins over reconnect.
No tool schema, dispatch, grants, or supported entry points change here.

## Verification and limits

`packages/desktop/src/main/oxp/tunnel-contract.test.ts` checks status classification,
negative non-poll/auth cases, stale/zero/missing metrics, outage confirmation, and
delayed-success ordering. `tunnel-supervisor.test.ts` launches real child processes
and loopback health servers to verify structured and unstructured repeated 503s,
429s, recovery, sustained failure before any success, one client per supervisor,
and shutdown. Existing boundary tests cover projection and secret isolation.
`tunnel-runtime.test.ts` additionally exercises the installed pinned binary
against loopback MCP/control-plane fixtures: two 503 responses with `Retry-After`
followed by successful empty polls. It verifies minimum retry delays, one outage
diagnostic, no supervisor restart, and metrics-proven recovery. It skips when the
runtime has not been installed; it never downloads binaries or uses real keys.

These tests verify local behavior under simulated remote failures. Passive live
metrics can corroborate a remote outage but cannot establish recovery or certify
the patched Electron runtime before it is relaunched with the new main bundle.
