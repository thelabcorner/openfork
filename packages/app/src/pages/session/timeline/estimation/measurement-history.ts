/**
 * Width-bucketed historical heights (PRETEXT PREDICTS, THE DOM DECIDES).
 *
 * When a row's real height is measured, the observation is recorded under a
 * content-identity key (row type + text) and the width BUCKET it was measured
 * at. Later estimates for the same content first look up history — a real
 * measurement of the same text at a similar width is stronger evidence than
 * any prediction.
 *
 * Width is bucketed (not exact) so nearby widths reuse the same history, and
 * keys never retain the text itself (content is hashed) to bound memory.
 */

import type { TimelineRow } from "../timeline-row"

export type RowType = TimelineRow.TimelineRow["_tag"]

export const WIDTH_BUCKET_PX = 64

/** Simple content hash: FNV-1a over the text. Width-free, cheap, stable. */
export function contentHash(text: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function widthBucket(widthPx: number) {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return 0
  return Math.floor(widthPx / WIDTH_BUCKET_PX)
}

type HistoryKey = `${RowType}:${number}:${number}`

export class MeasurementHistory {
  private readonly samples = new Map<HistoryKey, { total: number; count: number }>()
  /** Bound retained keys so long sessions never leak history entries. */
  private readonly maxKeys = 4096

  /** Record a measured height for content at a width bucket. */
  observe(type: RowType, text: string | undefined, widthPx: number, height: number) {
    if (!Number.isFinite(height) || height <= 0) return
    if (!text) return
    const key: HistoryKey = `${type}:${contentHash(text)}:${widthBucket(widthPx)}`
    const previous = this.samples.get(key)
    if (previous) {
      previous.total += height
      previous.count += 1
      return
    }
    this.samples.set(key, { total: height, count: 1 })
    if (this.samples.size > this.maxKeys) {
      this.samples.delete(this.samples.keys().next().value!)
    }
  }

  /**
   * Historical average height for the same content at this width bucket
   * (within ±1 bucket), or undefined when no measurement exists.
   */
  get(type: RowType, text: string | undefined, widthPx: number) {
    if (!text) return
    const hash = contentHash(text)
    const bucket = widthBucket(widthPx)
    for (const candidate of [bucket, bucket - 1, bucket + 1]) {
      if (candidate < 0) continue
      const sample = this.samples.get(`${type}:${hash}:${candidate}` as HistoryKey)
      if (sample) return sample.total / sample.count
    }
  }

  get size() {
    return this.samples.size
  }

  clear() {
    this.samples.clear()
  }
}
