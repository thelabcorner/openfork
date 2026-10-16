import { describe, expect, test } from "bun:test"
import { GoalCreationPolicy as Policy } from "@opencode-ai/core/goal/creation-policy"

describe("Goal language intent boundaries", () => {
  test("recognizes ordinary requests without requiring a canonical command", () => {
    const requests = [
      "How about making this a goal?",
      "Would you mind creating a goal for this renderer?",
      "Why don't you make this a goal?",
      "Goalify this task.",
      "Treat this as an ongoing task.",
      "Keep working autonomously until all checks pass.",
      "Continue iterating automatically until CI passes.",
      "Create a long-running goal for the migration.",
      "Actually, create a goal for this.",
      "Don't create a goal. Actually, create a goal for this.",
      "Can you set this up as a goal?",
      "Create a goal for the parsing work, but do not rush it.",
    ]
    for (const userText of requests) {
      expect(Policy.explicitlyRequestsGoal(userText), userText).toBe(true)
      expect(Policy.authorize({ userMessageID: "msg_directive", userText }).allowed, userText).toBe(true)
    }
  })

  test("keeps examples, discussion, conditions, and ordinary iteration non-authorizing", () => {
    const descriptions = [
      "Can you explain how Goal Mode works?",
      "Should we create a goal?",
      "What if we create a goal?",
      "How about a goal?",
      "Keep working until the unit tests pass.",
      "Please make this a goal when I ask you later.",
      "Create a goal if I say so.",
      "Here is an example: create a goal.",
      "Explain this log: create a goal",
      "He said \"Create a Goal\"",
      "To quote: 'Create a Goal'",
      "A transcript says `create a goal`.",
      "The docs say: create a goal.",
    ]
    for (const userText of descriptions) {
      expect(Policy.authorize({ userMessageID: "msg_discussion", userText }).allowed, userText).toBe(false)
    }
  })

  test("respects newest contradictory directive and preserves explicit rejection", () => {
    for (const userText of [
      "Create a Goal. Actually, don't create a goal.",
      "Do not make a Goal; now just run the tests.",
      "Don't create a Goal. Continue working normally.",
    ]) {
      expect(Policy.explicitlyDeclinesGoal(userText), userText).toBe(true)
      expect(Policy.authorize({ userMessageID: "msg_revoke", userText }).allowed, userText).toBe(false)
    }
  })

  test("confirmation requires an actual offer to establish durable Goal state", () => {
    const accept = "I can create a Goal for this project and track its completion. Want me to?"
    const discuss = [
      "What does Goal Mode do?",
      "I can explain how to create a Goal. Want me to?",
      "Goal Mode offers automatic iteration. Interested?",
      "Would you like to hear more about Goal Mode?",
    ]
    expect(Policy.confirmsGoalProposal("Yes, do it.", accept)).toBe(true)
    expect(Policy.confirmsGoalProposal("Yes, later.", accept)).toBe(false)
    for (const assistant of discuss) {
      expect(Policy.confirmsGoalProposal("Yes, please.", assistant), assistant).toBe(false)
    }
    expect(
      Policy.confirmsGoalProposal(
        "Yes, but don't start it yet.",
        "Should I create a Goal for the project?",
      ),
    ).toBe(true)
  })

  test("distinguishes declining activation from declining creation", () => {
    expect(Policy.explicitlyRequestsGoal("Create a Goal, but don't start Goal Mode yet.")).toBe(true)
    expect(Policy.explicitlyRequestsDraft("Create a Goal, but don't start Goal Mode yet.")).toBe(true)
    expect(Policy.authorize({
      userMessageID: "msg_draft_confirm",
      userText: "Yes, but don't start Goal Mode yet.",
      previousAssistantText: "Should I create a Goal for this?",
    }).allowed).toBe(true)
    expect(Policy.authorize({
      userMessageID: "msg_declined_create",
      userText: "Don't create a Goal, not even a draft.",
    }).allowed).toBe(false)
  })

  test("recognizes human-directed acceptance-criteria updates but not discussion", () => {
    const updates = [
      "How about adding visual parity to the goal?",
      "Please add negative tests to the acceptance criteria.",
      "Change the goal objective to cover all adapters.",
    ]
    for (const userText of updates) {
      expect(Policy.authorizeUpdate({ userMessageID: "msg_edit", userText }).allowed, userText).toBe(true)
    }
    for (const userText of ["How do I add acceptance criteria?", "Please don't modify the acceptance criteria."]) {
      expect(Policy.authorizeUpdate({ userMessageID: "msg_no_edit", userText }).allowed, userText).toBe(false)
    }
  })
})