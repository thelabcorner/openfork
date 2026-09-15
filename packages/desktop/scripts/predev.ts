import { $ } from "bun"
import { buildLocalCliToResources } from "./utils"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

// V1 and V2 are mutually exclusive runtime backends. Building both on every
// launch made the default V1 dev path compile + smoke-test a Bun executable it
// never starts, then force-rebuild the Node sidecar even when its inputs were
// unchanged. Build only the artifact this launch can actually consume and let
// build-node's freshness check decide whether V1 needs a rebuild.
if (process.env.OPENCODE_SIDECAR_V2 === "1") {
  await buildLocalCliToResources()
} else {
  await $`bun --cwd ../opencode script/build-node.ts`
}
