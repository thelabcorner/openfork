import watcher from "@parcel/watcher"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { busyBuildRetryDelay, failedBuildRetryDelay } from "./node-sidecar-build-retry"

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
let busyRetryAttempt = 0
let failedRetryAttempt = 0

function resetRetryBudget() {
  busyRetryAttempt = 0
  failedRetryAttempt = 0
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

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
      const outcome = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
        child.once("error", (error) => resolve({ code: null, error }))
        child.once("exit", (exitCode) => resolve({ code: exitCode }))
      })
      activeBuild = undefined
      if (outcome.error) {
        console.error("[opencode:node-sidecar] candidate build process failed to start", outcome.error)
      }
      const code = outcome.code
      if (code === 75) {
        const delay = busyBuildRetryDelay(busyRetryAttempt++)
        if (delay === undefined) {
          console.error(
            "[opencode:node-sidecar] candidate artifact stayed busy through the retry budget; waiting for the next backend source change",
          )
          continue
        }
        dirty = true
        console.warn(
          `[opencode:node-sidecar] candidate artifact transaction busy; retrying in ${delay}ms`,
        )
        await sleep(delay)
        continue
      }
      busyRetryAttempt = 0
      if (code !== 0) {
        const delay = failedBuildRetryDelay(failedRetryAttempt++)
        console.error(
          `[opencode:node-sidecar] candidate build failed (exit ${code ?? "unknown"}); active OXP runtime is unchanged`,
        )
        if (delay !== undefined) {
          dirty = true
          console.warn(
            `[opencode:node-sidecar] retrying failed candidate build in ${delay}ms`,
          )
          await sleep(delay)
          continue
        }
        console.error(
          "[opencode:node-sidecar] candidate build retries exhausted; waiting for the next backend source change",
        )
      } else {
        failedRetryAttempt = 0
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
    if (events.some((event) => isBackendInput(event.path))) {
      resetRetryBudget()
      schedule()
    }
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
resetRetryBudget()
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
