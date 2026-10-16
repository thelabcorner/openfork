# Prompt admission and interrupted sessions — 2026-10-06

## Observed failure

The desktop displayed `Failed to send prompt / Unable to retrieve session`.
This text is a composer failure when its in-memory session row is absent; it
does not establish that the durable session is absent. Separately, the live
desktop reported more than ten `WebContents.destroyed` listeners.

Live diagnostics found 183,922 Node FSWatcher handles and roughly 2.26 GB RSS
in the Electron utility-process sidecar. The sampled watcher callback was
Chokidar's `handleEvent` under the presGEN_v2 workspace's `.opencode/node_modules`.
This attribution identifies a workspace dependency, not the native Core Parcel
watcher. Logs also recorded a `database is locked` project-directory INSERT and
an explicit prompt's `InstanceStore.load` wait of approximately 59.6 seconds.
The precise caller was PresGEN's `.opencode/plugins/read-indexer.js`, compiled
from `.opencode/src/plugins/read-indexer.ts`: it recursively watched the whole
worktree. This explains the watcher fanout; the database contention and crash
are additional observations, not proven consequences of that fanout.

The plugin now indexes through its existing host events instead of owning a
second recursive observer. Disposal cancels pending jobs. Six tests verify event
paths, zero new FSWatchers on plugin mount, and no jobs after disposal. Commit
`e8cea476cf0a66ce29e2170174ef0973464462f6` was integrated into the active PresGEN
checkout after the accountable lead verified the three paths were independent
of its unrelated dirty work. The temporary clean worktree was removed after
verifying exact staged-file parity; the commit remains available.
The user subsequently identified the plugin as defunct and requested disabling
its loading. Source and compiled entrypoint now live in
`.opencode/disabled-plugins/read-indexer/`, outside both automatic plugin
discovery and `src/**/*` compilation. Tests import that retained archive; all six
still pass. This direct primary-checkout follow-up was explicitly requested by
the user and does not require recreating the removed temporary worktree.

## Ownership and demand path

Durable Session row -> Core Session service -> bootstrap-free
`GET /global/session/:sessionID` -> SDK transport -> shared server-session cache
-> composer. A user-triggered submission with a missing cache row resolves the
explicit Session ID instead of waiting for a global list or loading history.
The reverse demand path is submission -> missing metadata -> one explicit-ID
lookup -> durable storage. No workspace Instance is justified for this lookup.

The desktop control transport reserves separate admission and urgent network
sessions. Explicit-ID session metadata joins the urgent transport so ordinary
renderer SSE connections and stalled runtime admissions cannot prevent this
submission prerequisite. Catalog, list, and message-history requests do not join
that transport.

Control-request cancellation is owned by Electron main. Concurrent requests from
one renderer share one `destroyed` observer; the last request releases it, and
renderer destruction aborts every retained request. Raising EventEmitter's
listener limit would conceal the ownership multiplier.

Durable execution owner -> exact live activation/death evidence -> global status
and telemetry projections -> shared client state -> composer/timeline. A local
owner without its exact activation, or a foreign owner proven dead, projects
`interrupted` instead of `busy`. Historical tool parts do not establish liveness.
The existing Stop recovery can claim an orphan in the same live process, pause
the session, seal unfinished tool state, and release the exact owner generation.
The UI offers recovery and preserves the draft. Unknown foreign liveness still
fails closed; this change does not claim another process is dead without proof.

OXP can retire a backend module while keeping the same process PID. Execution
activations and in-progress acquisitions therefore use a process-shared exact
session/owner/generation registry. A foreign module owner in this same process
is busy while its exact activation exists and interrupted after that activation
is gone; recovery remains fenced while any exact activation is live. PID
liveness and old module-local maps cannot substitute for that fact.

Desktop main also owns a generation-scoped endpoint readiness lease. Sidecar
exit invalidates the URL and mobile handshake; late exits cannot invalidate a
newer generation. Startup cannot publish an endpoint after its process exits.
The stopped projection offers a persistent localized Relaunch action; intentional
shutdown suppresses that toast. The user controls restarts and launches.

## Verification

