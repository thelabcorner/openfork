export type GoalRevisorSource = {
  objective: string
  criteria: string
  promptText?: string
}

/**
 * Compose the draft text sent to the existing prompt-revisor service.
 * The revisor stays stateless: it only sees this composed brief plus the
 * fixed goal-oriented guidance, so no new backend endpoint is needed.
 */
export function buildGoalRevisorDraft(source: GoalRevisorSource) {
  const objective = source.objective.trim()
  const criteria = source.criteria.trim()
  const promptText = (source.promptText ?? "").trim()
  const sections: string[] = []
  sections.push("Write a comprehensive, self-contained goal objective document for an autonomous coding agent.")
  if (objective) sections.push(`\nUser's goal objective draft:\n${objective}`)
  else sections.push("\nUser's goal objective draft:\n(empty — infer a sensible objective from the remaining context)")
  if (criteria) sections.push(`\nUser's done-when draft (one verifiable outcome per line):\n${criteria}`)
  if (promptText) sections.push(`\nCurrent composer prompt text (extra context from the user):\n${promptText}`)
  sections.push(
    "\nRules: preserve the user's intent, resolve contradictions in favor of the done-when list, " +
      "make every outcome verifiable, keep it actionable, and return markdown only.",
  )
  return sections.join("\n")
}

/** Fixed guidance telling the prompt revisor to act as a goal-objective author. */
export function buildGoalRevisorGuidance() {
  return [
    "You are revising a GOAL brief, not a chat prompt.",
    "Return a single comprehensive goal-objective.md document: start with `# Goal` plus a one-paragraph objective,",
    "then `## Done when` with a checkbox per verifiable outcome, then `## Context` only when the composer text adds facts.",
    "Keep the user's wording where it is already precise. Do not add new scope. Markdown only, no preamble.",
  ].join(" ")
}

/** Normalize a revisor revision back into the editable objective field. */
export function applyRevisedGoalObjective(revised: string) {
  return revised.trim()
}

/** Message posted into the session when a goal starts or its brief changes. */
export function buildGoalStartMessage(input: { objective: string; criteria: string[]; promptText?: string }) {
  const objective = input.objective.trim()
  const promptText = (input.promptText ?? "").trim()
  const lines = ["[GOAL START]", "", objective]
  if (input.criteria.length) {
    lines.push("", "Done when:")
    for (const item of input.criteria) lines.push(`- ${item}`)
  }
  if (promptText) {
    lines.push("", "Composer note from the user:", promptText)
  }
  return lines.join("\n")
}

/** Message posted when an already-active goal brief is edited. */
export function buildGoalUpdatedMessage(input: { title: string; objective: string }) {
  return [`[GOAL UPDATED] ${input.title}`.trim(), "", input.objective.trim()].join("\n")
}
