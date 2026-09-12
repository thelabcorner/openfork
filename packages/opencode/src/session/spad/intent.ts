import type { TurnPolicy } from "./types"

const NEGATED_REPEAT = /\b(?:do\s+not|don't|dont|avoid|stop|prevent|without)\s+(?:\w+\s+){0,2}(?:repeat|repeating|repetition|duplicate|duplicating)\b/i
const EXPLICIT_COUNT = /\b(?:repeat|write|print|output|emit|duplicate)\b.{0,48}\b\d{1,7}\b.{0,24}\b(?:times?|copies?|rows?|lines?|instances?)\b/is
const EXPLICIT_VERBATIM = /\b(?:repeat|duplicate|copy|output|emit)\b.{0,48}\b(?:verbatim|exactly|identical|unchanged)\b/is
const EXPLICIT_FOREVER = /\b(?:repeat|print|output|emit)\b.{0,48}\b(?:forever|indefinitely|until\s+(?:stopped|cancelled|canceled))\b/is
const NO_MUTATION_VERB =
  /\b(?:do\s+not|don't|dont|must\s+not|without)\s+(?:\w+\s+){0,2}(?:edit|editing|modify|modifying|write|writing|patch|patching)\b/i
const NO_CHANGES = /\b(?:do\s+not|don't|dont|must\s+not)\s+make\s+(?:any\s+)?changes\b/i
const CHANGING_FILES = /\bwithout\s+changing\s+(?:the\s+)?(?:files?|code|repo(?:sitory)?)\b/i
const READ_ONLY = /\b(?:read[- ]only|inspection[- ]only|analysis[- ]only|review[- ]only)\b/i

export function repetitionExpected(userText: string): boolean {
  if (NEGATED_REPEAT.test(userText)) return false
  return EXPLICIT_COUNT.test(userText) || EXPLICIT_VERBATIM.test(userText) || EXPLICIT_FOREVER.test(userText)
}

export function mutationForbidden(userText: string): boolean {
  return NO_MUTATION_VERB.test(userText) || NO_CHANGES.test(userText) || CHANGING_FILES.test(userText) || READ_ONLY.test(userText)
}

export function makeTurnPolicy(userText: string, structuredOutput = false): TurnPolicy {
  return {
    repetitionExpected: repetitionExpected(userText),
    observeOnly: structuredOutput,
    mutationForbidden: mutationForbidden(userText),
  }
}
