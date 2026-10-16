import { describe, expect, test } from "bun:test"
import { GoalCreationPolicy as Goal } from "@opencode-ai/core/goal/creation-policy"

/** Spoken-English/disfluency probe. No inference; examples authored before inspection. */
const operational = [
  "Uh, make this a goal, please.",
  "Could you, um, create a Goal for this?",
  "Can you, like, put this in Goal Mode?",
  "So, um, let's make this a goal.",
  "I, uh, need this to be a Goal.",
  "I want you to, um, create a goal for this.",
  "Create, you know, a goal to run this migration.",
  "I mean, can you set me up, uh, with a Goal?",
  "Hey, Goal Mode this, please.",
  "Please make this into, um, a persistent goal.",
  "Okay, build a goal for this, please.",
  "Goal mode, please, for this project.",
] as const
const nonOperational = [
  "Um, can you explain how Goal Mode works?",
  "Uh, create a Goal is what this code sample says.",
  "I, uh, don't want a Goal for this.",
  "No, um, please don't start a Goal.",
  "I was, like, asking what a Goal is.",
  "Um, how would I create a Goal?",
  "You know, create a Goal for this is only an example.",
  "Hey, 'create a goal' is quoted; don't run it.",
  "Actually, um, please skip Goal Mode for the task.",
] as const

describe("Goal spoken-language robustness", () => {
  test("natural conversational directives", () => {
    const missed = operational.filter((userText) => !Goal.authorize({ userMessageID: "voice", userText }).allowed)
    expect(missed, `Missed:\n${missed.join("\n")}`).toEqual([])
  })
  test("filler words cannot turn examples or revocations into consent", () => {
    const wrong = nonOperational.filter((userText) => Goal.authorize({ userMessageID: "voice", userText }).allowed)
    expect(wrong, `Incorrectly authorized:\n${wrong.join("\n")}`).toEqual([])
  })
})
