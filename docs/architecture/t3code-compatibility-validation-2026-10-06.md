# T3 Code Compatibility Validation — 2026-10-06

This is a dated evidence record for the OpenFork compatibility profile documented in
[`t3code-compatibility.md`](./t3code-compatibility.md). It records the audited T3
snapshot, current source test results, and a local compiled-runtime check. It does not
claim a complete desktop T3 end-to-end closeout.

## Immutable reference

- T3 repository: `C:\Users\slooshied\WebstormProjects\t3code-reference` remained on
  `main`; no T3 files were edited.
- Stock snapshot: `C:\Users\slooshied\WebstormProjects\.t3-e2e-coordinator\latest-a21702d0e`
  at commit `a21702d0e58ad20263dc965d84472bb6d7eb38c8`.
- The snapshot lockfile resolves `@opencode-ai/sdk@1.15.13`. The pinned SDK v2
  entrypoint used by T3's current runtime was imported directly from that snapshot.
- The immutable old-generation snapshot at
  `C:\Users\slooshied\WebstormProjects\.t3-e2e-coordinator\old-0fcd5f9`
  is commit `0fcd5f90611451cca842689faea53b5450c022da`; its lockfile also resolves
  SDK 1.15.13. Both old and current `opencodeRuntime.ts` import `@opencode-ai/sdk/v2`,
  while the health/version negotiation selects the 1.x local API contract.
- The earlier local `t3code-reference` checkout was 713 commits behind the remote
  when inspected; it was not used as the stock-current oracle.

## Source regression coverage

Commands and results:

```text
bun test --timeout 30000 --only-failures test/compat
197 pass, 0 fail, 12,035 assertions, 9 files

bun test --timeout 30000 --only-failures test/compat/t3-latest-e2e test/compat/t3code-e2e test/compat/t3code-tools-permissions-questions-contract.test.ts test/compat/canonical-openfork-isolation.test.ts
91 pass, 0 fail, 11,782 assertions, 5 files
```

The latest T3 E2E harness now sends the SDK's workspace location carrier on each
request and checks the JSON SSE payload rather than requiring an explicit `event:`
line. The pinned SDK parser consumes `data:` JSON and does not require that optional
field. The legacy MCP add assertion now matches the endpoint's `StatusMap` envelope.
These changes correct the test drivers; they do not change product behavior.

The source-level E2E harness runs OpenFork as a real listener and covers SDK-v1
transport, auth, location routing, events, and session lifecycle. Its permission
rejection case now produces a real pending bash request from a deterministic model
tool call. The question contract tests still cover the HTTP/OpenAPI/schema surface;
the separate immutable T3 runtime question cycle below verifies the live question
flow.

The immutable T3 consumer runtime was also executed directly from both stock
snapshots against the staged `openfork-t3code.cmd` launcher, with isolated homes and
databases. In each case T3's own `connectToOpenCodeServer`, SDK client, and inventory
loader negotiated version `1.15.13` and loaded 226 providers, 10 agents, 1 skill,
and 3 commands. The T3 session flow passed create/get/messages/children/abort, and
pending permission/question reads returned empty lists. This validates the actual
stock runtime adapter and SDK integration, beyond calling the SDK alone; it still
does not, by itself, exercise the UI or live supervision cycle.

Using the immutable current T3 runtime adapter against the same staged launcher, a
compiled-runtime question cycle completed with a local fake OpenAI-compatible
provider: T3 negotiated `1.15.13`, observed the pending question and its originating
message/call IDs, replied with the SDK's flattened
`question.reply({ requestID, answers })` shape, and received a completed question
tool result containing the selected answer. The resumed model turn then produced the
expected final assistant text. The isolated run used a scratch database and workspace;
it did not touch user T3 data.

External-server authentication was then exercised through T3's own
`connectToOpenCodeServer` and SDK client against a password-protected staged
launcher. Correct credentials negotiated `1.15.13`, fetched authenticated health,
and loaded the inventory (228 providers, 9 agents, 12 skills, 14 commands). A wrong
password failed closed at the health/version check with HTTP 401. Both runs used a
dedicated database; the test password was local-only and was not persisted.

