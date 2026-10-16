import { describe, expect, test } from "bun:test"
import { GoalCreationPolicy as Goal } from "@opencode-ai/core/goal/creation-policy"

/**
 * AX Goal-language challenge, authored before the policy rewrite.
 * Fixed input/output expectations, deterministic, no model inference or API cost.
 * This is development evaluation, not an independently blinded holdout.
 */
const requests = [
  "Okay, could you go ahead and make this a goal?",
  "Go ahead and make this a goal for the whole refactor.",
  "Can you please turn this work into a tracked Goal?",
  "Would you mind making a goal out of this?",
  "Please set me up with a Goal for this migration.",
  "I'd like to have a goal tracking this work.",
  "Let's make a goal out of this.",
  "Can you goal-mode the implementation?",
  "Put the implementation into Goal Mode, please.",
  "I really want to track this project as a Goal.",
  "Set up goal mode for this and start working.",
  "Would you set up a goal to tackle this?",
  "Track the release work as a durable goal.",
  "Please, would you create a goal to finish this?",
  "Please make this project a Goal.",
  "Please make the migration a durable Goal, but don't start it yet.",
  "How does Goal Mode work? Also, create a Goal for this refactor.",
  "Could you explain how Goal Mode works? And then create a goal for this project.",
  "I'm curious about goals. Please make this a Goal now.",
  "No Goal Mode for the earlier bugfix. Actually, create a goal for this new migration.",
  "I'm not asking about Goal Mode; I'm asking you to create a Goal.",
  "Please create a goal called 'Reliability pass'.",
  "Can you please create a @goal for this effort?",
  "Let's put this in a persistent goal and work through it.",
  "Set me up a goal for the release.",
  "Add a new Goal to track this work.",
  "Start a Goal for this implementation, if you can.",
] as const

const nonRequests = [
  "Would creating a goal be helpful here?",
  "Could you explain how to create a Goal?",
  "Can you show me how to start Goal Mode?",
  "I want to understand how to create a Goal.",
  "I would like to learn how goals are created.",
  "What would you do if you created a Goal?",
  "Explain Goal Mode, then give me some pros and cons.",
  "The documentation says: create a Goal for this task.",
  "He told me \"create a Goal\" but I'm not ready.",
  "Here is an example: \"create a goal for testing\".",
  "`create a Goal` is the sample command in our docs.",
  "```text\ncreate a Goal for this\n```\nExplain why this example exists.",
  "> Create a Goal for this\nCan you review that quote?",
  "What about adding Goal Mode to the UI?",
  "Could we maybe create a goal later?",
  "I'd like to talk about using Goal Mode first.",
  "Can we discuss the Goal Mode feature?",
  "Should we start a goal at all?",
  "Goal Mode seems complicated. Why?",
  "No Goal Mode, just fix the bug.",
  "Do not create a goal for this.",
  "Please don't make this a goal.",
  "Yes, but don't create a goal.",
  "Make a goal? Not right now.",
  "Can I make a goal from the UI?",
  "Let's think about whether this should be a Goal.",
  "Please write a guide titled \"Create a Goal\".",
  "Summarize the phrase 'make this a goal'.",
  "My function createGoal() needs tests.",
  "Please explain how to goalify this work.",
  "Could you explain how to make this a Goal?",
  "If we use Goal Mode someday, what happens to drafts?",
] as const

const updates = [
  "Could you please add runtime parity checks to the Goal?",
  "Please make the current Goal cover Windows and macOS.",
  "I'd like the Goal to include a test plan.",
  "I want the goal criteria to cover accessible workflows.",
  "Please revise the Goal. Also, explain the acceptance criteria.",
  "How do I update a Goal? Also, please add browser tests to this goal.",
  "And update the goal to include cancellation testing.",
  "Update the goal, but do not run the tests yet.",
] as const
const nonUpdates = [
  "Could you explain how to update the Goal?",
  "Can you show me how to update the goal?",
  "I want to understand how to update a goal.",
  "`update the goal` appears in the docs.",
  "No goal updates, please.",
  "What would happen if we updated the goal?",
  "Could you explain how to add regression tests to the acceptance criteria?",
  "Please don't update the current goal.",
] as const

describe("Goal language authorization challenge", () => {
  function check(samples: readonly string[], expected: boolean, classify: (text: string) => boolean) {
    const misses = samples.filter((text) => classify(text) !== expected)
    expect(misses, `${misses.length}/${samples.length} mismatches:\n${misses.join("\n")}`).toEqual([])
  }
  test("accepts explicit conversational Goal creation", () => {
    check(requests, true, (userText) => Goal.authorize({ userMessageID: "msg_request", userText }).allowed)
  })
  test("abstains on explanation, quotation, speculation, and revocation", () => {
    check(nonRequests, false, (userText) => Goal.authorize({ userMessageID: "msg_not_request", userText }).allowed)
  })
  test("supports current-turn conversational updates, without treating discussion as authority", () => {
    check(updates, true, (userText) => Goal.authorizeUpdate({ userMessageID: "msg_update", userText }).allowed)
    check(nonUpdates, false, (userText) => Goal.authorizeUpdate({ userMessageID: "msg_not_update", userText }).allowed)
  })
  test("draft intent does not prohibit the creation itself", () => {
    for (const userText of [
      "Please create the Goal, but do not start it yet.",
      "Make a draft goal for the migration; we'll launch it later.",
      "Don't start it yet, but please set up a Goal for this.",
      "Set up Goal Mode as a draft and hold off on running it.",
    ]) {
      expect(Goal.authorize({ userMessageID: "msg_draft", userText }).allowed, userText).toBe(true)
      expect(Goal.explicitlyRequestsDraft(userText), userText).toBe(true)
    }
  })
  test("confirmation must answer an actual Goal creation proposal, not general discussion", () => {
    for (const userText of ["Yes", "Sure", "Okay", "Go ahead."]) {
      expect(
        Goal.confirmsGoalProposal(userText, "Goal Mode can be configured. Do you have any other questions?"),
        userText,
      ).toBe(false)
      expect(
        Goal.confirmsGoalProposal(userText, "Should I create a Goal and start the work?"),
        userText,
      ).toBe(true)
    }
    expect(Goal.confirmsGoalProposal("Yes, but don't create a goal.", "Should I create a Goal?")).toBe(false)
    expect(Goal.confirmsGoalProposal("Yes.", "The manual quotes \"Should I create a Goal?\" as an example.")).toBe(false)
    expect(Goal.confirmsGoalProposal("Yes.", "I can explain how Goal Mode works. Want me to?")).toBe(false)
    expect(Goal.confirmsGoalProposal("Yes.", "I can explain Goal Mode. Should I create a Goal for you?")).toBe(true)
    expect(Goal.confirmsGoalProposal("Yes, but I only want to discuss Goal Mode.", "Should I create a Goal?")).toBe(false)
  })
})
