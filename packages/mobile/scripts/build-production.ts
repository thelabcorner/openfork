import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

process.env.NODE_ENV = "production"

const { build } = await import("vite")
const result = await build()

// Keep the generated all-endpoints V2 SDK out of the connected PWA entry.
// Server bootstrap and SSE have deliberately narrow transports; endpoint
// surfaces load the generated client on first real method invocation. A static
// import here costs ~12 KiB gzip and restores duplicate stream machinery.
const outputs = (Array.isArray(result) ? result : [result]) as {
  output: { type: string; fileName: string; modules?: Record<string, unknown> }[]
}[]
const chunks = outputs.flatMap((output) => output.output).filter((item) => item.type === "chunk")
const connectedChunk = chunks.find(
  (chunk) => chunk.fileName.startsWith("assets/pwa-client-") && chunk.fileName.endsWith(".js"),
)
if (!connectedChunk?.modules) throw new Error("Expected a connected pwa-client JavaScript chunk")
const connectedModules = Object.keys(connectedChunk.modules).map((path) => path.replaceAll("\\", "/"))
const forbiddenConnectedModules = [
  "/packages/sdk/js/src/v2/gen/sdk.gen.ts",
  "/packages/sdk/js/src/v2/gen/client/client.gen.ts",
] as const
for (const suffix of forbiddenConnectedModules) {
  const match = connectedModules.find((path) => path.endsWith(suffix))
  if (match) throw new Error(`Generated SDK module leaked into connected PWA entry: ${match}`)
}

const root = resolve(import.meta.dir, "..")
const dist = resolve(root, "dist")
const workerPath = resolve(dist, "sw.js")
const placeholder = "__OPENFORK_PWA_RELEASE__"
const worker = readFileSync(workerPath)
const workerText = worker.toString("utf8")

const occurrences = workerText.split(placeholder).length - 1
if (occurrences !== 1) {
  throw new Error(`Expected exactly one ${placeholder} marker in dist/sw.js, found ${occurrences}`)
}

// index.html transitively fingerprints Vite's bootstrap graph. Include every
// stable-path precache artifact plus the worker template itself so a SW-only,
// manifest, or icon change also creates a new immutable cache generation.
const releaseInputs = [
  "index.html",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "badge-96.png",
] as const

const hash = createHash("sha256")
for (const name of releaseInputs) {
  const bytes = readFileSync(resolve(dist, name))
  hash.update(name)
  hash.update("\0")
  hash.update(bytes)
  hash.update("\0")
}
hash.update("sw.js\0")
hash.update(worker)

const release = hash.digest("hex").slice(0, 20)
writeFileSync(workerPath, workerText.replace(placeholder, release))
console.log(`[pwa-build] release ${release}`)
