export type QuestionMentionToken = {
  start: number
  end: number
  query: string
}

const boundary = /[\s([{"'`]/
const terminator = /[\s,;!?)}\]}'"`]/

export function questionMentionToken(value: string, cursor: number): QuestionMentionToken | undefined {
  const caret = Math.max(0, Math.min(value.length, cursor))
  for (let index = caret - 1; index >= 0; index--) {
    const char = value[index]
    if (char === "@") {
      if (index > 0 && !boundary.test(value[index - 1] ?? "")) return
      const query = value.slice(index + 1, caret)
      if (!query || terminator.test(query)) return
      let end = caret
      while (end < value.length && !terminator.test(value[end] ?? "")) end++
      return { start: index, end, query }
    }
    if (terminator.test(char ?? "")) return
  }
}

export function applyQuestionMention(value: string, token: QuestionMentionToken, path: string) {
  const mention = `@${path}`
  const suffix = value.slice(token.end)
  const spacer = suffix.length === 0 ? " " : /^[\s,.;:!?)}\]]/.test(suffix) ? "" : " "
  const next = value.slice(0, token.start) + mention + spacer + suffix
  return {
    value: next,
    cursor: token.start + mention.length + spacer.length,
  }
}
