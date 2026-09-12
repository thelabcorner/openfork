import type { Prompt } from "@/context/prompt"

export const QUESTION_DETAIL_MAX_CHARS = 16_384

/**
 * Flattens composer parts into the plain-text `details` string the question API
 * accepts.
 *
 * Mention parts (`@src/foo.ts`, `@build`, `@plan`) already carry their literal
 * editor text in `content`, so a straight concatenation round-trips every
 * mention the user inserted through the normal prompt input. Image attachments
 * have no textual form and are dropped — the question reply channel is text
 * only.
 */
export function questionDetailsText(parts: Prompt): string {
  return parts
    .map((part) => ("content" in part ? part.content : ""))
    .join("")
    .trim()
    .slice(0, QUESTION_DETAIL_MAX_CHARS)
}

/** True when the composer holds nothing that could serve as an answer detail. */
export function questionDetailsEmpty(parts: Prompt): boolean {
  return questionDetailsText(parts).length === 0
}
