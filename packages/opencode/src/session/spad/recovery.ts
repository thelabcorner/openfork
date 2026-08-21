export function recoveryPrompt(attempt: number): string {
  if (attempt <= 1) return "[Internal recovery] The previous generation entered a repetitive output loop and was interrupted. Do not continue or recreate the repeated tail. Re-anchor to the last genuine user request and completed tool state, then continue from the first unfinished objective using a different continuation. If the task is already complete, end the turn."
  return "[Internal recovery: second attempt] Repetition recurred. Treat the interrupted assistant continuation as invalid and absent. Reconstruct the current task state from the last genuine user request and completed tool results. Choose a different next action and do not regenerate the previous continuation. If no useful next action exists, end the turn."
}

export function toolRecoveryPrompt(attempt: number): string {
  if (attempt <= 1) return "[Internal recovery] Tool-call loop detected and interrupted. Do not repeat the same exploration pattern. Re-anchor to the last genuine user request and the files already modified, summarize what has been verified, and choose a different next tool or finish the task. Avoid re-reading the same files without making progress."
  return "[Internal recovery: second attempt] Tool-call repetition recurred. Treat the repeated exploration as invalid. Reconstruct the task state from completed tool results, produce a concise status update, and either make a mutating edit or end the turn. Do not continue the same tool sequence."
}

export function thrashRecoveryPrompt(attempt: number): string {
  if (attempt <= 1)
    return "[Internal recovery] The last several steps repeated the same exploration without making progress (re-reading the same files or reusing the same approach, with no edits). Do not continue that pattern. Summarize what has already been verified, then either make a concrete mutating change (write/edit) that advances the goal, or end the turn if the task is already complete. Avoid re-reading files you have already inspected."
  return "[Internal recovery: second attempt] The repetition continued across attempts. Treat the repeated exploration as invalid. Reconstruct the current task state from the last genuine user request and any completed tool results, produce a concise status update, and either make a mutating edit or end the turn. Do not regenerate the previous continuation."
}
