import { checksum } from "@opencode-ai/core/util/encode"
import DOMPurify from "dompurify"
import { parseMarkdown } from "./markdown-worker"

export type MarkdownCacheEntry = {
  raw: string
  hash: string
  html: string
}

const max = 200
const maxBytes = 8 * 1024 * 1024
const cache = new Map<string, MarkdownCacheEntry>()
const sizes = new Map<string, number>()
let totalBytes = 0
const config = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
  ADD_TAGS: ["svg", "path"],
  ADD_ATTR: ["d", "viewBox", "preserveAspectRatio", "xmlns", "target"],
}

if (typeof window !== "undefined" && DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    if (!(node instanceof HTMLAnchorElement)) return
    if (node.target !== "_blank") return

    const rel = node.getAttribute("rel") ?? ""
    const set = new Set(rel.split(/\s+/).filter(Boolean))
    set.add("noopener")
    set.add("noreferrer")
    node.setAttribute("rel", Array.from(set).join(" "))
  })
}

export function sanitizeMarkdown(html: string) {
  if (!DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(html, config)
}

export function getCachedMarkdown(key: string) {
  const value = cache.get(key)
  if (!value) return
  // Reads are cache hits too. Move the entry to the MRU end so repeated
  // session renders do not evict the blocks that are actually visible.
  cache.delete(key)
  cache.set(key, value)
  return value
}

export function touchCachedMarkdown(key: string, value: MarkdownCacheEntry) {
  const size = (value.raw.length + value.html.length + value.hash.length) * 2
  const existing = sizes.get(key)
  if (existing !== undefined) totalBytes -= existing
  cache.delete(key)
  sizes.delete(key)
  if (size > maxBytes) return
  cache.set(key, value)
  sizes.set(key, size)
  totalBytes += size

  if (cache.size <= max && totalBytes <= maxBytes) return

  while (cache.size > max || totalBytes > maxBytes) {
    const first = cache.keys().next().value
    if (!first) break
    cache.delete(first)
    totalBytes -= sizes.get(first) ?? 0
    sizes.delete(first)
  }
}

export async function preloadMarkdown(text: string, cacheKey: string) {
  const key = `${cacheKey}:0:full`
  const cached = getCachedMarkdown(key)
  if (cached?.raw === text) {
    touchCachedMarkdown(key, cached)
    return
  }
  const hash = checksum(text)
  if (!hash) return
  touchCachedMarkdown(key, {
    raw: text,
    hash,
    html: sanitizeMarkdown(await parseMarkdown(text, key)),
  })
}
