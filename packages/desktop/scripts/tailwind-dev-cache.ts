import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fsSync from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"

const CACHE_SCHEMA = 2
const DESKTOP_DIR = fileURLToPath(new URL("..", import.meta.url))
const REPO_DIR = path.resolve(DESKTOP_DIR, "../..")
const STYLESHEET = path.join(REPO_DIR, "packages/app/src/index.css")
const CACHE_DIR = path.join(DESKTOP_DIR, "node_modules/.cache/opencode-desktop/tailwind")
const CACHE_CSS = path.join(CACHE_DIR, "app.css")
const CACHE_META = path.join(CACHE_DIR, "meta.json")
const VIRTUAL_ID = "\0opencode:tailwind-dev-cache"
const STYLESHEET_URL = `/@fs/${STYLESHEET.replaceAll("\\", "/")}`

const SOURCE_ROOTS = [
  path.join(REPO_DIR, "packages/app/src"),
  path.join(REPO_DIR, "packages/ui/src"),
  path.join(REPO_DIR, "packages/session-ui/src"),
  path.join(REPO_DIR, "packages/desktop/src"),
  path.join(REPO_DIR, "packages/mobile/src"),
] as const

// These can change Tailwind/Vite output without changing a source-tree mtime.
const CACHE_SALTS = [
  path.join(REPO_DIR, "packages/app/vite.js"),
  path.join(REPO_DIR, "packages/desktop/electron.vite.config.ts"),
  path.join(REPO_DIR, "bun.lock"),
] as const

const gitPaths = [...SOURCE_ROOTS, ...CACHE_SALTS].map((file) => path.relative(REPO_DIR, file).replaceAll("\\", "/"))
const debugEnabled = process.env.OPENCODE_TAILWIND_CACHE_DEBUG === "1"
const debug = (message: string) => {
  if (debugEnabled) console.error(`[tailwind-cache] ${message}`)
}

type CacheMeta = {
  schema: number
  fingerprint: string
  cssHash: string
}

const normalize = (value: string) => {
  const resolved = path.resolve(value).replaceAll("\\", "/")
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}
const stylesheetKey = normalize(STYLESHEET)
const sourceKeys = SOURCE_ROOTS.map(normalize)

function isStylesheet(id: string) {
  return normalize(id.split("?", 1)[0]!) === stylesheetKey
}

function isStylesheetRequest(id: string) {
  return id === "@/index.css" || isStylesheet(id)
}

function isTailwindSource(file: string) {
  const key = normalize(file)
  return sourceKeys.some((root) => key === root || key.startsWith(`${root}/`))
}

async function fingerprintTree() {
  const files: Array<{ key: string; absolute: string }> = []

  const walk = async (root: string, current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true })
    await Promise.all(
      entries.map(async (entry) => {
        const absolute = path.join(current, entry.name)
        if (entry.isDirectory()) return walk(root, absolute)
        if (!entry.isFile()) return
        const relative = path.relative(root, absolute).replaceAll("\\", "/")
        files.push({ key: `${normalize(root)}:${relative}`, absolute })
      }),
    )
  }

  await Promise.all(SOURCE_ROOTS.map((root) => walk(root, root)))
  for (const file of CACHE_SALTS) files.push({ key: `salt:${normalize(file)}`, absolute: file })
  files.sort((a, b) => a.key.localeCompare(b.key))

  const hash = createHash("sha256")
  hash.update(`schema:${CACHE_SCHEMA}\n`)
  for (const file of files) {
    hash.update(file.key).update("\0")
    hash.update(await fs.readFile(file.absolute))
    hash.update("\n")
  }
  return hash.digest("hex")
}

function gitOutput(args: string[]) {
  const stdout = execFileSync("git", args, {
    cwd: REPO_DIR,
    encoding: "buffer" as never,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  }) as Buffer
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
}

function nulPaths(output: Buffer) {
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
}

function pathAfterFields(record: string, fieldCount: number) {
  let offset = 0
  for (let i = 0; i < fieldCount; i++) {
    const next = record.indexOf(" ", offset)
    if (next < 0) return
    offset = next + 1
  }
  return record.slice(offset)
}

