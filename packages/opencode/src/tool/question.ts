import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
  details: ReadonlyArray<string>
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const { answers, details } = yield* question.askDetailed({
            sessionID: ctx.sessionID,
            questions: params.questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          if (params.questions.length === 0) {
            return {
              title: "Asked 0 questions",
              output: "The question tool was called without any questions. Continue without user input.",
              metadata: { answers, details },
            }
          }

          const formatted = params.questions
            .map((q, i) => {
              const answer = answers[i] ?? []
              const detail = details[i]?.trim() ?? ""
              const prompt = JSON.stringify(q.question)
              if (answer.length === 0 && !detail) return `${prompt}: Unanswered`
              const parts = [
                answer.length > 0 ? `selected=${JSON.stringify(answer)}` : undefined,
                detail ? `details=${JSON.stringify(detail)}` : undefined,
              ].filter(Boolean)
              return `${prompt}: ${parts.join(" ")}`
            })
            .join(", ")

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            metadata: {
              answers,
              details,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
