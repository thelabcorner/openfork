// Pure, DOM-free formatting/lookup helpers for the @mention popover row
// visuals. Kept side-effect free so the bench can import and measure these
// alongside buildAtRows/splitHighlightSegments without pulling in solid-js.

import type { AtSymbolKind } from "./slash-popover"

// Coarse visual grouping for symbol kinds: three distinct treatments per the
// design spec rather than one generic dot for all seven+ kinds.
export type SymbolIconGroup = "callable" | "structural" | "value"

const SYMBOL_ICON_GROUPS: Record<string, SymbolIconGroup> = {
  fn: "callable",
  function: "callable",
  method: "callable",
  class: "structural",
  interface: "structural",
  type: "structural",
  enum: "value",
  const: "value",
  variable: "value",
}

export function symbolIconGroup(kind: AtSymbolKind): SymbolIconGroup {
  return SYMBOL_ICON_GROUPS[kind] ?? "callable"
}

// Human-readable file size, e.g. 812 B / 4.2 KB / 1.3 MB.
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ""
  if (bytes < 1000) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1000
  let unitIndex = 0
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000
    unitIndex++
  }
  const decimals = value < 10 ? 1 : 0
  return `${value.toFixed(decimals)} ${units[unitIndex]}`
}

// Relative time from an epoch-ms timestamp, e.g. "2h ago", "3d ago", "just now".
// Non-positive timestamps are never legitimate (epoch 0 = 1970) and indicate
// absent metadata that was coerced somewhere upstream — render as unknown.
export function formatRelativeTime(mtimeMs: number, now: number = Date.now()): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return ""
  const deltaMs = now - mtimeMs
  if (!Number.isFinite(deltaMs)) return ""
  if (deltaMs < 0) return "just now"
  const seconds = Math.floor(deltaMs / 1000)
  if (seconds < 45) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(months / 12)
  return `${years}y ago`
}

export function formatAbsoluteTime(mtimeMs: number, locale: string = "en"): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return ""
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(mtimeMs))
  } catch {
    return new Date(mtimeMs).toLocaleString()
  }
}

export function formatFolderCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return ""
  if (count < 1000) return `${count}`
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

// Size and mtime are independently valid. Previously size required mtime>0,
// which hid size/lineCount when mtime was missing/zero. Each field now
// validates on its own so consumers can render whatever is available.
export function hasKnownFileMeta(size: number | undefined, _mtime: number | undefined): size is number {
  return typeof size === "number" && Number.isFinite(size) && size >= 0
}

export function hasKnownMtime(mtime: number | undefined): boolean {
  return typeof mtime === "number" && Number.isFinite(mtime) && mtime > 0
}

export function hasKnownLineCount(lines: number | undefined): boolean {
  return typeof lines === "number" && Number.isFinite(lines) && lines >= 0
}

export function formatLineCount(lines: number): string {
  if (!Number.isFinite(lines) || lines < 0) return ""
  if (lines === 1) return "1 line"
  if (lines < 1000) return `${lines} lines`
  if (lines < 10000) return `${(lines / 1000).toFixed(1)}k lines`
  return `${Math.round(lines / 1000)}k lines`
}

// Middle-ellipsis truncation for long absolute paths; CSS text-overflow is
// end-only, so long external paths need this to keep the filename visible.
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars))
  const ellipsis = "…"
  const keep = maxChars - ellipsis.length
  const headLen = Math.ceil(keep / 2)
  const tailLen = Math.floor(keep / 2)
  return `${text.slice(0, headLen)}${ellipsis}${text.slice(text.length - tailLen)}`
}

// Static, precomputed per-row-kind heights. No measureElement: identity rows
// (agent/resource/reference/recent-file/slash) stay single-line; file/symbol/
// external results use a premium 3-line layout (kicker + title + meta) — still
// fixed, never measured, so virtualizer math stays cheap.
export const ROW_HEIGHT_SINGLE = 28
export const ROW_HEIGHT_RICH = 56

export function rowKindHeight(kind: "single" | "rich"): number {
  return kind === "rich" ? ROW_HEIGHT_RICH : ROW_HEIGHT_SINGLE
}
