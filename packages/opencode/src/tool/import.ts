import { pathToFileURL } from "url"

const DATA_URL_PREFIX = "data:text/javascript;base64,"

/**
 * Import a tool module fresh from disk, bypassing Bun's module cache.
 *
 * Bun keys dynamic imports by file pathname and ignores `?v=` query strings, so
 * re-importing the same file always returns the first-loaded module. Verified on
 * Bun 1.3.14 (win32): the working mechanism is to re-read the source, bundle it
 * in-memory so value imports (zod, relative siblings) are inlined, then load it
 * through a content-unique URL — unique content ⇒ unique specifier ⇒ fresh
 * module, same realm, no disk writes.
 *
 * Transport, in order:
 * 1. `data:` URL — the P0 mechanism from docs/architecture/tool-hot-reload.md.
 *    On win32, Bun rejects data: URLs whose payload exceeds roughly 64-128KB
 *    ("NameTooLong while resolving package"); a tool that imports zod easily
 *    exceeds that once deps are bundled in.
 * 2. `blob:` URL — same realm, no length limit (verified with a 512KB bundle).
 * 3. Legacy `file://` import — only a safety net when bundling fails entirely.
 *    Note it is module-cached by pathname: if a PRIOR load of the same file
 *    fell back to `file://`, a later reload can serve that stale module. A
 *    synchronous transpile pre-check below keeps syntax errors off this path,
 *    so in practice it only sees resolution-shaped failures — treat it as a
 *    last resort, never a promise of freshness.
 */
export async function loadToolModule(filePath: string): Promise<Record<string, unknown>> {
  // Electron's main process runs on Node. Tool hot-reload is a Bun-only
  // development feature; it must never turn an otherwise valid user prompt
  // into a session.error when the server asks for a reload.
  if (typeof Bun === "undefined") return {}

  // Transpile-first: syntax errors surface synchronously with clean, typed
  // messages BEFORE any import — and before the `file://` fallback below,
  // whose pathname-keyed cache could otherwise serve a stale module on reload.
  // The transpiler's per-call `{ loader }` option is ignored on Bun 1.3.14, so
  // the loader lives on the constructor; "ts" accepts both .ts and plain .js.
  new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(filePath).text())
  try {
    const code = await bundle(filePath)
    try {
      return await import(dataUrl(code))
    } catch {
      const blob = new Blob([code], { type: "text/javascript" })
      return await import(URL.createObjectURL(blob))
    }
  } catch {
    return await import(pathToFileURL(filePath).href)
  }
}

async function bundle(filePath: string): Promise<string> {
  const build = await Bun.build({
    entrypoints: [filePath],
    target: "bun",
    format: "esm",
  })
  if (!build.success) {
    throw new Error(`failed to bundle tool module ${filePath}: ${build.logs.map((log) => log.message).join("; ")}`)
  }
  return build.outputs[0].text()
}

function dataUrl(code: string) {
  return DATA_URL_PREFIX + Buffer.from(code, "utf8").toString("base64")
}

export * as ToolImport from "./import"
