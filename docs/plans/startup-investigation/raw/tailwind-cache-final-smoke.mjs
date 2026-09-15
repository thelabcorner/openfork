import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

const repo = path.resolve(import.meta.dirname, "../../../..")
const desktop = path.join(repo, "packages/desktop")
const app = path.join(repo, "packages/app")
const stylesheet = path.join(app, "src/index.css")
const stylesheetUrl = `/@fs/${stylesheet.replaceAll("\\", "/")}`
const importer = path.join(app, "src/app.tsx")
const probeFile = path.join(app, "src/__tailwind_cache_final_probe__.tsx")
const cacheDir = path.join(desktop, "node_modules/.cache/opencode-desktop/tailwind")
const cacheCss = path.join(cacheDir, "app.css")
const cacheMeta = path.join(cacheDir, "meta.json")
const viteCache = path.join(desktop, "node_modules/.cache/opencode-desktop/tailwind-smoke-vite")

process.chdir(desktop)
process.env.OPENCODE_TAILWIND_CACHE_DEBUG = "1"

const require = createRequire(path.join(desktop, "package.json"))
const { resolveConfig } = await import(pathToFileURL(require.resolve("electron-vite")).href)
const { createServer } = await import(pathToFileURL(require.resolve("vite")).href)

async function server() {
  const resolved = await resolveConfig({}, "serve")
  const config = resolved.config.renderer
  config.cacheDir = viteCache
  config.server = { ...config.server, middlewareMode: true }
  config.optimizeDeps = { ...config.optimizeDeps, noDiscovery: true, include: [] }
  return createServer(config)
}

const sha = (value) => createHash("sha256").update(value).digest("hex")
const exists = (file) => fs.access(file).then(() => true, () => false)
const waitFor = async (predicate, timeout = 5000) => {
  const started = performance.now()
  while (performance.now() - started < timeout) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

async function compileReal(query) {
  const vite = await server()
  try {
    const result = await vite.transformRequest(`${stylesheetUrl}?${query}`)
    if (!result?.code.includes("__vite__css")) throw new Error("real CSS transform did not produce Vite CSS module")
  } finally {
    await vite.close()
  }
}

try {
  await fs.rm(cacheDir, { recursive: true, force: true })
  await fs.rm(viteCache, { recursive: true, force: true })

  await compileReal("populate=1")
  const initialCss = await fs.readFile(cacheCss, "utf8")
  const initialMeta = JSON.parse(await fs.readFile(cacheMeta, "utf8"))
  const initialIntegrity = initialMeta.schema === 2 && initialMeta.cssHash === sha(initialCss)

  const hitServer = await server()
  let initialHit
  try {
    initialHit = await hitServer.pluginContainer.resolveId("@/index.css", importer)
  } finally {
    await hitServer.close()
  }
  const initialVirtualHit = initialHit?.id === "\0opencode:tailwind-dev-cache"

  await fs.appendFile(cacheCss, "\n/* intentional-integrity-probe */\n")
  const tamperServer = await server()
  let tamperResolved
  try {
    tamperResolved = await tamperServer.pluginContainer.resolveId("@/index.css", importer)
  } finally {
    await tamperServer.close()
  }
  const tamperRejected = tamperResolved?.id !== "\0opencode:tailwind-dev-cache"

  await fs.rm(cacheDir, { recursive: true, force: true })
  await compileReal("restore=1")

  const hmrServer = await server()
  let invalidated = false
  let addedUtility = false
  let removedUtility = false
  let switchedToReal = false
  try {
    const before = await hmrServer.pluginContainer.resolveId("@/index.css", importer)
    if (before?.id !== "\0opencode:tailwind-dev-cache") throw new Error("restored cache was not served")

    await fs.writeFile(probeFile, `export const tailwindCacheProbe = <div class="mt-[123px]" />\n`)
    // Persistence may be repopulated immediately after the real Tailwind pass
    // so the *next* process starts warm. Do not use cache-file absence as the
    // invalidation oracle. Instead, wait until this server stops resolving the
    // stylesheet to the virtual cache module.
    invalidated = await waitFor(async () => {
      const resolved = await hmrServer.pluginContainer.resolveId("@/index.css", importer)
      return resolved?.id !== "\0opencode:tailwind-dev-cache"
    })
    const after = await hmrServer.pluginContainer.resolveId("@/index.css", importer)
    switchedToReal = after?.id !== "\0opencode:tailwind-dev-cache"

    const added = await hmrServer.transformRequest(`${stylesheetUrl}?probe-add=${Date.now()}`)
    addedUtility = added?.code.includes("123px") ?? false

    await fs.rm(probeFile, { force: true })
    await new Promise((resolve) => setTimeout(resolve, 150))
    const removed = await hmrServer.transformRequest(`${stylesheetUrl}?probe-remove=${Date.now()}`)
    removedUtility = !(removed?.code.includes("123px") ?? false)
  } finally {
    await fs.rm(probeFile, { force: true })
    await hmrServer.close()
  }

  const finalCss = await fs.readFile(cacheCss, "utf8")
  const finalMeta = JSON.parse(await fs.readFile(cacheMeta, "utf8"))
  const finalIntegrity = finalMeta.schema === 2 && finalMeta.cssHash === sha(finalCss)

  const finalServer = await server()
  let finalHit
  try {
    finalHit = await finalServer.pluginContainer.resolveId("@/index.css", importer)
  } finally {
    await finalServer.close()
  }

  console.log(JSON.stringify({
    initialIntegrity,
    initialVirtualHit,
    tamperRejected,
    invalidated,
    switchedToReal,
    addedUtility,
    removedUtility,
    finalIntegrity,
    finalVirtualHit: finalHit?.id === "\0opencode:tailwind-dev-cache",
    finalBytes: Buffer.byteLength(finalCss),
  }))
} finally {
  await fs.rm(probeFile, { force: true })
  await fs.rm(viteCache, { recursive: true, force: true })
}
