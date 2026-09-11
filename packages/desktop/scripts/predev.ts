import { $ } from "bun"
import { buildLocalCliToResources } from "./utils"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

// Build the local CLI first, then force-refresh the (default V1) node sidecar
// so local server changes (e.g. quota/claude adapter) are picked up in
// `bun run dev` (the hodgepodge means dev sidecar != the exe). The CLI build
// deliberately preserves dist/node because a running sidecar may still be
// lazily reading sibling assets from that directory.
await buildLocalCliToResources()

await $`cd ../opencode && OPENCODE_FORCE_NODE_BUILD=1 bun script/build-node.ts`
