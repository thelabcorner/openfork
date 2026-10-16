import { CodeMode } from "@opencode-ai/codemode"

const MAX_ENTRIES = 128
const MAX_SOURCE_BYTES = 4 * 1024 * 1024

type Entry = {
  readonly prepared: CodeMode.PreparedProgram
  readonly sourceBytes: number
}

const cache = new Map<string, Entry>()
let sourceBytes = 0
let hits = 0
let misses = 0
let prepares = 0

export function get(code: string, sourceHash: string): CodeMode.PreparedProgram {
  const key = `abi:${CodeMode.PREPARED_PROGRAM_ABI}:${sourceHash}`
  const cached = cache.get(key)
  if (cached) {
    hits++
    cache.delete(key)
    cache.set(key, cached)
    return cached.prepared
  }

  misses++
  prepares++
  const prepared = CodeMode.prepare(code)
  const bytes = Buffer.byteLength(code, "utf8")
  if (bytes > MAX_SOURCE_BYTES) return prepared

  cache.set(key, { prepared, sourceBytes: bytes })
  sourceBytes += bytes
  while (cache.size > MAX_ENTRIES || sourceBytes > MAX_SOURCE_BYTES) {
    const oldest = cache.entries().next().value as [string, Entry] | undefined
    if (!oldest) break
    cache.delete(oldest[0])
    sourceBytes -= oldest[1].sourceBytes
  }
  return prepared
}

export const stats = () => ({
  entries: cache.size,
  sourceBytes,
  hits,
  misses,
  prepares,
})

export const resetForTest = () => {
  cache.clear()
  sourceBytes = 0
  hits = 0
  misses = 0
  prepares = 0
}

export * as PreparedProgramCache from "./prepared"
