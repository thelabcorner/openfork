import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { gzipSync } from "node:zlib"

type Kind = "js" | "css" | "other"
type Asset = {
  ref: string
  raw: number
  gzip: number
  kind: Kind
}

const root = resolve(import.meta.dir, "..")
const dist = resolve(root, "dist")
const html = readFileSync(resolve(dist, "index.html"), "utf8")

function asset(ref: string): Asset {
  const bytes = readFileSync(resolve(dist, ref.replace(/^\//, "")))
  return {
    ref,
    raw: bytes.byteLength,
    gzip: gzipSync(bytes).byteLength,
    kind: ref.endsWith(".css") ? "css" : ref.endsWith(".js") ? "js" : "other",
  }
}

function totals(assets: readonly Asset[]) {
  const gzip = (kind: "js" | "css") =>
    assets.filter((item) => item.kind === kind).reduce((sum, item) => sum + item.gzip, 0)
  const js = gzip("js")
  const css = gzip("css")
  return { js, css, total: assets.reduce((sum, item) => sum + item.gzip, 0) }
}

function kib(value: number) {
  return (value / 1024).toFixed(1)
}

function report(label: string, assets: readonly Asset[]) {
  const size = totals(assets)
  console.log(
    `[pwa-budget] ${label}: ${kib(size.total)} KiB gzip total (${kib(size.js)} KiB JS + ${kib(size.css)} KiB CSS)`,
  )
  for (const item of assets) {
    console.log(`[pwa-budget]   ${item.ref}: ${kib(item.gzip)} KiB gzip / ${kib(item.raw)} KiB raw`)
  }
  return size
}

function failuresFor(
  label: string,
  size: ReturnType<typeof totals>,
  budget: { js: number; css: number; total: number },
) {
  return [
    size.js > budget.js ? `${label} JS ${kib(size.js)} > ${kib(budget.js)} KiB` : undefined,
    size.css > budget.css ? `${label} CSS ${kib(size.css)} > ${kib(budget.css)} KiB` : undefined,
    size.total > budget.total ? `${label} total ${kib(size.total)} > ${kib(budget.total)} KiB` : undefined,
  ].filter((value): value is string => value !== undefined)
}

const bootstrapRefs = [
  ...new Set([...html.matchAll(/(?:src|href)=["'](\/assets\/[^"'?#]+)["']/g)].map((match) => match[1])),
]
if (bootstrapRefs.length === 0) {
  console.error("[pwa-budget] no built bootstrap assets found in dist/index.html")
  process.exit(1)
}
const bootstrapAssets = bootstrapRefs.map(asset)

const assetNames = readdirSync(resolve(dist, "assets"))

const connectedRefs = assetNames
  .filter((name) => /^pwa-client-[^.]+\.(?:js|css)$/.test(name))
  .map((name) => `/assets/${name}`)
  .sort()

const scheduledRefs = assetNames
  .filter((name) => /^scheduled-[^.]+\.(?:js|css)$/.test(name))
  .map((name) => `/assets/${name}`)
  .sort()

const oxpRefs = assetNames
  .filter((name) => /^oxp(?:-activity)?-[^.]+\.(?:js|css)$/.test(name))
  .map((name) => `/assets/${name}`)
  .sort()

const sessionStyleSignature = "[data-component=tool-trigger]"
const cssRefs = assetNames.filter((name) => name.endsWith(".css")).map((name) => `/assets/${name}`)
const sessionStyleRefs = cssRefs
  .filter((ref) => readFileSync(resolve(dist, ref.replace(/^\//, "")), "utf8").includes(sessionStyleSignature))
  .sort()

if (!connectedRefs.some((ref) => ref.endsWith(".js"))) {
  console.error("[pwa-budget] no connected pwa-client JavaScript asset found in dist/assets")
  process.exit(1)
}
if (!scheduledRefs.some((ref) => ref.endsWith(".js"))) {
  console.error("[pwa-budget] no dedicated Scheduled route JavaScript asset found in dist/assets")
  process.exit(1)
}
if (!oxpRefs.some((ref) => ref.endsWith(".js"))) {
  console.error("[pwa-budget] no dedicated OXP route JavaScript asset found in dist/assets")
  process.exit(1)
}
if (sessionStyleRefs.length !== 1) {
  console.error(`[pwa-budget] expected exactly one deferred session-ui stylesheet, found ${sessionStyleRefs.length}`)
  process.exit(1)
}
if (connectedRefs.some((ref) => ref.endsWith(".css") && sessionStyleRefs.includes(ref))) {
  console.error("[pwa-budget] session-ui stylesheet leaked into the connected runtime entry")
  process.exit(1)
}

const connectedAssets = connectedRefs.map(asset)
const scheduledAssets = scheduledRefs.map(asset)
const oxpAssets = oxpRefs.map(asset)
const sessionStyleAssets = sessionStyleRefs.map(asset)
const readJavaScript = (refs: readonly string[]) =>
  refs
    .filter((ref) => ref.endsWith(".js"))
    .map((ref) => readFileSync(resolve(dist, ref.replace(/^\//, "")), "utf8"))
    .join("\n")

const connectedJavaScript = readJavaScript(connectedRefs)
const scheduledJavaScript = readJavaScript(scheduledRefs)
const oxpJavaScript = readJavaScript(oxpRefs)

const bootstrap = report("bootstrap", bootstrapAssets)
const connected = report("connected runtime entry", connectedAssets)
const sessionStyles = report("deferred session styles", sessionStyleAssets)
const scheduled = report("Scheduled route", scheduledAssets)
const oxp = report("OXP routes", oxpAssets)

// Bootstrap protects the unpaired/verification shell. Connected-runtime limits
// protect the healthy trusted transition after pairing, not demand-loaded
// settings/toast/route surfaces. Route budgets additionally prevent independent
// management surfaces from silently collapsing back into one shared payload.
// The connected ceilings retain modest headroom over the measured production
// baseline (~191 KiB JS / ~247 KiB total) while making previously eager Settings,
// toast, route dictionaries, desktop-only copy, session timeline CSS, generated
// all-endpoints SDK, or the old Effect-backed entry immediate build regressions.
const budgets = {
  bootstrap: {
    js: 24 * 1024,
    css: 8 * 1024,
    total: 30 * 1024,
  },
  connected: {
    js: 198 * 1024,
    css: 64 * 1024,
    total: 258 * 1024,
  },
  sessionStyles: {
    js: 0,
    css: 20 * 1024,
    total: 20 * 1024,
  },
  scheduled: {
    js: 30 * 1024,
    css: 4 * 1024,
    total: 32 * 1024,
  },
  oxp: {
    js: 21 * 1024,
    css: 4 * 1024,
    total: 24 * 1024,
  },
}

const forbiddenConnectedTokens = [
  "oxpActivity.tab.title",
  "settings.oxp.title",
  "settings.ofxp.rotation.confirmTitle",
  "settings.general.row.compactionModel.small.title",
  "settings.shortcuts.title",
  "Staplebops 01",
  "prompt.revision.title",
  "projectExplorer.contextMenu.addToChat",
  "settings.permissions.tool.read.description",
  "scheduledTasks.calendar.reset.toggle",
  "scheduledTasks.editor.title",
  "settings.section.desktop",
  "app.name.desktop",
  "wsl.onboarding.installWsl",
  "help.tabs.title",
  "debugBar.ariaLabel",
] as const

const boundaryFailures = [
  ...forbiddenConnectedTokens
    .filter((token) => connectedJavaScript.includes(token))
    .map((token) => `connected runtime unexpectedly contains lazy-only token ${token}`),
  ...(scheduledJavaScript.includes("oxpActivity.tab.title")
    ? ["Scheduled route unexpectedly contains OXP Activity translations"]
    : []),
  ...(oxpJavaScript.includes("scheduledTasks.editor.title")
    ? ["OXP route unexpectedly contains Scheduled translations"]
    : []),
]

const failures = [
  ...failuresFor("bootstrap", bootstrap, budgets.bootstrap),
  ...failuresFor("connected", connected, budgets.connected),
  ...failuresFor("deferred session styles", sessionStyles, budgets.sessionStyles),
  ...failuresFor("Scheduled route", scheduled, budgets.scheduled),
  ...failuresFor("OXP routes", oxp, budgets.oxp),
  ...boundaryFailures,
]

if (failures.length > 0) {
  console.error(`[pwa-budget] budget exceeded: ${failures.join(", ")}`)
  process.exit(1)
}
