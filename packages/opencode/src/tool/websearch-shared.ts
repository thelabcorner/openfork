// src/tool/websearch-shared.ts
//
// Small shared helpers for the REST websearch provider clients (firecrawl,
// duckduckgo, brave, tavily, searxng): a common result shape, a markdown-ish
// renderer consistent across providers, and a common User-Agent header helper.

import { InstallationVersion } from "@opencode-ai/core/installation/version"

export type SearchResult = {
  url?: string
  title?: string
  description?: string
  date?: string
}

/** Render results in a markdown-ish numbered shape; undefined when nothing usable. */
export function renderSearchResults(results: readonly SearchResult[]): string | undefined {
  const clean = results.filter((r): r is SearchResult & { url: string } => Boolean(r && r.url))
  if (clean.length === 0) return undefined
  return clean
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title || r.url}`]
      if (r.description) lines.push(`   ${r.description}`)
      lines.push(`   ${r.url}`)
      if (r.date) lines.push(`   ${r.date}`)
      return lines.join("\n")
    })
    .join("\n\n")
}

export function websearchHeaders(): Record<string, string> {
  return { "User-Agent": `opencode/${InstallationVersion}` }
}
