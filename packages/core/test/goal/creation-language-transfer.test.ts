import { describe, expect, test } from "bun:test"
import { GoalCreationPolicy as Goal } from "@opencode-ai/core/goal/creation-policy"

/**
 * Exploratory transfer set written after the first language changes, before
 * inspecting predictions on these phrasings. Kept separate from development
 * examples to disclose when these cases become tuned regression tests.
 */
const create = [
  "Could you build a Goal around shipping this feature?",
  "Put this under a Goal, please.",
  "Please make a lasting goal that keeps going through audits.",
  "Would you take this project on as a Goal?",
  "I need Goal Mode running for this work.",
  "It's time to make this a goal.",
  "This needs to be tracked as a Goal.",
  "Can you start Goal Mode and leave it active?",
  "Go ahead, create one persistent Goal for all this.",
  "No more one-off iterations: track this as a Goal.",
] as const

const abstain = [
  "We're designing a button labeled Create a Goal.",
  "The user requested a Goal yesterday.",
  "I'm planning to make a goal next week.",
  "Teach me to make a goal.",
  "Write unit tests for create a goal.",
  "When the user says create a goal, show a dialog.",
  "Build a function that can create a goal.",
  "Give me five examples of how to create a goal.",
  "Our CLI command is 'create a goal'.",
  "No Goal yet; just review the implementation.",
  "I want to create a SMART fitness goal on paper.",
  "Can we use Goals in the application?",
  "Would Goal Mode solve this problem?",
  "Please document the create a goal command.",
  "The meeting agenda says create a Goal, but that's not my request.",
] as const

describe("Goal language transfer probe", () => {
  test("creation wording", () => {
    const missed = create.filter((userText) => !Goal.authorize({ userMessageID: "transfer", userText }).allowed)
    expect(missed, `Missed:\n${missed.join("\n")}`).toEqual([])
  })
  test("quoted, hypothetical, and software-development uses abstain", () => {
    const wrong = abstain.filter((userText) => Goal.authorize({ userMessageID: "transfer", userText }).allowed)
    expect(wrong, `Incorrectly authorized:\n${wrong.join("\n")}`).toEqual([])
  })
})
