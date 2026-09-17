#!/usr/bin/env bun
import { $ } from "bun"

import { buildLocalCliToResources, downloadCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../opencode && bun script/build-node.ts`
// Dev builds normally pull a *pinned upstream* CLI npm package
// (`@opencode-ai/cli-*@0.0.0-next-*`, see utils.ts). A dev pre-release of this
// fork must ship the CLI built from the current source instead, so CI sets
// OPENCODE_DESKTOP_LOCAL_CLI=1 to build the host-platform binary from
// ../opencode and stage it into resources/.
if (channel === "dev") {
  if (process.env.OPENCODE_DESKTOP_LOCAL_CLI === "1") await buildLocalCliToResources()
  else await downloadCliToResources()
}
