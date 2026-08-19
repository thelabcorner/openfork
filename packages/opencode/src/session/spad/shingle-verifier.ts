export class ShingleVerifier {
  private readonly keys: Uint32Array
  private readonly stamps: Uint32Array
  private readonly mask: number
  private epoch = 1

  constructor(size = 8192) {
    if ((size & (size - 1)) !== 0) throw new Error("ShingleVerifier size must be power of two")
    this.keys = new Uint32Array(size)
    this.stamps = new Uint32Array(size)
    this.mask = size - 1
  }

  duplicate4GramRatio(get: (absoluteIndex: number) => number, start: number, end: number): number {
    if (end - start < 8) return 0
    this.epoch++
    if (this.epoch === 0xffffffff) { this.stamps.fill(0); this.epoch = 1 }
    let h = 0 >>> 0
    const base = 0x9e3779b1 >>> 0
    for (let i = 0; i < 4; i++) h = (Math.imul(h, base) + get(start + i) + 1) >>> 0
    let total = 0
    let unique = 0
    for (let i = start; i <= end - 4; i++) {
      if (i !== start) { h = 0; for (let j = 0; j < 4; j++) h = (Math.imul(h, base) + get(i + j) + 1) >>> 0 }
      total++
      let slot = ((h ^ (h >>> 16)) >>> 0) & this.mask
      while (this.stamps[slot] === this.epoch && this.keys[slot] !== h) slot = (slot + 1) & this.mask
      if (this.stamps[slot] !== this.epoch) { this.stamps[slot] = this.epoch; this.keys[slot] = h; unique++ }
    }
    return total === 0 ? 0 : 1 - unique / total
  }
}
