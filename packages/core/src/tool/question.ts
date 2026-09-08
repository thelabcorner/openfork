export * as QuestionTool from "./question"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { QuestionV2 } from "../question"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "question"

export const description = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- \`multiple: false\` (default) allows one provided option; \`multiple: true\` allows selecting any number of provided options
- \`custom: true\` (default) adds a free-form response field that is independent of the provided options. The user may select option(s), type a custom response, or do both. Set \`custom: false\` only when free-form context would not be useful
- Selected option labels are returned in \`answers\`; independent free-form text is returned in the parallel \`details\` array
- Option labels must be unique within a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`

export const Input = Schema.Struct({
  questions: Schema.Array(QuestionV2.Prompt).annotate({ description: "Questions to ask" }),
})

export const Output = Schema.Struct({
  answers: Schema.Array(QuestionV2.Answer),
  details: Schema.Array(Schema.String),
})
export type Output = typeof Output.Type

export const toModelOutput = (
  questions: ReadonlyArray<QuestionV2.Prompt>,
  answers: ReadonlyArray<QuestionV2.Answer>,
  details: ReadonlyArray<string> = [],
) => {
  if (questions.length === 0) return "The question tool was called without any questions. Continue without user input."
  const formatted = questions
    .map((question, index) => {
      const answer = answers[index] ?? []
      const detail = details[index]?.trim() ?? ""
      const prompt = JSON.stringify(question.question)
      if (answer.length === 0 && !detail) return `${prompt}: Unanswered`
      const parts = [
        answer.length > 0 ? `selected=${JSON.stringify(answer)}` : undefined,
        detail ? `details=${JSON.stringify(detail)}` : undefined,
      ].filter(Boolean)
      return `${prompt}: ${parts.join(" ")}`
    })
    .join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const question = yield* QuestionV2.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ input, output }) => [
            { type: "text", text: toModelOutput(input.questions, output.answers, output.details) },
          ],
          execute: (input, context) =>
            permission
              .assert({
                action: "question",
                resources: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              .pipe(
                Effect.mapError(() => new ToolFailure({ message: "Permission denied: question" })),
                Effect.andThen(
                  question
                    .askDetailed({
                      sessionID: context.sessionID,
                      questions: input.questions,
                      tool: { messageID: context.assistantMessageID, callID: context.toolCallID },
                    })
                    .pipe(Effect.orDie),
                ),
                Effect.map(({ answers, details }) => ({ answers, details })),
              ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/question",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, QuestionV2.node],
})
