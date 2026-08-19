const HASH_BASE = 0x9e3779b1 >>> 0

function pow32(base: number, exp: number): number { let out = 1 >>> 0; for (let i = 0; i < exp; i++) out = Math.imul(out, base) >>> 0; return out }
function nextPow2(n: number): number { let x = 1; while (x < n) x <<= 1; return x }

export class MotifWatchdog {
  private readonly motif: Uint16Array
  private readonly qgram: number
  private readonly qPow: number
  private readonly tableHash: Uint32Array
  private readonly tableOffset: Int32Array
  private readonly tableMask: number
  private readonly recent: Uint16Array
  private readonly recentMask: number
  private rollingHash = 0 >>> 0
  private count = 0
  private matched = 0
  private nextMotifOffset = -1

  constructor(motif: Uint16Array, qgram = 8) {
    if (motif.length === 0) throw new Error("MotifWatchdog requires non-empty motif")
    this.motif = motif.slice(); this.qgram = qgram; this.qPow = pow32(HASH_BASE, qgram - 1)
    const tableSize = Math.max(32, nextPow2(motif.length * 4))
    this.tableHash = new Uint32Array(tableSize); this.tableOffset = new Int32Array(tableSize); this.tableMask = tableSize - 1
    const recentSize = nextPow2(Math.max(16, qgram * 2)); this.recent = new Uint16Array(recentSize); this.recentMask = recentSize - 1
    for (let offset = 0; offset < motif.length; offset++) {
      let h = 0 >>> 0
      for (let j = 0; j < qgram; j++) h = (Math.imul(h, HASH_BASE) + motif[(offset + j) % motif.length]! + 1) >>> 0
      let slot = ((h ^ (h >>> 16)) >>> 0) & this.tableMask
      while (this.tableOffset[slot] !== 0) slot = (slot + 1) & this.tableMask
      this.tableHash[slot] = h; this.tableOffset[slot] = offset + 1
    }
  }

  resetStream(): void { this.rollingHash = 0; this.count = 0; this.matched = 0; this.nextMotifOffset = -1 }

  private currentQgramMatches(offset: number): boolean {
    const start = this.count - this.qgram
    for (let j = 0; j < this.qgram; j++) if (this.recent[(start + j) & this.recentMask]! !== this.motif[(offset + j) % this.motif.length]!) return false
    return true
  }

  private seedAlignment(): boolean {
    const h = this.rollingHash
    let slot = ((h ^ (h >>> 16)) >>> 0) & this.tableMask
    while (this.tableOffset[slot] !== 0) {
      if (this.tableHash[slot] === h) {
        const offset = this.tableOffset[slot]! - 1
        if (this.currentQgramMatches(offset)) { this.nextMotifOffset = offset + this.qgram; this.matched = this.qgram; return true }
      }
      slot = (slot + 1) & this.tableMask
    }
    return false
  }

  pushCode(code: number, requiredMatchChars: number): boolean {
    this.recent[this.count & this.recentMask] = code; this.count++
    if (this.count <= this.qgram) {
      this.rollingHash = (Math.imul(this.rollingHash, HASH_BASE) + code + 1) >>> 0
      if (this.count < this.qgram) return false
    } else {
      const outgoing = this.recent[(this.count - this.qgram - 1) & this.recentMask]!
      const removed = Math.imul(outgoing + 1, this.qPow) >>> 0
      this.rollingHash = (Math.imul((this.rollingHash - removed) >>> 0, HASH_BASE) + code + 1) >>> 0
    }
    if (this.nextMotifOffset >= 0 && this.count > this.qgram) {
      const expected = this.motif[this.nextMotifOffset % this.motif.length]!
      if (code === expected) { this.nextMotifOffset++; this.matched++; return this.matched >= requiredMatchChars }
      this.nextMotifOffset = -1; this.matched = 0
    }
    if (this.nextMotifOffset < 0 && this.seedAlignment()) return this.matched >= requiredMatchChars
    return false
  }

  push(delta: string, requiredMatchChars: number, maxChars = delta.length): boolean {
    const length = Math.min(delta.length, maxChars)
    for (let i = 0; i < length; i++) if (this.pushCode(delta.charCodeAt(i), requiredMatchChars)) return true
    return false
  }
}
