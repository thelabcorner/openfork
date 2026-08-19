export function recoveryPrompt(attempt: number): string {
  if (attempt <= 1) return "[Internal recovery] The previous generation entered a repetitive output loop and was interrupted. Do not continue or recreate the repeated tail. Re-anchor to the last genuine user request and completed tool state, then continue from the first unfinished objective using a different continuation. If the task is already complete, end the turn."
  return "[Internal recovery: second attempt] Repetition recurred. Treat the interrupted assistant continuation as invalid and absent. Reconstruct the current task state from the last genuine user request and completed tool results. Choose a different next action and do not regenerate the previous continuation. If no useful next action exists, end the turn."
}
