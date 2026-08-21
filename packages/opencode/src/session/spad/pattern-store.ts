import fs from "fs"
import os from "os"
import path from "path"

const MAGIC = 0x44415053 // 'SPAD' LE
const VERSION = 1
const MAX_MOTIFS = 32
const MAX_MOTIF_LEN = 4096

const STORE_PATH = path.join(os.homedir(), ".local", "share", "opencode", "spad-patterns.bin")

function hashMotif(motif: Uint16Array): number {
  let h = 0 >>> 0
  for (let i = 0; i < motif.length; i++) h = (Math.imul(h, 0x9e3779b1) ^ motif[i]!) >>> 0
  return h >>> 0
}

export interface StoredMotif {
  readonly motif: Uint16Array
  readonly hash: number
  readonly seen: number
}

let cache: StoredMotif[] | undefined
let loaded = false

function ensureDir(p: string): void {
  try {
    const dir = path.dirname(p)
    fs.mkdirSync(dir, { recursive: true })
  } catch {}
}

function loadSync(): StoredMotif[] {
  if (loaded) return cache ?? []
  loaded = true
  try {
    if (!fs.existsSync(STORE_PATH)) {
      cache = []
      return cache
    }
    const buf = fs.readFileSync(STORE_PATH)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    let off = 0
    if (view.getUint32(off, true) !== MAGIC) {
      cache = []
      return cache
    }
    off += 4
    const ver = view.getUint8(off)
    off += 1
    if (ver !== VERSION) {
      cache = []
      return cache
    }
    const count = view.getUint32(off, true)
    off += 4
    const out: StoredMotif[] = []
    for (let i = 0; i < count && i < MAX_MOTIFS; i++) {
      if (off + 8 > buf.length) break
      const len = view.getUint16(off, true)
      off += 2
      const storedHash = view.getUint32(off, true)
      off += 4
      const seen = view.getUint16(off, true)
      off += 2
      if (len <= 0 || len > MAX_MOTIF_LEN || off + len * 2 > buf.length) break
      const motif = new Uint16Array(len)
      for (let j = 0; j < len; j++) {
        motif[j] = view.getUint16(off, true)
        off += 2
      }
      const h = hashMotif(motif)
      if (h !== storedHash) continue
      out.push({ motif, hash: h, seen })
    }
    cache = out
    return out
  } catch {
    cache = []
    return cache
  }
}

function saveSync(motifs: StoredMotif[]): void {
  try {
    ensureDir(STORE_PATH)
    const totalBytes = 4 + 1 + 4 + motifs.reduce((a, m) => a + 2 + 4 + 2 + m.motif.length * 2, 0)
    const buf = Buffer.allocUnsafe(totalBytes)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    let off = 0
    view.setUint32(off, MAGIC, true)
    off += 4
    view.setUint8(off, VERSION)
    off += 1
    view.setUint32(off, motifs.length, true)
    off += 4
    for (const m of motifs) {
      view.setUint16(off, m.motif.length, true)
      off += 2
      view.setUint32(off, m.hash, true)
      off += 4
      view.setUint16(off, Math.min(0xffff, m.seen), true)
      off += 2
      for (let j = 0; j < m.motif.length; j++) {
        view.setUint16(off, m.motif[j]!, true)
        off += 2
      }
    }
    fs.writeFileSync(STORE_PATH, buf)
  } catch {}
}

export function getPersistedMotifs(): StoredMotif[] {
  return loadSync()
}

export function addPersistedMotif(motif: Uint16Array): void {
  if (motif.length === 0 || motif.length > MAX_MOTIF_LEN) return
  const h = hashMotif(motif)
  const list = loadSync()
  const idx = list.findIndex((m) => m.hash === h && m.motif.length === motif.length && m.motif.every((v, i) => v === motif[i]))
  if (idx >= 0) {
    const existing = list[idx]!
    list[idx] = { motif: existing.motif, hash: existing.hash, seen: Math.min(0xffff, existing.seen + 1) }
    // move to front for LRU
    const [item] = list.splice(idx, 1)
    list.unshift(item!)
  } else {
    list.unshift({ motif: motif.slice(), hash: h, seen: 1 })
    if (list.length > MAX_MOTIFS) list.pop()
  }
  cache = list
  // fire-and-forget, do not block hot path
  try {
    saveSync(list)
  } catch {}
}

export function clearPersistedMotifs(): void {
  cache = []
  loaded = true
  try {
    if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH)
  } catch {}
}

export const PatternStorePath = STORE_PATH
