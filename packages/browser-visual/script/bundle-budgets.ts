import { gzipSync } from "node:zlib"
import { readFile, readdir, stat } from "node:fs/promises"
import { basename, resolve } from "node:path"

const repo = resolve(import.meta.dir, "../../..")

type Budget = {
  label: string
  path: string
  maxBytes: number
  maxGzipBytes?: number
}

const budgets: Budget[] = [
  {
    label: "Chrome ordinary content script",
    path: resolve(repo, "extensions/chrome/src/content/content.js"),
    maxBytes: 25 * 1024,
    maxGzipBytes: 8 * 1024,
  },
  {
    label: "Chrome lazy SnapEye runtime",
    path: resolve(repo, "extensions/chrome/src/content/visual.bundle.js"),
    maxBytes: 512 * 1024,
    maxGzipBytes: 160 * 1024,
  },
  {
    label: "Electron ordinary guest preload",
    path: resolve(repo, "packages/desktop/out/preload/preview.js"),
    maxBytes: 48 * 1024,
    maxGzipBytes: 16 * 1024,
  },
  {
    label: "Electron lazy SnapEye runtime",
    path: resolve(repo, "packages/desktop/out/preload/visual-runtime.js"),
    maxBytes: 512 * 1024,
    maxGzipBytes: 160 * 1024,
  },
]

// Measure the renderer bundle users actually receive in the Electron app. The
// standalone packages/app/dist tree can be stale after an Electron build and
// previously made this verifier report an old, smaller hash. Fail if the
// shipping chunks are missing/ambiguous or older than the source entrypoints.
const desktopAssets = resolve(repo, "packages/desktop/out/renderer/assets")
const desktopEntries = await readdir(desktopAssets).catch(() => [])
const browserPanel = uniqueChunk(desktopEntries, /^browser-panel-v2-.*\.js$/, "browser-panel-v2")
const inspector = uniqueChunk(desktopEntries, /^VisualInspector-.*\.js$/, "VisualInspector")
if (!browserPanel || !inspector) {
  throw new Error("Desktop renderer visual chunks are missing; run packages/desktop build before the SnapEye bundle budget verifier")
}
const browserPanelPath = resolve(desktopAssets, browserPanel)
const inspectorPath = resolve(desktopAssets, inspector)
await assertFresh(browserPanelPath, [resolve(repo, "packages/app/src/pages/session/v2/browser-panel-v2.tsx")], "browser-panel-v2")
await assertFresh(inspectorPath, [resolve(repo, "packages/app/src/pages/session/v2/browser/VisualInspector.tsx")], "VisualInspector")
budgets.push({
  label: "Desktop ordinary browser panel",
  path: browserPanelPath,
  maxBytes: 128 * 1024,
  maxGzipBytes: 40 * 1024,
})
budgets.push({
  label: "Desktop lazy Visual Inspector",
  path: inspectorPath,
  maxBytes: 48 * 1024,
  maxGzipBytes: 12 * 1024,
})

const rows: Array<{ label: string; file: string; bytes: number; gzipBytes: number; maxBytes: number; maxGzipBytes?: number }> = []
for (const budget of budgets) {
  const bytes = await readFile(budget.path).catch(() => null)
  if (!bytes) {
    throw new Error(
      `${budget.label} is missing at ${budget.path}. Build the Chrome extension, Desktop package, and app before running the SnapEye bundle budget verifier.`,
    )
  }
  if (bytes.byteLength > budget.maxBytes) {
    throw new Error(`${budget.label} exceeded its bundle budget: ${bytes.byteLength} > ${budget.maxBytes} bytes`)
  }
  const gzipBytes = gzipSync(bytes).byteLength
  if (budget.maxGzipBytes !== undefined && gzipBytes > budget.maxGzipBytes) {
    throw new Error(`${budget.label} exceeded its gzip bundle budget: ${gzipBytes} > ${budget.maxGzipBytes} bytes`)
  }
  rows.push({
    label: budget.label,
    file: basename(budget.path),
    bytes: bytes.byteLength,
    gzipBytes,
    maxBytes: budget.maxBytes,
    ...(budget.maxGzipBytes !== undefined ? { maxGzipBytes: budget.maxGzipBytes } : {}),
  })
}

