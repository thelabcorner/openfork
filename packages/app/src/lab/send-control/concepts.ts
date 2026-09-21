/** Send / Stop concept lab — registry. DEV-ONLY. */

import type { LabConcept, LabConceptId } from "./concept"
import { conceptA } from "./concept-a-dual-lane"
import { conceptB } from "./concept-b-turn-baton"
import { conceptC } from "./concept-c-turn-instrument"
import { conceptD } from "./concept-d-keycap"
import { conceptE } from "./concept-e-ambient-edge"
import { conceptF } from "./concept-f-turn-lane"
import { conceptG, conceptH, conceptI, conceptJ, conceptK } from "./turn-lane-hybrids"

/**
 * G–K lead: they share one A+B+C skeleton and differ only in where the Prompt
 * Revisor send-policy menu is triggered from. F is the first hybrid attempt,
 * kept for comparison — its 24px cheek made the control 52px, which is why the
 * five below are all 38px or less. A–E are the original exploration.
 */
export const LAB_CONCEPTS: LabConcept[] = [
  conceptG,
  conceptH,
  conceptI,
  conceptJ,
  conceptK,
  conceptF,
  conceptA,
  conceptB,
  conceptC,
  conceptD,
  conceptE,
]

export const LAB_CONCEPT_LETTER: Record<LabConceptId, string> = {
  g: "G",
  h: "H",
  i: "I",
  j: "J",
  k: "K",
  f: "F",
  a: "A",
  b: "B",
  c: "C",
  d: "D",
  e: "E",
}

export function labConcept(id: LabConceptId) {
  return LAB_CONCEPTS.find((concept) => concept.id === id) ?? conceptG
}
