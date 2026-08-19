// src/tool/duckduckgo-websearch.ts
//
// DuckDuckGo HTML search — keyless, no API key. Renders the HTML results page
// via a small defensive regex parser (result anchors + snippets). Any parse
// failure degrades to "no results" rather than hard-failing.

import { Duration, Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { renderSearchResults, websearchHeaders, type SearchResult } from "./websearch-shared"

export const DUCKDUCKGO_URL = "https://html.duckduckgo.com/html/"

const RESULT_A = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
const RESULT_SNIPPET = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi

const clean = (text: string) =>
  text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim()

function extractTarget(href: string): string {
  const uddg = href.match(/[?&]uddg=([^&]+)/)
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1])
    } catch {
      return href
    }
  }
  return href.startsWith("//") ? `https:${href}` : href
}

/** Parse the DuckDuckGo HTML results page into SearchResult items. */
export function parseDuckDuckGoHtml(html: string): SearchResult[] | undefined {
  const titles: Array<{ href: string; title: string }> = []
  for (const m of html.matchAll(RESULT_A)) {
    titles.push({ href: m[1], title: clean(m[2]) })
  }
  const snippets: string[] = []
  for (const m of html.matchAll(RESULT_SNIPPET)) {
    snippets.push(clean(m[1]))
  }
  if (titles.length === 0) return undefined

  const results = titles.map((t, i) => ({
    url: extractTarget(t.href),
    title: t.title,
    description: snippets[i],
  }))
  return renderSearchResults(results) ? results : undefined
}

export const call = (http: HttpClient.HttpClient, query: string, timeout: Duration.Input = "25 seconds") =>
  Effect.gen(function* () {
    const request = HttpClientRequest.get(DUCKDUCKGO_URL).pipe(
      HttpClientRequest.accept("text/html,application/xhtml+xml"),
      HttpClientRequest.setHeaders(websearchHeaders()),
      HttpClientRequest.setUrlParams({ q: query }),
    )
    const response = yield* HttpClient.filterStatusOk(http)
      .execute(request)
      .pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.die(new Error("DuckDuckGo request timed out")),
        }),
      )
    const body = yield* response.text
    const results = parseDuckDuckGoHtml(body)
    return results ? renderSearchResults(results) : undefined
  })
