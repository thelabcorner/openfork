/**
 * Bounded LRU cache for prepared pretext handles.
 *
 * Keys are CONTENT-IDENTITY (text + typography signature), deliberately WITHOUT
 * width: `prepare()` is the expensive one-time pass, `layout()` is cheap pure
 * arithmetic, so width changes must reuse the same prepared handle.
 *
 * Determinism guarantee (contract with consumers): the cache is a pure
 * accelerator. A cache miss calls `prepare()` again and yields the same handle
 * semantics; eviction never changes the result of `estimateTextHeight` for the
 * same (text, typography, width). It only changes which calls pay the prepare
 * cost.
 */

import type { TextTypography } from "./typography"
import { typographySignature } from "./typography"

export const PREPARED_CACHE_MAX_ENTRIES = 1024
export const PREPARED_CACHE_MAX_BYTES = 8 * 1024 * 1024

/** Opaque handle to a width-free prepared text. */
export type PreparedTextHandle = {
  readonly __prepared: unknown
}

type CacheEntry = {
  handle: PreparedTextHandle
  /** Approximate retained bytes: text chars * 2 + measured segment arrays. */
  bytes: number
}

const DEFAULT_BYTES_PER_ENTRY = 512

export class PreparedTextCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly maxEntries: number
  private readonly maxBytes: number
  private bytes = 0

  constructor(options?: { maxEntries?: number; maxBytes?: number }) {
    this.maxEntries = options?.maxEntries ?? PREPARED_CACHE_MAX_ENTRIES
    this.maxBytes = options?.maxBytes ?? PREPARED_CACHE_MAX_BYTES
  }

  get size() {
    return this.entries.size
  }

  get(key: string) {
    const entry = this.entries.get(key)
    if (!entry) return
    // Refresh recency: move to the most-recently-used end.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.handle
  }

  set(key: string, handle: PreparedTextHandle, textLength: number) {
    const previous = this.entries.get(key)
    if (previous) this.entries.delete(key)
    const bytes = estimateBytes(textLength)
    this.entries.set(key, { handle, bytes })
    this.bytes += bytes
    if (previous) this.bytes -= previous.bytes
    this.evict()
  }

  clear() {
    this.entries.clear()
    this.bytes = 0
  }

  private evict() {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) return
      const entry = this.entries.get(oldest)
      this.entries.delete(oldest)
      if (entry) this.bytes -= entry.bytes
    }
  }
}

function estimateBytes(textLength: number) {
  // UTF-16 code units are 2 bytes each; pretext also retains per-segment
  // widths/break arrays, so add a constant floor per entry.
  return Math.max(DEFAULT_BYTES_PER_ENTRY, textLength * 2 + 256)
}

/** Build the content-identity cache key for a text + typography pair. */
export function preparedCacheKey(text: string, typography: TextTypography) {
  return `${typographySignature(typography)}\n${text}`
}
