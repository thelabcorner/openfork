import { $ } from "bun"
import { buildLocalCliToResources } from "./utils"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

// The CLI build wipes ../opencode/dist (`rm -rf dist`), so it must run before
// build-node regenerates dist/node/node.js for the (default V1) sidecar.
// Force the node build so local server changes (e.g. quota/claude adapter) are
// picked up in `bun run dev` (the hodgepodge means dev sidecar != the exe).
await buildLocalCliToResources()

await $`cd ../opencode && OPENCODE_FORCE_NODE_BUILD=1 bun script/build-node.ts`
