// src/tool/websearch-shared.ts
//
// Small shared helpers for the REST websearch provider clients (firecrawl,
// duckduckgo, brave, tavily, searxng): a common result shape, a markdown-ish
// renderer consistent across providers, and a common User-Agent header helper.

import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { collectBoundedResponseBody } from "@opencode-ai/core/tool/http-body"
import { Effect } from "effect"
import { HttpClientResponse } from "effect/unstable/http"

export const MAX_SEARCH_RESPONSE_BYTES = 5 * 1024 * 1024

export type SearchResult = {
  url?: string
  title?: string
  description?: string
  date?: string
}

/** Render results in a markdown-ish numbered shape; undefined when nothing usable. */
export function renderSearchResults(results: readonly SearchResult[]): string | undefined {
  const seen = new Set<string>()
  const rendered: string[] = []
  const singleLine = (text: string, limit: number) => text.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, " ").trim().slice(0, limit)
  for (const result of results) {
    if (rendered.length === 20) break
    if (!result?.url) continue
    const raw = result.url.trim()
    if (raw.length > 2048 || raw.length === 0 || /[\u0000-\u0020\u007f]/.test(raw)) continue
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) continue
    if (seen.has(url.href)) continue
    seen.add(url.href)
    const title = singleLine(result.title || raw, 240) || raw
    const lines = [`${rendered.length + 1}. ${title}`]
    const snippet = result.description && singleLine(result.description, 480)
    if (snippet) lines.push(`   ${snippet}`)
    lines.push(`   ${raw}`)
    const date = result.date && singleLine(result.date, 48)
    if (date) lines.push(`   ${date}`)
    rendered.push(lines.join("\n"))
  }
  return rendered.length ? rendered.join("\n\n") : undefined
}

export function websearchHeaders(): Record<string, string> {
  return { "User-Agent": `opencode/${InstallationVersion}` }
}

export function readSearchResponseText(response: HttpClientResponse.HttpClientResponse) {
  return collectBoundedResponseBody(
    response,
    MAX_SEARCH_RESPONSE_BYTES,
    () => new Error("Search provider response too large (exceeds 5MB limit)"),
  ).pipe(
    // Search transports are textual JSON/SSE/HTML; decode once after bounded
    // collection so a missing/lying Content-Length can never force an
    // unbounded response.text()/arrayBuffer() allocation.
    Effect.map((body) => body.toString("utf8")),
  )
}