A bash permission probe reached the same server and T3 SDK: it observed a pending
`bash` permission for the exact `echo T3_PERMISSION_GRANTED` command, replied with
`permission.reply({ requestID, reply: "once" })`, and the pending list cleared. A
subsequent message state showed the shell tool completed with exit code 0 and the
expected output; the resumed assistant turn then returned the expected final text.
The first probes used too-short observation windows for this host's shell startup, so
the final successful run kept the fake provider available until the full cycle ended.

The question cycle also ran with T3's exact `client.event.subscribe()` stream open.
The pinned SDK decoded an ordered stream including `server.connected`, session and
message lifecycle events, `question.asked`, `question.replied`, message-part deltas,
and `session.idle`. A `session.checkpoint.errored` event was also delivered for the
scratch workspace; this was recorded as an event-path observation, not treated as a
question-cycle failure. This verifies live SSE framing and event ordering for this
cycle. The compatibility `/event` bridge now retains its existing bounded ring
(4096 events / 8 MiB) for 30 seconds after its final subscriber disconnects, and
captures events only during that grace window. A server-layer test received
`session.created` on the first stream but left the frame unread, interrupted that
stream, then reconnected with the last observed `Last-Event-ID` and received the
frame from the ring. Events published during the disconnected grace are covered
separately by the bridge test, which verifies replay and expiry and confirms the
ring rotates.
A staged-binary stock-T3 E2E check waited beyond the grace and confirmed
the old cursor receives
`server.stream.gap`. The pinned SDK 1.15.13 SSE client retries when fetch or its
stream reader throws and carries `Last-Event-ID` into the retry request; a clean EOF
exits its stream loop without retry. T3's immutable provider adapter treats that
EOF as unexpected, marks active turns failed, and ends its event queue. If an SDK
retry exceeds the grace, the adapter's default event branch ignores the gap frame
instead of hydrating missed state. The short disconnect/replay path is proven at
the server-handler layer, and expired-cursor signaling is proven against the
staged launcher; a forced network-reset through T3's full provider adapter remains
untested.

## Stock T3 web UI exercise

The immutable current T3 web development stack paired in a browser using a fresh
`T3CODE_HOME` under W:. The setup wizard completed; project import was skipped so
no unrelated projects were read or imported. In Settings → Providers, the stock
OpenCode provider flow accepted the staged
`openfork-t3code.cmd` launcher and negotiated OpenFork's T3 compatibility version
`1.15.13`.

T3's local provider launcher supplies an empty `OPENCODE_CONFIG_CONTENT` unless a
provider-specific environment override is configured. That intentionally isolated
T3's own development process from OpenFork's config-file path and initially hid the
scratch model. To keep T3 immutable and the test deterministic, the UI provider was
then pointed at a separately started staged OpenFork server on an isolated port;
that process used the scratch config/database under W: and a fake OpenAI-compatible
endpoint bound only to localhost. T3's custom model entry selected the configured
`test/test-model` model. From a “No project” scratch thread, the UI sent a prompt
and visibly rendered `T3_UI_OPENFORK_OK`; the thread returned to idle. No Codex or
Claude provider was selected or used for inference.

The stock web UI provider-and-chat path above used the actual staged Windows
launcher through an isolated external server. A follow-up also exercised T3's local
child-process supervision: the isolated provider environment supplied scratch
`OPENCODE_CONFIG_CONTENT`, `OPENCODE_DB`, and scratch Windows profile paths; T3
launched `openfork-t3code.cmd`, negotiated version `1.15.13`, and completed a chat
rendering `T3_UI_OPENFORK_OK`. The initial local probe timed out when environment
values had been entered as T3-stored secrets. Re-entering the local scratch values
as ordinary provider environment entries allowed the version probe and chat to
complete. No T3 source or existing T3 user data was changed.

