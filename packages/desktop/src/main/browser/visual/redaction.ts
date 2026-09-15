import { createHash } from "node:crypto"
import type { VisualRedaction } from "../contracts"

const MAX_BLOCK_SELECTORS = 64
const MAX_ATTRIBUTE_RULES = 64
const MAX_ATTRIBUTE_NAMES = 32
const MAX_SELECTOR_LENGTH = 1_024
const MAX_ATTRIBUTE_NAME_LENGTH = 128
const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/

export interface NormalizedVisualRedaction {
  blocks: string[]
  attributes: Array<{ selector: string; names: string[] }>
}

export class VisualRedactionPolicyError extends Error {
  readonly code = "VISUAL_REDACTION_POLICY_INVALID"
  constructor(message: string) {
    super(message)
    this.name = "VisualRedactionPolicyError"
  }
}

export const EMPTY_VISUAL_REDACTION: NormalizedVisualRedaction = Object.freeze({
  blocks: Object.freeze([]) as unknown as string[],
  attributes: Object.freeze([]) as unknown as Array<{ selector: string; names: string[] }>,
})

export const normalizeVisualRedaction = (input?: VisualRedaction): NormalizedVisualRedaction => {
  const blocks = dedupeSorted((input?.blocks ?? []).map((selector) => validateSelector(selector)))
  if (blocks.length > MAX_BLOCK_SELECTORS) throw invalidPolicy(`redact.blocks may contain at most ${MAX_BLOCK_SELECTORS} selectors`)

  const bySelector = new Map<string, Set<string>>()
  for (const rule of input?.attributes ?? []) {
    const selector = validateSelector(rule.selector)
    let names = bySelector.get(selector)
    if (!names) bySelector.set(selector, names = new Set())
    for (const name of rule.names) {
      if (typeof name !== "string" || !name || name.length > MAX_ATTRIBUTE_NAME_LENGTH || !ATTRIBUTE_NAME.test(name)) {
        throw invalidPolicy(`Invalid redacted attribute name ${JSON.stringify(name)}`)
      }
      names.add(name.toLowerCase())
      if (names.size > MAX_ATTRIBUTE_NAMES) throw invalidPolicy(`A redaction rule may contain at most ${MAX_ATTRIBUTE_NAMES} attribute names`)
    }
  }
  if (bySelector.size > MAX_ATTRIBUTE_RULES) throw invalidPolicy(`redact.attributes may contain at most ${MAX_ATTRIBUTE_RULES} selector rules`)

  const attributes = [...bySelector.entries()]
    .map(([selector, names]) => ({ selector, names: [...names].sort() }))
    .filter((rule) => rule.names.length > 0)
    .sort((a, b) => a.selector.localeCompare(b.selector))

  return { blocks, attributes }
}

export const visualRedactionDigest = (input?: VisualRedaction): string =>
  digestNormalizedVisualRedaction(normalizeVisualRedaction(input))

export const digestNormalizedVisualRedaction = (policy: NormalizedVisualRedaction): string =>
  createHash("sha256").update(JSON.stringify(policy)).digest("hex")

export const EMPTY_VISUAL_REDACTION_SHA256 = digestNormalizedVisualRedaction(EMPTY_VISUAL_REDACTION)

const validateSelector = (value: unknown): string => {
  if (typeof value !== "string") throw invalidPolicy("Redaction selector must be a string")
  const selector = value.trim()
  if (!selector || selector.length > MAX_SELECTOR_LENGTH) {
    throw invalidPolicy(`Redaction selector length must be 1..${MAX_SELECTOR_LENGTH}`)
  }
  return selector
}

const dedupeSorted = (values: string[]): string[] => [...new Set(values)].sort()

const invalidPolicy = (message: string): VisualRedactionPolicyError => new VisualRedactionPolicyError(message)