// Source-level guards are deliberately separate from emitted-size budgets. A
// minifier can make an accidental eager import look deceptively small for one
// version; the architectural rule is stronger: the ordinary browsing entries
// must not import the visual engine or review workbench at all.
const chromeContentSource = await readFile(resolve(repo, "extensions/chrome/src/content/content.ts"), "utf8")
assertAbsent(chromeContentSource, "@opencode-ai/browser-visual", "Chrome ordinary content entry")
assertAbsent(chromeContentSource, "./visual", "Chrome ordinary content entry")

const guestPreloadSource = await readFile(resolve(repo, "packages/desktop/src/guest/preview-preload.ts"), "utf8")
assertAbsent(guestPreloadSource, "@opencode-ai/browser-visual", "Electron ordinary guest preload")
assertAbsent(guestPreloadSource, "./visual-runtime", "Electron ordinary guest preload")

// SnapEye's upstream default GIF quantizer comes from gifenc's PnnQuant-derived
// module (MPL-2.0 upstream). OpenFork replaces that top-level import at bundle
// time with packages/browser-visual/src/gifenc-safe.ts. This guard makes the
// licensing/performance boundary mechanically enforceable: a future alias
// regression must fail certification instead of silently shipping PnnQuant.
for (const [label, path] of [
  ["Chrome lazy SnapEye runtime", resolve(repo, "extensions/chrome/src/content/visual.bundle.js")],
  ["Electron lazy SnapEye runtime", resolve(repo, "packages/desktop/out/preload/visual-runtime.js")],
] as const) {
  const source = await readFile(path, "utf8")
  for (const forbidden of ["PnnQuant.js", "pnnquant2.js", "Mark Tyler and Dmitry Groshev", "Miller Cy Chan"]) {
    assertAbsent(source, forbidden, label)
  }
}

const browserPanelSource = await readFile(resolve(repo, "packages/app/src/pages/session/v2/browser-panel-v2.tsx"), "utf8")
if (!browserPanelSource.includes('lazy(() =>') || !browserPanelSource.includes('import("./browser/VisualInspector")')) {
  throw new Error("VisualInspector must remain a lazy dynamic import from the ordinary browser panel")
}
if (/^import\s+\{?\s*VisualInspector/m.test(browserPanelSource)) {
  throw new Error("VisualInspector regressed to an eager browser-panel import")
}

const canonicalNotices = await readFile(resolve(repo, "packages/browser-visual/THIRD_PARTY_NOTICES.txt"))
const extensionNotices = await readFile(resolve(repo, "extensions/chrome/THIRD_PARTY_NOTICES.snapeye.txt")).catch(() => null)
if (!extensionNotices || !canonicalNotices.equals(extensionNotices)) {
  throw new Error("Chrome SnapEye third-party notice is missing/stale; rebuild extensions/chrome")
}
const electronBuilderSource = await readFile(resolve(repo, "packages/desktop/electron-builder.config.ts"), "utf8")
for (const required of [
  "../browser-visual/THIRD_PARTY_NOTICES.txt",
  "licenses/SnapEye-THIRD_PARTY_NOTICES.txt",
]) {
  if (!electronBuilderSource.includes(required)) throw new Error(`Desktop packaging no longer ships SnapEye notices: missing ${required}`)
}

console.log(JSON.stringify({ ok: true, rows }, null, 2))

function assertAbsent(source: string, needle: string, label: string) {
  if (source.includes(needle)) throw new Error(`${label} must not eagerly depend on ${needle}`)
}

function uniqueChunk(entries: string[], pattern: RegExp, label: string): string | null {
  const matches = entries.filter((entry) => pattern.test(entry))
  if (matches.length === 0) return null
  if (matches.length !== 1) throw new Error(`Expected one ${label} build chunk, found ${matches.length}`)
  return matches[0]!
}

async function assertFresh(output: string, sources: string[], label: string): Promise<void> {
  const outputStat = await stat(output).catch(() => null)
  if (!outputStat) throw new Error(`${label} output is missing: ${output}`)
  for (const source of sources) {
    const sourceStat = await stat(source)
    if (sourceStat.mtimeMs > outputStat.mtimeMs + 1) {
      throw new Error(`${label} output is stale relative to ${source}; rebuild packages/desktop before verifying bundle budgets`)
    }
  }
}
