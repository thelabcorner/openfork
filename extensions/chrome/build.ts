import { resolve } from "node:path"

const root = import.meta.dir
// Bun's emitted wrapper can vary with the ambient working directory even when
// every entrypoint is absolute. Make this builder hermetic so production builds
// and freshness checks produce identical bytes no matter which workspace
// package invoked it.
process.chdir(root)
const browserVisual = resolve(root, "../../packages/browser-visual/src/index.ts")
const browserTargeting = resolve(root, "../../packages/desktop/src/main/browser/scripts-resolve.ts")
const safeGifenc = resolve(root, "../../packages/browser-visual/src/gifenc-safe.ts")
const visualNotices = resolve(root, "../../packages/browser-visual/THIRD_PARTY_NOTICES.txt")
const extensionNotices = resolve(root, "THIRD_PARTY_NOTICES.snapeye.txt")
const checkOnly = process.argv.includes("--check")

const workspaceAlias = {
  name: "opencode-workspace-aliases",
  setup(build: { onResolve: (options: { filter: RegExp }, callback: () => { path: string }) => void }) {
    build.onResolve({ filter: /^@opencode-ai\/browser-visual$/ }, () => ({ path: browserVisual }))
    build.onResolve({ filter: /^@opencode-ai\/browser-targeting$/ }, () => ({ path: browserTargeting }))
    build.onResolve({ filter: /^gifenc$/ }, () => ({ path: safeGifenc }))
  },
}

const builds = [
  { entry: "src/background/sw.ts", outfile: "src/background/sw.bundle.js" },
  { entry: "src/content/content.ts", outfile: "src/content/content.js" },
  { entry: "src/content/visual.ts", outfile: "src/content/visual.bundle.js" },
] as const

let stale = false

for (const build of builds) {
  const result = await Bun.build({
    entrypoints: [resolve(root, build.entry)],
    target: "browser",
    format: "iife",
    minify: false,
    sourcemap: "none",
    naming: "[dir]/[name].[ext]",
    outdir: resolve(root, ".build-tmp"),
    plugins: [workspaceAlias],
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  const output = result.outputs[0]
  if (!output) throw new Error(`No output for ${build.entry}`)
  const destination = resolve(root, build.outfile)
  const generated = new Uint8Array(await output.arrayBuffer())
  if (checkOnly) {
    let committed: Uint8Array | null = null
    try {
      committed = new Uint8Array(await Bun.file(destination).arrayBuffer())
    } catch {}
    if (!committed || !bytesEqual(committed, generated)) {
      stale = true
      console.error(`stale generated Chrome bundle: ${build.outfile} (run: bun extensions/chrome/build.ts)`)
    }
  } else {
    await Bun.write(destination, generated)
  }
}

const noticeBytes = new Uint8Array(await Bun.file(visualNotices).arrayBuffer())
if (checkOnly) {
  let committed: Uint8Array | null = null
  try {
    committed = new Uint8Array(await Bun.file(extensionNotices).arrayBuffer())
  } catch {}
  if (!committed || !bytesEqual(committed, noticeBytes)) {
    stale = true
    console.error("stale generated Chrome SnapEye third-party notice (run: bun extensions/chrome/build.ts)")
  }
} else {
  await Bun.write(extensionNotices, noticeBytes)
}

await Bun.$`rm -rf ${resolve(root, ".build-tmp")}`
if (stale) process.exit(1)

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}
