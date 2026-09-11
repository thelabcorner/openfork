import { describe, expect, test } from "bun:test"
import {
  applyRevisedGoalObjective,
  buildGoalRevisorDraft,
  buildGoalRevisorGuidance,
  buildGoalStartMessage,
  buildGoalUpdatedMessage,
} from "./goal-revisor"

describe("Goal revisor", () => {
  test("composes objective, done-when, and composer prompt into one revisor draft", () => {
    const draft = buildGoalRevisorDraft({
      objective: "Fix presgen client bugs",
      criteria: "tsc passes\ntests pass",
      promptText: "focus on canvas tools",
    })
    expect(draft).toContain("Fix presgen client bugs")
    expect(draft).toContain("tsc passes")
    expect(draft).toContain("focus on canvas tools")
  })

  test("handles an empty objective without producing an empty draft", () => {
    const draft = buildGoalRevisorDraft({ objective: "", criteria: "a", promptText: "" })
    expect(draft.length).toBeGreaterThan(0)
    expect(draft).toContain("empty")
  })

  test("guidance asks for a markdown goal-objective document", () => {
    expect(buildGoalRevisorGuidance()).toContain("goal-objective.md")
  })

  test("trims revised output before applying", () => {
    expect(applyRevisedGoalObjective("\n\n# Goal\nDone\n\n")).toBe("# Goal\nDone")
  })

  test("start message covers both empty-prompt and with-prompt cases", () => {
    const withoutPrompt = buildGoalStartMessage({ objective: "Ship it", criteria: ["a", "b"] })
    expect(withoutPrompt).toContain("[GOAL START]")
    expect(withoutPrompt).toContain("Ship it")
    expect(withoutPrompt).not.toContain("Composer note")

    const withPrompt = buildGoalStartMessage({ objective: "Ship it", criteria: [], promptText: "hello" })
    expect(withPrompt).toContain("Composer note")
    expect(withPrompt).toContain("hello")
  })

  test("update message carries the edited brief", () => {
    expect(buildGoalUpdatedMessage({ title: "T", objective: "O" })).toContain("[GOAL UPDATED] T")
  })
})
