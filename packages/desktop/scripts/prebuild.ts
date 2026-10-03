#!/usr/bin/env bun
import { $ } from "bun"

import { buildLocalCliToResources, resolveChannel } from "./utils"
import { fetchTunnelClient } from "./fetch-tunnel-client"
import { preflightWorktreeStore, stageWorktreeStore } from "./fetch-worktree-store"

const channel = resolveChannel()
// Resolve the managed sidecar source before any expensive build step so a
// beta/prod build with an unpinned lock fails immediately instead of after the
// node sidecar, tunnel client, and icons have already been produced.
const worktreeStore = await preflightWorktreeStore({ channel })
console.log(
  `worktree-store preflight: channel=${worktreeStore.channel} target=${worktreeStore.targetKey} source=${worktreeStore.source.kind}`,
)
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../opencode && bun script/build-node.ts`
await fetchTunnelClient()
// The managed worktree-store sidecar is staged only from a checked-in pin.
// Unpinned dev builds continue without it; beta/prod fail closed so a
// production build can never ship an unverified sidecar.
await stageWorktreeStore({ channel })
// OpenFork desktop builds never source their runnable CLI from upstream OpenCode
// packages. Dev bundles always build the host-platform OpenFork CLI from the
// current tree so the sidecar and CLI cannot silently diverge in provenance.
if (channel === "dev") {
  await buildLocalCliToResources()
}
