import { $ } from "bun"
import { spawn } from "node:child_process"
import { buildLocalCliToResources } from "./utils"
import { fetchTunnelClient } from "./fetch-tunnel-client"
import { fetchCloudflared } from "./fetch-cloudflared"
import { busyBuildRetryDelay } from "./node-sidecar-build-retry"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`
await fetchTunnelClient()
await fetchCloudflared()

// V1 and V2 are mutually exclusive runtime backends. Building both on every
// launch made the default V1 dev path compile + smoke-test a Bun executable it
// never starts, then force-rebuild the Node sidecar even when its inputs were
// unchanged. Build only the artifact this launch can actually consume and let
// build-node's freshness check decide whether V1 needs a rebuild.
if (process.env.OPENCODE_SIDECAR_V2 === "1") {
  await buildLocalCliToResources()
} else {
  // A runtime refresh may be committing its candidate artifact while dev
  // starts. Match the watcher behavior and retry only the builder's explicit
  // busy result; compile and process failures should still fail startup.
  for (let attempt = 0; ; attempt++) {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("bun", ["script/build-node.ts"], {
        cwd: "../opencode",
        stdio: "inherit",
        windowsHide: true,
      })
      child.once("error", reject)
      child.once("exit", resolve)
    })
    if (code === 0) break
    if (code !== 75) throw new Error(`Node sidecar build failed (exit ${code ?? "unknown"})`)
    const delay = busyBuildRetryDelay(attempt)
    if (delay === undefined) {
      throw new Error("Node sidecar build stayed busy; retry `bun run dev` after the OXP runtime transaction completes")
    }
    console.warn(`[desktop:predev] OXP runtime artifact transaction busy; retrying in ${delay}ms`)
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}
