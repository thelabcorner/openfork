export type HighlightSegment = {
  text: string
  match: boolean
}

/**
 * Splits `text` into segments, flagging spans that match any of the query
 * terms (case-insensitive, longest term first so overlapping terms do not
 * double-match). Renders as <mark> in the search panel.
 */
export function splitHighlight(text: string, terms: string[]): HighlightSegment[] {
  const sorted = terms
    .map((term) => term.toLowerCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  if (sorted.length === 0 || !text) return [{ text, match: false }]
  const lowered = text.toLowerCase()
  const matched = new Array(text.length).fill(false)
  for (const term of sorted) {
    let index = lowered.indexOf(term)
    while (index !== -1) {
      for (let i = index; i < index + term.length; i++) matched[i] = true
      index = lowered.indexOf(term, index + term.length)
    }
  }
  const segments: HighlightSegment[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (i === 0 || matched[i] === matched[i - 1]) continue
    segments.push({ text: text.slice(start, i), match: matched[start] })
    start = i
  }
  segments.push({ text: text.slice(start), match: matched[start] })
  return segments
}
