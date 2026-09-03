import * as fs from "node:fs"
import * as path from "node:path"
import { Global } from "@opencode-ai/core/global"

const VERSION = 1
const FILE_NAME = "quota-cache.json"
const MAX_AGE_MS = 60 * 60 * 1000 // 1 hour - stale beyond this is discarded
const WRITE_DEBOUNCE_MS = 500

type PersistedEntry = {
  fetchedAt: number
  result: unknown
  cooldownUntil: number
}

type PersistedFile = {
  version: number
  entries: Record<string, PersistedEntry>
}

function filePath(): string {
  return path.join(Global.Path.cache, FILE_NAME)
}

function isTestEnv(): boolean {
  return process.env.NODE_ENV === "test" || !!process.env.BUN_TEST || !!process.env.OPENCODE_TEST_HOME || !!process.env.VITEST
}

function readFile(): PersistedFile | undefined {
  if (isTestEnv()) return undefined
  try {
    const raw = fs.readFileSync(filePath(), "utf8")
    const parsed = JSON.parse(raw) as PersistedFile
    if (parsed.version !== VERSION || typeof parsed.entries !== "object" || !parsed.entries) return undefined
    return parsed
  } catch {
    return undefined
  }
}

function writeFileAtomic(entries: Record<string, PersistedEntry>) {
  if (isTestEnv()) return
  try {
    const file = filePath()
    const dir = path.dirname(file)
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {}
    const payload = JSON.stringify({ version: VERSION, entries }, null, 2)
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, payload, { mode: 0o600 })
    try {
      fs.renameSync(tmp, file)
    } catch {
      // Windows: target may exist
      try {
        fs.writeFileSync(file, payload, { mode: 0o600 })
        try { fs.unlinkSync(tmp) } catch {}
      } catch {}
    }
  } catch {}
}

let memoryEntries: Record<string, PersistedEntry> | undefined
let writeTimer: ReturnType<typeof setTimeout> | undefined
let pendingEntries: Record<string, PersistedEntry> | undefined

function loadMemory(): Record<string, PersistedEntry> {
  if (memoryEntries) return memoryEntries
  const file = readFile()
  if (file) {
    const now = Date.now()
    const filtered: Record<string, PersistedEntry> = {}
    for (const [key, entry] of Object.entries(file.entries)) {
      if (!entry || typeof entry.fetchedAt !== "number") continue
      if (now - entry.fetchedAt > MAX_AGE_MS) continue
      filtered[key] = entry
    }
    memoryEntries = filtered
    return filtered
  }
  memoryEntries = {}
  return memoryEntries
}

function scheduleWrite() {
  if (writeTimer !== undefined) return
  writeTimer = setTimeout(() => {
    writeTimer = undefined
    if (pendingEntries) {
      const toWrite = pendingEntries
      pendingEntries = undefined
      writeFileAtomic(toWrite)
    }
  }, WRITE_DEBOUNCE_MS)
  if (typeof (writeTimer as any).unref === "function") (writeTimer as any).unref()
}

export function loadPersistentQuotaEntry<T>(persistentKey: string): { fetchedAt: number; result: T; cooldownUntil: number } | undefined {
  if (isTestEnv()) return undefined
  const entries = loadMemory()
  const entry = entries[persistentKey]
  if (!entry) return undefined
  if (Date.now() - entry.fetchedAt > MAX_AGE_MS) {
    delete entries[persistentKey]
    return undefined
  }
  return entry as { fetchedAt: number; result: T; cooldownUntil: number }
}

export function savePersistentQuotaEntry<T>(persistentKey: string, fetchedAt: number, result: T, cooldownUntil: number) {
  if (isTestEnv()) return
  const entries = loadMemory()
  entries[persistentKey] = { fetchedAt, result, cooldownUntil }
  // debounce write
  pendingEntries = { ...entries }
  scheduleWrite()
}

export function clearPersistentQuotaCache() {
  memoryEntries = {}
  pendingEntries = undefined
  if (writeTimer !== undefined) {
    clearTimeout(writeTimer)
    writeTimer = undefined
  }
  try {
    fs.unlinkSync(filePath())
  } catch {}
}
