# T10 - First-wave provider certification and hosted allowlist

**Lane:** provider safety  
**After:** T08, T09  
**Unlocks:** T13  
**Primary repo:** OpenFork  
**Architecture refs:** sections 13-14, 17.5, 24, 28.2, phase 4, D15

## Objective

Create a provider certification harness and certify the first small set of
API-key providers for hosted shared execution. All other provider/auth paths
remain explicitly blocked or routed through the legacy per-session process
compatibility lane.

Likely first-wave candidates:

- OpenAI API key;
- Anthropic API key;
- OpenRouter API key.

Certification is evidence-based, not inferred from provider popularity.

## Provider certification questions

For each provider path answer:

1. Where does auth material come from?
2. Does any code read/write provider secret `process.env`?
3. Are SDK/client instances cached? At what scope/key?
4. Are retry/backoff limits credential-specific or global?
5. Are sockets/WebSockets pooled? What is their identity?
6. Does provider plugin/module retain account state globally?
7. Does error/log/telemetry code ever serialize auth?
8. Can model metadata be safely shared without auth?
9. Can one tenant's rate-limit response affect another tenant's key?
10. Can child processes receive provider secrets?

## Owned surfaces

- provider implementation/plugin paths for candidates;
- shared provider construction/cache helpers;
- hosted provider allowlist/capability metadata;
- provider mock/recording test harness;
- retry/backoff/cache isolation tests.

Do not tenantize Zen/Go/subscription providers here; T16 owns those unless a
small prerequisite is unavoidable.

## Certification harness

Build a fake upstream provider server capable of:

- recording Authorization/API-key headers by request;
- deterministic streaming responses;
- controllable latency;
- controllable 401/403/429/5xx;
- `Retry-After` values;
- disconnect mid-stream;
- long-running streams for rotation/cancellation races;
- connection/WebSocket identity inspection where applicable.

Never send real provider keys in this harness.

## Hosted provider allowlist

Create an explicit runtime allowlist/certification registry, e.g. conceptually:

```text
providerID
hostedStatus = certified | disabled | compatibility
authModes = [api-key]
certificationVersion
notes/reason
```

Hosted route/model selection must reject a provider/auth mode not certified for
shared mode. Do not silently fall back inside OpenFork to unsafe auth.

PresGen T13 may choose the per-session compatibility runtime for unsupported
providers.

## Mandatory race tests per certified provider

### Credential separation

- A and B issue concurrent requests with different canary keys;
- recorder observes correct key on every request;
- thousands of randomized interleavings produce zero cross-use;
- provider/client cache entries never share secret state across tenants.

### Rotation

- A rotates key while A has in-flight stream;
- policy for in-flight old version is respected;
- new A request uses new version;
- B unaffected.

### 429/backoff

- A receives 429 + long Retry-After;
- B's unrelated credential continues immediately;
- A backoff applies to A credential identity only unless provider semantics
  explicitly prove a broader account limit.

### Error/redaction

- upstream echoes/mangles auth in error body fixture;
- OpenFork redacts before log/event/user error where required;
- metrics contain provider/credential handle, never raw key.

### Cancellation

- abort A stream releases connection/scheduler slot;
- B stream remains healthy;
- no socket/client entry remains permanently busy.

## Provider-specific audit examples

Inspect and classify:

- OpenAI response WebSocket pool keys and auth headers;
- any session-affinity cache that uses session ID without tenant ownership;
- Anthropic SDK client construction and retry state;
- OpenRouter endpoint/free-usage trackers and management-key caches;
- Genspark raw-key cache even if provider stays disabled, to prove the allowlist
  prevents accidental hosted use;
- AWS/AI Core paths that mutate process env: keep blocked.

## Performance measurements

For each certified provider/mock equivalent:

- client construction cold/warm;
- time to first request byte/token;
- throughput under 1/10/50 concurrent tenants;
- connection count;
- provider-client cache count;
- abort release latency.

Do not optimize by pooling credential-bearing clients globally unless the test
proves identity and rotation safety.

## Exit criteria

PASS only when:

- hosted provider allowlist is enforced;
- at least one first-wave API-key provider is certified end-to-end;
- every provider claimed certified passes A/B, rotation, backoff, cancellation,
  and redaction tests;
- unsafe provider/auth modes explicitly fail hosted selection;
- per-session compatibility path remains available.

The task can PASS with fewer than all three candidate providers if the result
clearly records which are certified and PresGen can route the others through
compatibility mode.

## Handoff

`../results/T10.md` must include a provider matrix:

| Provider | Auth mode | Hosted status | Evidence | Known limitations |
| --- | --- | --- | --- | --- |

Also include:

- allowlist API/config location;
- mock harness command;
- race iteration counts/results;
- backoff/cancellation results;
- T13 routing contract for unsupported providers.

