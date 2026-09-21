export type GoalRevisorSource = {
  objective: string
  criteria: string
  promptText?: string
}

/**
 * Compose the explicit brief sent through the shared revision engine by the
 * first-class Goal Revisor producer. Its Session-owned transcript is durable,
 * while conversation injection is deliberately disabled so this document is
 * the complete model-visible Goal revision context.
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
