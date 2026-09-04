/**
 * The sanctioned dev entrypoint: one Electron desktop (which spawns the
 * opencode sidecar) plus one mobile PWA server, tied together by a run id.
 *
 * This used to be a bare `concurrently` invocation in package.json. It is a
 * script now because both halves have to inherit the *same*
 * `OPENCODE_DEV_RUN_ID`. That id is what lets the PWA server tell "the desktop
 * I was launched with" apart from "some other dev stack that happens to be
 * running" — historically the PWA would bind to whichever backend a
 * well-known file last named, which on a machine full of opencode processes
 * meant it regularly drove the wrong one.
 *
 * See packages/mobile/dev/handshake.ts for the rest of the binding contract.
 */
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const runID = process.env.OPENCODE_DEV_RUN_ID?.trim() || randomUUID()
const root = join(import.meta.dir, "..")

// Stale handshakes name dead instances. The desktop clears this at startup
// too, but doing it here closes the window before Electron gets that far.
for (const stale of [".opencode-dev-handshake.json", ".opencode-dev-url"]) {
  try {
    await Bun.file(join(root, "..", "mobile", stale)).delete()
  } catch {}
}

console.log(`[opencode:dev] run ${runID}`)

// Run concurrently's entry through bun rather than its shim, so this works
// the same on Windows (where .bin holds a .cmd/.exe) as it does elsewhere.
const concurrently = (() => {
  try {
    const manifest = createRequire(import.meta.url).resolve("concurrently/package.json")
    return join(dirname(manifest), "dist", "bin", "concurrently.js")
  } catch {
    return undefined
  }
})()
if (!concurrently) throw new Error("concurrently is not installed — run `bun install` at the repo root")

const child = Bun.spawn(
  [
    "bun",
    concurrently,
    "-n",
    "desktop,pwa",
    "-c",
    "blue,green",
    // Both halves live and die together. A PWA server that outlives its
    // desktop is the hazard this whole change exists to remove: it would sit
    // on :3301 waiting to be pointed at the next dev stack's backend.
    "--kill-others",
    "bun ./scripts/dev-electron.ts",
    "bun --cwd ../mobile dev",
  ],
  {
    cwd: root,
    env: { ...process.env, OPENCODE_DEV_RUN_ID: runID },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
)

const stop = () => child.kill()
process.once("SIGINT", stop)
process.once("SIGTERM", stop)

process.exitCode = await child.exited
process.off("SIGINT", stop)
process.off("SIGTERM", stop)
