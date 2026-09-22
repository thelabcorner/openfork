import watcher from "@parcel/watcher"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
const opencodePackage = path.join(repoRoot, "packages", "opencode")
const inputDirs = [
  path.join(repoRoot, "packages", "opencode", "src"),
  path.join(repoRoot, "packages", "opencode", "script"),
  path.join(repoRoot, "packages", "core", "src"),
  path.join(repoRoot, "packages", "protocol", "src"),
  path.join(repoRoot, "packages", "plugin", "src"),
]
const inputFiles = new Set([
  path.join(repoRoot, "packages", "opencode", "package.json"),
  path.join(repoRoot, "bun.lock"),
].map(normalize))

function normalize(value: string) {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function within(root: string, value: string) {
  const relative = path.relative(root, value)
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  )
}

function isBackendInput(value: string) {
  const resolved = path.resolve(value)
  const key = normalize(resolved)
  return (
    inputFiles.has(key) ||
    inputDirs.some((root) => within(path.resolve(root), resolved))
  )
}

let dirty = false
let building = false
let timer: ReturnType<typeof setTimeout> | undefined
let stopping = false
let activeBuild: ReturnType<typeof spawn> | undefined

async function rebuild() {
  if (building || stopping) return
  building = true
  try {
    while (dirty && !stopping) {
      dirty = false
      console.log(
        "[opencode:node-sidecar] rebuilding candidate backend artifact; activation remains explicit via OXP runtime.refresh",
      )
      const child = spawn("bun", ["script/build-node.ts"], {
        cwd: opencodePackage,
        stdio: "inherit",
        windowsHide: true,
      })
      activeBuild = child
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", (exitCode) => resolve(exitCode))
      })
      activeBuild = undefined
      if (code === 75) {
        dirty = true
        await new Promise((resolve) => setTimeout(resolve, 250))
        continue
      }
      if (code !== 0) {
        console.error(
          `[opencode:node-sidecar] candidate build failed (exit ${code ?? "unknown"}); active OXP runtime is unchanged`,
        )
      } else {
        console.log(
          "[opencode:node-sidecar] candidate backend ready; use OXP runtime.refresh to trial/accept it",
        )
      }
    }
  } finally {
    building = false
    if (dirty && !stopping) schedule()
  }
}

function schedule() {
  dirty = true
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    void rebuild()
  }, 100)
  timer.unref?.()
}

const subscription = await watcher.subscribe(
  repoRoot,
  (error, events) => {
    if (error) {
      console.error("[opencode:node-sidecar] watcher error", error)
      return
    }
    if (events.some((event) => isBackendInput(event.path))) schedule()
  },
  {
    ignore: [
      "**/.git/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/.turbo/**",
    ],
  },
)

console.log(
  "[opencode:node-sidecar] watching backend sources; rebuilds are staged, never auto-activated",
)
// One freshness pass after startup is intentional. If crash recovery restored a
// previously accepted artifact, its preserved mtime lets build-node stage the
// newer source tree again without making that candidate authoritative.
schedule()

const stop = async () => {
  if (stopping) return
  stopping = true
  if (timer) clearTimeout(timer)
  activeBuild?.kill()
  await subscription.unsubscribe().catch(() => undefined)
}

process.once("SIGINT", () => {
  void stop().finally(() => process.exit(0))
})
process.once("SIGTERM", () => {
  void stop().finally(() => process.exit(0))
})

await new Promise<never>(() => {})