The same local child-process setup then exercised the stock UI question cycle. The
fake local model produced a question tool call; T3 displayed the question card,
accepted the answer `Blue`, resumed the OpenFork model turn, and rendered
`T3_UI_QUESTION_ANSWERED`. This verifies the web UI question presentation and
reply/resume path, in addition to the runtime-adapter question test above. It does
not cover question cancellation/rejection, the desktop shell, UI permission dialogs,
or browser refresh and reconnection recovery. Earlier incorrect custom entries and
rejected chat attempts were isolated setup attempts; successful runs used the
matching provider/model IDs.

## Isolated compiled Windows artifact

The package builder now accepts `OPENFORK_BUILD_OUTPUT_DIR`; when unset, it continues
to use the package's existing `dist` directory. This allowed a full UI-embedded
single-target build without deleting or replacing shared `dist` output:

```powershell
$env:OPENFORK_BUILD_OUTPUT_DIR = 'W:\Dev\openfork-t3code-build-20261005'
bun run build --single --skip-install
```

Result: `openfork-windows-x64` built at version `0.0.0-main-202610060316`; the build's
executable smoke passed, as did the ChunkDB capability check (`user_version 5`). The
staged executable and launchers are under
`W:\Dev\openfork-t3code-build-20261005\openfork-windows-x64\bin`.

After adding bounded legacy SSE retry retention, the staged Windows artifact was
rebuilt at `0.0.0-main-202610060605`; its executable and ChunkDB smoke checks passed.
The current-generation T3 E2E file then passed in both source and shipped modes
(34 tests / 94 assertions in source mode and 34 tests / 97 assertions in shipped
mode). The complete staged compatibility suite passed 199 tests / 12,062 assertions
across 9 files.

Launcher identity checks:

| Entry point | Reported version |
| --- | --- |
| `openfork.exe --version` | `0.0.0-main-202610060705` |
| `openfork-t3code.cmd --version` | `1.15.13` |
| `opencode.cmd --version` | `0.0.0-main-202610060705` |

Both T3 and canonical launchers were then used to start this staged binary with
isolated databases and password auth. The pinned SDK 1.15.13 successfully called
provider, agent, skill, command, pending permission/question, health, SSE, and
session create/get/messages/children/abort routes on each server. T3 reported
`1.15.13`; canonical `opencode.cmd` reported the native OpenFork version. Pending
permission/question lists were correctly empty in this read/lifecycle scenario.

## Follow-up: directory identity and full adapter rejection

The pinned T3 `OpenCodeAdapterV2` rejection attempt exposed a real Windows event
routing gap. The adapter subscribed with a short `C:\Users\SLOOSH~1\...` path,
while OpenFork's event producers attached the canonical long path. The legacy
`/event` handler compared those strings directly, so the API showed a pending bash
permission while the stream delivered only connection/heartbeat frames. The handler
now resolves the routed directory with `FSUtil.resolve` before applying its event
location filter. This is limited to the compatibility event boundary; it preserves
the existing request-carrier decoding in workspace routing.

The regression uses a directory junction and a real local OpenFork listener. It
asserts that T3's `permission.asked` SSE event matches the pending request ID, then
rejects the permission and verifies the tool ends in an error without running the
command. A second held-open provider request verifies session abort closes the
outgoing provider stream.

The immutable current T3 runtime and its actual `OpenCodeAdapterV2.ts` were then
loaded in T3's own Vitest runner from a scratch directory outside the T3 checkout.
Against the rebuilt staged Windows executable (`0.0.0-main-202610060705`), the
adapter received `permission.asked`, emitted a `command` runtime request, sent
`decision: "decline"`, and observed the terminal rejected tool state. The fake
provider confirms `echo T3_ADAPTER_COMMAND_RAN` was never executed. An initial
harness assertion expected the wrong T3 runtime request kind (`command-approval`);
the pinned T3 type is `command`, and the corrected real-adapter run passed. No T3
source or user T3 data was modified.

Follow-up verification on the current source and staged artifact:

