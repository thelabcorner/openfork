import type { QuestionV2Request } from "@opencode-ai/sdk/v2/client"
import { For, Show, createSignal } from "solid-js"
import { IconAlertTriangle, IconCheck, IconHelpCircle } from "../icons"
import { Sheet } from "./Sheet"

export function QuestionPrompt(props: {
  open: boolean
  onClose: () => void
  request: QuestionV2Request
  onSubmit: (answers: string[][]) => void
  error?: string
}) {
  const [answers, setAnswers] = createSignal<string[][]>(props.request.questions.map(() => []))

  const toggle = (qi: number, label: string, multiple?: boolean) => {
    setAnswers((prev) => {
      const next = prev.map((a) => a.slice())
      const current = next[qi] ?? []
      if (multiple) {
        next[qi] = current.includes(label) ? current.filter((l) => l !== label) : [...current, label]
      } else {
        next[qi] = [label]
      }
      return next
    })
  }

  const canSubmit = () => answers().every((a) => a.length > 0)

  return (
    <Sheet open={props.open} onClose={props.onClose} height="auto">
      <div class="prompt-sheet-body">
        <div class="prompt-head">
          <div class="prompt-icon info">
            <IconHelpCircle size={15} />
          </div>
          <div>
            <h3>{props.request.questions.length > 1 ? "Agent questions" : "Agent question"}</h3>
          </div>
        </div>

        <For each={props.request.questions}>
          {(question, qi) => (
            <div>
              <p style={{ "font-size": "var(--font-sm)", color: "var(--text-secondary)", margin: "0 0 8px", "line-height": "1.5" }}>
                {question.question}
              </p>
              <div style={{ display: "grid", gap: "6px" }}>
                <For each={question.options}>
                  {(option) => {
                    const selected = () => answers()[qi()]?.includes(option.label) ?? false
                    return (
                      <button
                        class={`question-option ${selected() ? "selected" : ""}`}
                        onClick={() => toggle(qi(), option.label, question.multiple)}
                      >
                        <div class="option-check">
                          <Show when={selected()}><IconCheck size={10} /></Show>
                        </div>
                        <div>
                          <div>{option.label}</div>
                          <Show when={option.description}><div class="option-desc">{option.description}</div></Show>
                        </div>
                      </button>
                    )
                  }}
                </For>
              </div>
            </div>
          )}
        </For>

        <Show when={props.error}>
          <div class="prompt-error">
            <IconAlertTriangle size={12} />
            <span>{props.error}</span>
          </div>
        </Show>

        <div class="prompt-actions">
          <button class="btn-tint" disabled={!canSubmit()} onClick={() => props.onSubmit(answers())}>
            Submit
          </button>
        </div>
      </div>
    </Sheet>
  )
}