function hashWorkingPath(hash: ReturnType<typeof createHash>, relative: string) {
  const absolute = path.join(REPO_DIR, relative)
  hash.update(`working:${relative}\0`)

  let stat
  try {
    stat = fsSync.lstatSync(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    hash.update("<deleted>\n")
    return
  }

  if (!stat.isDirectory()) {
    hash.update(fsSync.readFileSync(absolute))
    hash.update("\n")
    return
  }

  // `git status --ignored=matching` can report a whole ignored directory.
  // Hash its descendants explicitly so edits inside it still invalidate the
  // cache even though git intentionally collapses the status record.
  const entries: string[] = []
  const walk = (current: string): void => {
    const children = fsSync.readdirSync(current, { withFileTypes: true })
    for (const child of children) {
      const file = path.join(current, child.name)
      if (child.isDirectory()) walk(file)
      else if (child.isFile() || child.isSymbolicLink()) entries.push(file)
    }
  }
  walk(absolute)
  entries.sort()
  for (const file of entries) {
    hash.update(`${path.relative(REPO_DIR, file).replaceAll("\\", "/")}\0`)
    hash.update(fsSync.readFileSync(file))
    hash.update("\n")
  }
}

function fingerprintGitState() {
  const started = performance.now()
  // Porcelain v2 gives us the current HEAD OID plus tracked, staged, untracked,
  // and ignored state in one git process. Spawning four git.exe instances on
  // Windows was cheap in isolation but could take ~0.5-1s under Vite's heavy
  // transform wave.
  const gitStarted = performance.now()
  const status = gitOutput([
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--untracked-files=all",
    "--ignored=matching",
    "--",
    ...gitPaths,
  ])
  const gitMs = performance.now() - gitStarted

  const records = nulPaths(status)
  let head: string | undefined
  const changed: string[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    if (record.startsWith("# branch.oid ")) {
      head = record.slice("# branch.oid ".length)
      continue
    }
    if (record.startsWith("1 ")) {
      const file = pathAfterFields(record, 8)
      if (file) changed.push(file)
      continue
    }
    if (record.startsWith("2 ")) {
      const file = pathAfterFields(record, 9)
      if (file) changed.push(file)
      // Rename/copy records carry the original path as the next NUL record.
      i++
      continue
    }
    if (record.startsWith("u ")) {
      const file = pathAfterFields(record, 10)
      if (file) changed.push(file)
      continue
    }
    if (record.startsWith("? ") || record.startsWith("! ")) changed.push(record.slice(2))
  }
  if (!head || head === "(initial)") throw new Error("git HEAD unavailable")

  const hash = createHash("sha256")
  hash.update(`schema:${CACHE_SCHEMA}\n`)
  hash.update(head)

  const hashStarted = performance.now()
  for (const relative of [...new Set(changed)].sort()) hashWorkingPath(hash, relative)
  const result = hash.digest("hex")
  debug(
    `fingerprint git=${Math.round(gitMs)}ms hash=${Math.round(performance.now() - hashStarted)}ms total=${Math.round(performance.now() - started)}ms paths=${new Set(changed).size}`,
  )
  return result
}

async function fingerprintSources() {
  try {
    return fingerprintGitState()
  } catch {
    // A source checkout without git metadata is unusual for desktop dev, but
    // stale CSS is worse than a slower restart. Fall back to the full tree.
    return fingerprintTree()
  }
}

async function readCache() {
  const started = performance.now()
  try {
    const [rawMeta, css] = await Promise.all([fs.readFile(CACHE_META, "utf8"), fs.readFile(CACHE_CSS, "utf8")])
    const meta = JSON.parse(rawMeta) as CacheMeta
    if (meta.schema !== CACHE_SCHEMA || !meta.fingerprint || !meta.cssHash || !css) {
      debug(`miss invalid metadata in ${Math.round(performance.now() - started)}ms`)
      return
    }
    if (createHash("sha256").update(css).digest("hex") !== meta.cssHash) {
      debug(`miss css hash mismatch in ${Math.round(performance.now() - started)}ms`)
      return
    }
    if ((await fingerprintSources()) !== meta.fingerprint) {
      debug(`miss stale fingerprint in ${Math.round(performance.now() - started)}ms`)
      return
    }
    debug(`hit validated in ${Math.round(performance.now() - started)}ms`)
    return css
  } catch {
    debug(`miss unavailable in ${Math.round(performance.now() - started)}ms`)
    return
  }
}

async function writeAtomic(file: string, contents: string) {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fs.writeFile(temp, contents)
  await fs.rename(temp, file)
}

async function persistCache(css: string, fingerprint: string) {
  await fs.mkdir(CACHE_DIR, { recursive: true })
  const cssHash = createHash("sha256").update(css).digest("hex")
  await writeAtomic(CACHE_CSS, css)
  // Metadata is the commit record and is intentionally written last. The CSS
  // hash makes a crash between the two atomic renames degrade to a cache miss
  // instead of allowing a mismatched CSS/meta pair to be served.
  await writeAtomic(CACHE_META, JSON.stringify({ schema: CACHE_SCHEMA, fingerprint, cssHash } satisfies CacheMeta))
}

async function removeCache() {
  await Promise.all([fs.rm(CACHE_CSS, { force: true }), fs.rm(CACHE_META, { force: true })])
}

function extractCompiledCss(code: string) {
  const prefix = "const __vite__css = "
  const start = code.indexOf(prefix)
  if (start < 0) return
  const valueStart = start + prefix.length
  const end = code.indexOf("\n__vite__updateStyle", valueStart)
  if (end < 0) return
  try {
    const value = JSON.parse(code.slice(valueStart, end).trim())
    return typeof value === "string" ? value : undefined
  } catch {
    return
  }
}

/**
 * Reuses Tailwind's already-compiled app stylesheet across unchanged desktop
 * dev-server restarts. A source edit permanently returns the current process
 * to the normal Tailwind pipeline, preserving Tailwind's own HMR behavior.
 */
export function tailwindDevCachePlugins(): Plugin[] {
  let cacheActive = true
  let cacheServed = false
  let cachedCss: string | undefined
  let sourceGeneration = 0
  let cacheRead: Promise<string | undefined> | undefined
  let persistQueue = Promise.resolve()
  let compileFingerprint: string | undefined
  let compileGeneration = -1

  const invalidate = () => {
    sourceGeneration++
    if (!cacheActive) return false
    cacheActive = false
    debug("disabled after source change")
    void removeCache()
    return true
  }

  const loader: Plugin = {
    name: "opencode:tailwind-dev-cache-load",
    enforce: "pre",
    async configureServer(server) {
      server.watcher.add([...SOURCE_ROOTS])
      server.watcher.on("all", (event, file) => {
        if (event !== "add" && event !== "change" && event !== "unlink") return
        if (!isTailwindSource(file)) return

        const deactivated = invalidate()
        if (!deactivated || !cacheServed) return

        const virtual = server.moduleGraph.getModuleById(VIRTUAL_ID)
        if (virtual) server.moduleGraph.invalidateModule(virtual)
        server.ws.send({ type: "full-reload", path: "*" })
      })

      // Validate before Vite saturates the transform graph. Letting this run in
      // the background made an otherwise ~40ms git query contend with hundreds
      // of transforms on Windows and occasionally stretch past a second. The
      // watcher is attached first so a source edit during validation disables
      // the cache before it can ever be served.
      cacheRead ??= readCache()
      await cacheRead
    },
    async resolveId(id) {
      if (!cacheActive || !isStylesheetRequest(id)) return
      cacheRead ??= readCache()
      const css = await cacheRead
      if (!css) return
      cacheServed = true
      cachedCss = css
      debug(`serving ${css.length} bytes`)
      return VIRTUAL_ID
    },
    load(id) {
      if (id !== VIRTUAL_ID) return
      if (!cacheActive || !cachedCss) {
        return `import ${JSON.stringify(`${STYLESHEET_URL}?tailwind-cache-bypass=${sourceGeneration}`)}`
      }

      return `
import { updateStyle as __vite__updateStyle, removeStyle as __vite__removeStyle } from "/@vite/client"
const __vite__id = ${JSON.stringify(STYLESHEET)}
const __vite__css = ${JSON.stringify(cachedCss)}
__vite__updateStyle(__vite__id, __vite__css)
if (import.meta.hot) {
  import.meta.hot.accept()
  import.meta.hot.prune(() => __vite__removeStyle(__vite__id))
}
`
    },
    async transform(_code, id) {
      if (!isStylesheet(id) || (cacheActive && cacheServed)) return

      // Bracket every real Tailwind transform with a source fingerprint. The
      // post hook only persists when the source state is byte-identical before
      // and after compilation, preventing a watcher-latency race from caching
      // CSS compiled from an older source snapshot.
      compileGeneration = sourceGeneration
      compileFingerprint = await fingerprintSources()
    },
  }

  const capture: Plugin = {
    name: "opencode:tailwind-dev-cache-capture",
    enforce: "post",
    transform(code, id) {
      if (!isStylesheet(id) || (cacheActive && cacheServed)) return
      const css = extractCompiledCss(code)
      if (!css) return
      debug(`capturing ${css.length} bytes`)

      const generation = sourceGeneration
      const before = compileGeneration === generation ? compileFingerprint : undefined
      if (!before) return
      persistQueue = persistQueue
        .then(async () => {
          const fingerprint = await fingerprintSources()
          if (generation !== sourceGeneration) return
          if (fingerprint !== before) {
            debug("skipping cache write because sources changed during compilation")
            return
          }
          await persistCache(css, fingerprint)
        })
        .catch(() => undefined)
    },
    async closeBundle() {
      await persistQueue
    },
  }

  return [loader, capture]
}