```text
Biome check: event.ts and latest-t3-e2e.test.ts passed
Source latest-T3 E2E: 34 pass, 0 fail, 96 assertions
Staged latest-T3 E2E: 34 pass, 0 fail, 98 assertions
Staged compatibility suite: 199 pass, 0 fail, 12,064 assertions, 9 files
openfork.exe --version: 0.0.0-main-202610060705
openfork-t3code.cmd --version: 1.15.13
opencode.cmd --version: 0.0.0-main-202610060705
ChunkDB capability smoke: user_version 5
```

The same follow-up also ran `test/server/t3code-event-stream-contract.test.ts`
and `test/server/httpapi-event-lifetime.test.ts` together. The T3 event contract
suite passed all 14 tests, including encoded percent-path delivery and replay. The
lifetime suite passed three cases but its foreign-cursor gap case timed out twice
after receiving `server.connected`; it did not produce the expected second frame
in this Effect-backed test harness. The real source and staged stock-T3 E2E gap
checks pass, so this server-layer timeout remains an unresolved test result rather
than evidence that the shipped compatibility gap path fails.

The full compatibility suite includes `canonical-openfork-isolation.test.ts` and
passed against the rebuilt staged executable. The updated Windows artifact remains
in `W:\Dev\openfork-t3code-build-20261005`; it was not installed over the shared
`W:\Apps\OpenFork\current` runtime.

OpenFork source HEAD at this verification was
`1d9690291159d425a6efc8bb8bf39fb02d3cf22e`. This follow-up leaves three
uncommitted task-file changes: `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`,
`packages/opencode/test/compat/t3-latest-e2e/latest-t3-e2e.test.ts`, and this
validation report. No source commit was created.

## Remaining evidence gaps

- The immutable T3 web development stack completed stock UI provider/chat flows
  against the staged Windows launcher, including local child-process supervision
  with a scratch custom config. The question card and answer/resume flow passed.
  The desktop application and UI-level permission dialog were not exercised.
- The current stock T3 server itself was started from the immutable snapshot on an
  isolated port with `--base-dir W:\Dev\openfork-t3code-build-20261005\t3-home-current`
  and project auto-bootstrap disabled. All 56 migrations completed, the server
  became ready, and the process was stopped. This separate boot check confirms the
  stock server starts on this host; it was not configured to use the staged
  OpenFork provider during that run.
- Question request, response, completed tool output, and resumed assistant text are
  verified with T3's actual runtime adapter and staged launcher. The web UI question
  presentation and answer/resume path also passed; question cancellation/rejection
  remains untested.
- Permission rejection now has a deterministic-provider real-listener regression
  against both current source and staged binary. A T3 v1 prompt creates a pending
  bash request; the junction-scoped legacy SSE stream receives its
  `permission.asked` event; `reply: reject` clears it and records an ended tool
  error with no stdout marker. The current T3 `OpenCodeAdapterV2` rejection path
  is also verified against the staged executable. The stock UI permission dialog
  and presentation remain untested.
- The same real-listener regression starts a second prompt against a held-open
  provider stream, calls the legacy session abort route, and verifies the outgoing
  provider connection closes. This proves active cancellation at the OpenFork
  service/transport boundary; T3 adapter recovery and UI behavior remain outside
  this test.
- After the replay-window change, `test/event-v2-bridge-gate.test.ts` passed 10
  tests / 43 assertions; `test/server/t3code-event-stream-contract.test.ts` passed
  14 tests / 56 assertions, including short-disconnect replay; and the staged
  Windows launcher passed the expired-cursor gap case against immutable current T3.
  The current-source and staged shipped current-T3 E2E runs each passed 34 tests
  (96 and 98 assertions, respectively). The complete staged compatibility suite
  passes 199 tests / 12,064 assertions across 9 files.
- Permission request and response, cleared pending state, and successful tool output
  plus resumed assistant text are verified. T3 adapter rejection is verified for a
  command permission against the staged executable. T3 adapter active-turn
  interruption/cancellation recovery and stock UI permission presentation remain
  unverified.
- An earlier SDK `promptAsync` attempt used the wrong test-driver shape: SDK 1.15.13
  accepts a flattened request object, not `{ sessionID, body }`; its resulting 400
  was a harness error, not product evidence.
