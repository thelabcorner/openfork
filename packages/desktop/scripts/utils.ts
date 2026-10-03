import { $ } from "bun"
import { copyFile } from "node:fs/promises"

export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(): Channel {
  const raw = Bun.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
}

export const RUST_TARGET = Bun.env.RUST_TARGET

export async function buildLocalCliToResources() {
  const target = `openfork-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
  await $`bun run --cwd ../opencode build --single --skip-install --skip-embed-web-ui`

  const source = windowsify(`../opencode/dist/${target}/bin/openfork`)
  const destination = windowsify("resources/openfork-cli")
  await copyFile(source, destination)
  await Bun.write("resources/openfork-cli.version", `local-${Date.now()}`)
  console.log(`Copied local OpenFork CLI from ${source} to ${destination}`)
}

export function windowsify(path: string) {
  if (path.endsWith(".exe")) return path
  return `${path}${process.platform === "win32" ? ".exe" : ""}`
}
