import type { TurnPolicy } from "./types"

const NEGATED_REPEAT = /\b(?:do\s+not|don't|dont|avoid|stop|prevent|without)\s+(?:\w+\s+){0,2}(?:repeat|repeating|repetition|duplicate|duplicating)\b/i
const EXPLICIT_COUNT = /\b(?:repeat|write|print|output|emit|duplicate)\b.{0,48}\b\d{1,7}\b.{0,24}\b(?:times?|copies?|rows?|lines?|instances?)\b/is
const EXPLICIT_VERBATIM = /\b(?:repeat|duplicate|copy|output|emit)\b.{0,48}\b(?:verbatim|exactly|identical|unchanged)\b/is
const EXPLICIT_FOREVER = /\b(?:repeat|print|output|emit)\b.{0,48}\b(?:forever|indefinitely|until\s+(?:stopped|cancelled|canceled))\b/is

export function repetitionExpected(userText: string): boolean {
  if (NEGATED_REPEAT.test(userText)) return false
  return EXPLICIT_COUNT.test(userText) || EXPLICIT_VERBATIM.test(userText) || EXPLICIT_FOREVER.test(userText)
}

export function makeTurnPolicy(userText: string, structuredOutput = false): TurnPolicy {
  return { repetitionExpected: repetitionExpected(userText), observeOnly: structuredOutput }
}