- The staged build was validated, but it was not installed over the shared
  `W:\Apps\OpenFork\current` runtime. The installed launcher there still points at
  an older September 30 build and is not evidence for current source. This turn
  reconfirmed installed `openfork-t3code.cmd --version` as `1.15.13` and
  `openfork.exe --version` as `0.0.0-dev-202609302029`; isolated `agent list` and
  `debug skill` also exited 0 with `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, the DB,
  and config content redirected to W: scratch paths. Their captured output had no
  references to `C:\Users\slooshied`. `models --verbose` is not currently verified
  under that complete profile isolation: an earlier attempt that redirected only
  the DB/config still loaded ambient skill/config state and was interrupted. These
  checks cover installed CLI paths only, not current source.
- Port `49031` was already occupied by an unrelated existing process and was left
  untouched. Runtime checks used isolated ports and databases.
- No source commits were created during this validation. The T3 tree remained
  untouched.

## Closure assessment

The additive launcher/profile, native identity separation, source compatibility
suite, and staged Windows binary are verified. The updated staged artifact is
`0.0.0-main-202610060705`; executable and ChunkDB capability smoke checks passed.
Both current and old immutable T3
runtime adapters completed inventory and session flows against the staged launcher.
The current adapter also completed compiled question/reply/resume and bash
permission/reply/execution/resume cycles against isolated databases using a fake
OpenAI-compatible provider.

Goal closure is not justified yet. Stock web UI chat, local child-process
supervision with config overrides, and the UI question answer/resume flow are
verified; desktop UI and UI permission dialogs remain unverified. SSE ordering,
short-disconnect event replay, and expired-cursor gap signaling are verified at
their stated scopes. The pinned SDK retries thrown transport errors but exits on
clean EOF; the provider adapter fails turns on EOF and ignores an expired-cursor
gap instead of hydrating missed state. A forced network reset through T3's full
provider adapter, gap recovery, abnormal stream completion, and error-path recovery
remain open. The current build was not installed over the shared
`W:\Apps\OpenFork\current` runtime. Command permission rejection through T3's
adapter is verified; interruption and cancellation recovery remain unverified. No
T3 source was modified and no source commits were created.

## Additional stock T3 UI attempt (2026-10-06)

An isolated detached checkout of the immutable T3 commit `a21702d0e58ad20263dc965d84472bb6d7eb38c8` was installed with its frozen pnpm lock and launched on separate ports with a scratch data home. Chrome successfully loaded the stock UI and discovered the staged `openfork-t3code.cmd` as OpenCode v1.15.13 (12 upstream providers). A loopback-only synthetic OpenAI-compatible provider was prepared on port 49222. The UI settings form accepted an `OPENCODE_CONFIG_CONTENT` value, and provider refresh completed, but model discovery did not expose the synthetic model; the environment value is intentionally redacted on readback. Therefore no stock UI permission card was reached and this attempt does not change the prior unverified status for UI permission dialogs. No external provider was used. The T3 checkout was kept detached and its tracked source was not edited.

## Verification rerun (2026-10-06, current worktree)

Re-ran `bun test --timeout 120000 test/compat/t3-latest-e2e/latest-t3-e2e.test.ts`: 34 passed, 0 failed, 96 assertions. This includes the real listener permission rejection/active provider abort and the expired-cursor `server.stream.gap` case, in both source and staged-binary modes. Re-ran `bun test --timeout 30000 test/server/httpapi-event-lifetime.test.ts`: 3 passed, 1 failed. The isolated `emits the gap control frame without an id` case again timed out after 125 seconds, while the live SSE gap case in the stock-T3 E2E passed. Treat these as distinct scopes; the harness timeout remains unresolved.

## Follow-up diagnostics from the supplied T3 screenshot (2026-10-06)

The supplied stock UI screenshot shows the OpenFork provider configured with the bare `openfork-t3code` command and a reported four-second CLI version-probe timeout. On this same Windows user environment, a direct `cmd.exe /d /s /c "openfork-t3code --version"` invocation resolves the bare command and returns `1.15.13` in 562 ms. The staged absolute `.cmd` launcher returned successfully in 0.58–1.03 seconds across three calls. This narrows the discrepancy to T3's provider process context or a transient refresh; it does not establish the cause. No user T3 settings were changed.

The event-lifetime timeout was instrumented in a temporary test edit and then restored. All five assertions ran, including receipt of `server.stream.gap` without an SSE id. Explicitly interrupting both reader fibers also completed, but the test still timed out after the test body, during outer scope cleanup. This remains a test-lifetime cleanup issue; the live stock-T3 E2E gap case continues to pass. No production source was changed as part of this diagnostic.

## Production repair — 2026-10-07

The installed `W:\Apps\OpenFork\current` runtime was still a September 30 development
artifact even though the T3 compatibility facade itself continued to negotiate the
correct `1.15.13` identity. The stale native backend reproduced a startup failure on
the live database:

```text
SQLITE_CONSTRAINT_FOREIGNKEY
delete from "runtime_owner" ...
runtime-owner:264d6cb6-7781-4645-942a-1101771959ee
```

That runtime owner remained referenced through
`session_execution_owner.recovery_owner_id`. Current OpenFork source already
contains the correctness-critical writer-transaction reference recheck in
`collectDeadRuntimeOwners`, so the October 6 staged artifact was exercised against
the same live database before installation. Its `openfork-t3code models --verbose`
completed successfully where the September artifact failed.

The staged artifact was copied into the versioned runtime store as:

```text
W:\Apps\OpenFork\builds\0.0.0-main-202610060705-t3code-fkfix
```

The `current` junction was then switched to that build while preserving the exact
previous junction at:

```text
W:\Apps\OpenFork\current.rollback-20261007-134513
```

Post-install identity and CLI gates:

```text
openfork.exe --version              0.0.0-main-202610060705
openfork-t3code.cmd --version       1.15.13
opencode.cmd --version              0.0.0-main-202610060705
openfork-t3code models --verbose    exit 0
openfork-t3code agent list          exit 0
openfork-t3code debug skill         exit 0
```

The bare command resolves through
`W:\Apps\OpenFork\current\openfork-t3code.cmd`, so T3's configured local
`binaryPath` continues to enter the intended compatibility facade.

The installed binary was then used as
`OPENFORK_T3_E2E_BIN_PATH` in the stock-latest-T3 real E2E harness. One first
suite run observed a transient listener-lifecycle failure after the 30.1-second SSE
replay-grace wait. The failed replay-gap test passed in isolation, an independent
installed-server probe remained alive beyond the grace interval, and an immediate
complete shipped-mode rerun passed:

```text
34 pass, 0 fail, 104 assertions
```

That shipped run covers facade version negotiation, authenticated health, provider /
agent / skill / command inventory, session create/get/update/messages/children/abort,
permission rejection, active-provider abort, authenticated and unauthenticated legacy
SSE, and expired-cursor `server.stream.gap` delivery.

The live working tree additionally hardens the optimistic runtime-owner GC pre-scan:
the pre-scan now projects both `owner_id` and `recovery_owner_id` instead of
filtering by both columns while recording only `owner_id`. A regression test models
a stale runtime owner referenced exclusively through `recovery_owner_id` and proves
that it is retained without even issuing a death probe. The focused recovery suite
passes 22 tests / 64 assertions and Biome is clean.

A detached clean-HEAD candidate at
`C:\Users\slooshied\WebstormProjects\opencode-wt-t3code-runtime-fix-20261007`
was also built successfully after reusing the already-resolved root dependency tree.
That candidate includes the GC pre-scan hardening but deliberately was **not**
promoted: the committed HEAD by itself still lacks later uncommitted T3 compatibility
corrections and its shipped-mode harness failed permission-event delivery and
`session.abort`. In contrast, the live working-tree source-mode T3 harness passes
34/34. Therefore future release promotion must preserve/reconcile the current T3
compatibility working-tree deltas rather than building committed HEAD in isolation.

T3 source remained unmodified throughout this repair.