The actual Electron IPC fixture holds six runtime admissions and four urgent
requests concurrently. Session creation, explicit-ID metadata, stream interest,
and Stop remain reachable; the `destroyed` listener count does not grow when
urgent requests join existing admissions and returns to baseline on completion.
Stop completed in approximately 2–4 ms in the local fixture. This fixture proves
the IPC/network mechanism, not healthy execution in a workspace with an
unbounded third-party watcher.

Lifetime tests cover 1/3/6/14 concurrent requests, renderer destruction, final
release, and application shutdown. Desktop typechecking and the transport and
renderer-adapter tests pass. Session metadata lookup never loads message history
or enters workspace middleware.

Additional verification: 153 targeted app tests / 380 assertions and app,
session-ui, and desktop typechecks pass. The Core execution-owner suites pass
47 tests / 180 assertions; run-state abort and global status suites pass 15 tests
/ 74 assertions, including 1/3/6-session control scenarios. A full HTTP Stop
regression passes with an orphaned owner and unfinished tool (8 assertions).
SDK/client regeneration and the Node backend build succeeded. Whole-package
Core/OpenCode typechecks remain blocked by unrelated existing errors.
Readiness and control-transport regressions pass eight tests, including early
exit and late-generation invalidation. The two affected local execution service
fakes were updated; interrupt/maintenance tests pass three tests / 14 assertions.

Desktop server logs confirm the rebuilt HTTP/OXP runtime was activated and
accepted at 15:43:22 UTC, with runtime ID
`sha256:21556752304b994017ec6b151c0ff075c1af00d7562f985745118bea97b59e40`.
The final same-process ownership fix was subsequently activated and accepted
through OXP at 16:03:45 UTC as
`sha256:bea12dc021bfdc8bf75b9cb19ebdb971ce4c3b0672d883dd098f0cae1af689b3`.

## Closure limits

Real workspace prompt execution and a six-provider-stream desktop workload have
not been proven by the isolated control fixture. Backend activation does not
prove an updated renderer/main bundle is running. The first OXP status request
after the runtime swap returned a gateway 504; a subsequent status request
succeeded and independently confirmed the accepted runtime and generation 2.

A post-swap inspector sample reopened the performance finding: sidecar PID
208608 had 87,330 FSWatchers and about 1.85 GB RSS. This is not a successful live
watcher closeout. External plugin imports use Node's pathname module cache,
which is separate from the versioned backend artifact; changing a plugin on disk
does not itself prove its code changed in the already-running process.
Inspector `Debugger.getScriptSource` confirmed the live canonical PresGEN
plugin still contained `chokidar.watch`, whereas the fixed disk file contains
`createReadIndexerHooks` and no Chokidar import. Chokidar's closure map held
183,923 paths under PresGEN, including 26,204 font paths and large audit and
Python-environment trees. The current instance started after the disk fix but
instantiated the cached old plugin. A process restart is required to activate
this external plugin change; backend-module refresh alone is insufficient.

## Live validation after the user's restart

The user restarted their `bun run dev` desktop on 2026-10-06 at 11:12 CDT. The
compiled desktop bundle includes the new readiness lease, and OXP confirms the
accepted `bea12dc...` backend is serving. No further restart or launch is owned
by the agent.

An isolated diagnostic session in explicit PresGEN location was created (HTTP
200), received a `noReply: true` prompt through `prompt_async` (HTTP 204 in about
1.98 seconds), and was deleted (HTTP 200). This exercises durable admission and
real Tier-3 instance initialization without provider execution or mutation of a
user session. PresGEN initialization recorded an 865 ms request delay.

After initialization, sidecar PID 149968 had **zero FSWatchers**, 20 active Node
handles, and roughly 629 MB RSS. Health returned HTTP 200 in 2 ms. Inspector
script enumeration found no read-indexer module. Other Chokidar modules were
loaded, but created no filesystem watcher handles. This closes the specific
recursive watcher producer finding under the actual PresGEN initialization
trigger; it does not establish six-provider-stream desktop parity.

The status snapshot also contained two busy entries with an empty *local*
activation registry and idle local telemetry. Those observations alone cannot
disprove legitimate ownership by a different process. Durable owner/PID evidence
must be checked before treating them as stale or modifying their sessions.
