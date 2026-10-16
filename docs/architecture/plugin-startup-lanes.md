# External plugin startup lanes

OpenFork's server plugin lifecycle separates session-critical plugin semantics
from explicitly opted-in event observers. The default remains the session lane.

## Ownership path

The producer is the merged workspace configuration. `Config` records each
configured plugin and its source in `plugin_origins`; `InstanceBootstrap.gate`
initializes `Plugin.Service`; and `Plugin.state` loads the plugin module and runs
its config hook. First prompt selection also asks `Provider` for its state, which
uses `Plugin.list()`. Before this split, both paths waited for every configured
plugin's dependency preparation, module load, `server()` callback, and config
hook. A selected model could therefore wait on plugin work whose only purpose
was observing later events.

The reverse demand path starts with prompt admission, resolves the chosen
provider/model, reads the provider's plugin hooks, and reaches the merged plugin
configuration. Plugin work that can alter provider/model catalogs, prompts,
tools, permissions, adapters, or other execution behavior belongs on the
session-critical path because the selected request needs its result. Event-only
observers do not own those facts and can load after the session state is
available.

## Config contract

External plugins remain session-critical unless their config tuple explicitly
opts into the background observer lane:

```jsonc
{
  "plugin": [
    ["my-event-observer", {
      "$openfork": { "startup": "background-events" },
      "observerOption": "kept for the plugin"
    }]
  ]
}
```

`$openfork` is host metadata and is removed before the remaining options reach
the plugin. Unknown lane values fail closed to the session lane. Plugins using
the background lane may return only `event` and `dispose` hooks. Any other hook
causes that plugin's returned hook object to be rejected and disposed; this
prevents a delayed config hook from silently changing the model configuration
after a prompt has already been selected.

Session-lane plugins preserve their prior order and behavior: dependency checks
complete, modules load, `server()` callbacks run sequentially, and config hooks
run before state is published. The background lane is scoped to the workspace
instance and is interrupted during teardown. Its loaded event hooks join the
existing directory event subscription; they do not appear in `Plugin.list()` or
provider-state construction. Events emitted before an observer finishes
activation are not replayed, so this lane is for future event observation, not
durable state reconstruction. The runtime also cannot sandbox module top-level
or `server()` side effects; only trusted plugins with observer-only startup
behavior should opt in.

## Resource boundary and limits

This is an admission boundary, not a separate process or CPU scheduler. It keeps
explicit observer dependency resolution and initialization off the
`InstanceState`/selected-model readiness barrier, but both lanes still use the
same Node.js process, filesystem, and event loop. An expensive synchronous
background plugin can still consume CPU after it starts. Hard CPU and memory
isolation requires a separately designed worker/process plugin API with a
bounded message protocol; do not claim that this lane provides that guarantee.

No existing plugin changes lanes automatically. A user must explicitly mark an
observer plugin, and the runtime rejects execution-affecting hooks there. This
server-side V1 lifecycle change does not migrate OpenFork callers to the current
Protocol API and does not claim support for arbitrary upstream OpenCode
extensions.
