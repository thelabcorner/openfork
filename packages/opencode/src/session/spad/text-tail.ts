/**
 * Bounded append-only text tail with O(1)-amortized streaming writes.
 *
 * SPAD only needs a contiguous string when an audit case is actually created.
 * Keeping the hot path as chunks avoids repeatedly copying the full 8 KiB tail
 * for small provider deltas after the bound has been reached.
 */
export class BoundedTextTail {
  private chunks: string[] = []
  private head = 0
  private chars = 0

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("text tail capacity must be a positive integer")
  }

  get length(): number {
    return this.chars
  }

  reset(): void {
    this.chunks.length = 0
    this.head = 0
    this.chars = 0
  }

  push(text: string): void {
    if (text.length === 0) return
    if (text.length >= this.capacity) {
      this.chunks = [text.slice(-this.capacity)]
      this.head = 0
      this.chars = this.capacity
      return
    }

    this.chunks.push(text)
    this.chars += text.length
    let excess = this.chars - this.capacity
    while (excess > 0) {
      const first = this.chunks[this.head]!
      if (first.length <= excess) {
        this.head++
        this.chars -= first.length
        excess -= first.length
      } else {
        this.chunks[this.head] = first.slice(excess)
        this.chars -= excess
        excess = 0
      }
    }

    // Avoid an ever-growing sparse backing array while keeping compaction rare
    // enough that tiny streaming chunks remain O(1)-amortized.
    if (this.head >= 64 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
  }

  toString(): string {
    if (this.chars === 0) return ""
    if (this.head === this.chunks.length - 1) return this.chunks[this.head]!
    return this.chunks.slice(this.head).join("")
  }
}
