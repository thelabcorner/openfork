import { Question } from "@opencode-ai/schema/question"

export type Info = typeof Question.Info.Type
export type Answer = typeof Question.Answer.Type

export interface Resolved {
  readonly answers: ReadonlyArray<Answer>
  readonly details: ReadonlyArray<string>
}

const MAX_DETAIL_CHARS = 16_384

const cleanDetail = (value: string) => value.trim().slice(0, MAX_DETAIL_CHARS)

export function normalizeReply(
  questions: ReadonlyArray<Info>,
  input: { readonly answers: ReadonlyArray<Answer>; readonly details?: ReadonlyArray<string> },
): Resolved {
  const answers: Answer[] = []
  const details: string[] = []

  for (let index = 0; index < questions.length; index++) {
    const question = questions[index]!
    const labels = new Set(question.options.map((option) => option.label).filter((label) => label.trim().length > 0))
    const selected: string[] = []
    const selectedSet = new Set<string>()
    const legacyDetails: string[] = []

    for (const item of input.answers[index] ?? []) {
      if (labels.has(item)) {
        if (selectedSet.has(item)) continue
        if (question.multiple !== true && selected.length > 0) continue
        selected.push(item)
        selectedSet.add(item)
        continue
      }
      const detail = cleanDetail(item)
      if (detail) legacyDetails.push(detail)
    }

    const explicit = cleanDetail(input.details?.[index] ?? "")
    if (explicit && !legacyDetails.includes(explicit)) legacyDetails.push(explicit)
    const customAllowed = question.custom !== false || labels.size === 0
    const detail = customAllowed ? cleanDetail(legacyDetails.join("\n")) : ""

    answers.push(selected)
    details.push(detail)
  }

  return { answers, details }
}

export function flattenResolved(value: Resolved): ReadonlyArray<Answer> {
  return value.answers.map((answer, index) => {
    const detail = value.details[index]?.trim()
    return detail ? [...answer, detail] : [...answer]
  })
}
