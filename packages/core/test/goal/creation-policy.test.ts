import { describe, expect, test } from "bun:test"
import { GoalCreationPolicy } from "@opencode-ai/core/goal/creation-policy"

describe("GoalCreationPolicy", () => {
  test("allows explicit user-directed Goal creation", () => {
    expect(
      GoalCreationPolicy.authorize({
        userMessageID: "msg_goal_create",
        userText: "Create a goal for finishing this implementation and start Goal Mode.",
      }),
    ).toMatchObject({
      allowed: true,
      reason: "explicit-user-request",
      source: { userMessageID: "msg_goal_create" },
    })
    expect(
      GoalCreationPolicy.authorize({ userMessageID: "msg_use_goal", userText: "Use Goal Mode for this task." }).allowed,
    ).toBe(true)
    expect(
      GoalCreationPolicy.authorize({ userMessageID: "msg_want_goal", userText: "I want a Goal for this refactor." }).allowed,
    ).toBe(true)
  })

  test("recognizes varied natural-language Goal creation directives", () => {
    const requests = [
      "Make this a goal.",
      "Turn this into a Goal.",
      "Track this as a goal.",
      "Use goal mode for this.",
      "Switch to Goal Mode.",
      "Goal this task.",
      "Goal mode on.",
      "Goal mode please.",
      "Let's use Goal Mode for this refactor.",
      "We should make this a Goal.",
      "Could you please create a Goal for this migration?",
      "I want you to put this in Goal Mode.",
      "I need this to be a Goal.",
      "This should be a Goal.",
      "Set this as my goal.",
      "Spin up a goal for the implementation.",
      "Kick off a goal for this work.",
      "Run this as a goal.",
      "Create a new durable Goal for this.",
      "Turn this into a persistent Goal.",
      "We need Goal Mode for this.",
    ]
    for (const userText of requests) {
      expect(GoalCreationPolicy.explicitlyRequestsGoal(userText), userText).toBe(true)
    }
  })

  test("does not treat informational or negative Goal discussion as authorization", () => {
    expect(
      GoalCreationPolicy.authorize({ userMessageID: "msg_info", userText: "How do I create a goal in OpenCode?" }).allowed,
    ).toBe(false)
    expect(
      GoalCreationPolicy.authorize({ userMessageID: "msg_no", userText: "Do not create a goal for this." }).allowed,
    ).toBe(false)
  })

  test("rejects common Goal discussion and revocation phrases without overmatching unrelated negation", () => {
    const informational = [
      "Should I use Goal Mode for this?",
      "Would a goal help here?",
      "How does Goal Mode work?",
      "What is a Goal in OpenCode?",
      "Explain how to create a goal.",
      "Can I use Goal Mode with subagents?",
      "Is Goal Mode persistent?",
      "If I create a Goal, what happens next?",
      "Suppose we use Goal Mode here.",
      "For example, create a Goal for a migration.",
      "I could create a Goal manually instead.",
    ]
    for (const userText of informational) {
      expect(GoalCreationPolicy.explicitlyRequestsGoal(userText), userText).toBe(false)
      expect(GoalCreationPolicy.explicitlyDeclinesGoal(userText), userText).toBe(false)
    }

    const declines = [
      "Don't create a goal.",
      "I don't want a Goal for this.",
      "No Goal Mode.",
      "Do this without a goal.",
      "Skip Goal Mode.",
      "Turn off Goal Mode.",
      "Goal mode off.",
      "Don't goal this.",
      "This should not be a goal.",
      "I don't want this as a goal.",
      "I don't want to use Goal Mode.",
      "No need to create a Goal.",
      "You don't need to create a Goal for this.",
      "I'd rather not use Goal Mode.",
      "I don't think we need Goal Mode.",
      "I don't think this should be a Goal.",
      "Do the work, but not in Goal Mode.",
    ]
    for (const userText of declines) {
      expect(GoalCreationPolicy.explicitlyDeclinesGoal(userText), userText).toBe(true)
      expect(GoalCreationPolicy.explicitlyRequestsGoal(userText), userText).toBe(false)
    }

    // The old broad negation detector incorrectly rejected this because
    // "don't" appeared somewhere before "goal".
    expect(GoalCreationPolicy.explicitlyRequestsGoal("Don't wait around; create a Goal and start working.")).toBe(true)
    expect(GoalCreationPolicy.explicitlyRequestsGoal("Shouldn't we use Goal Mode?")).toBe(false)
  })

  test("allows an affirmative reply to the immediately preceding Goal proposal", () => {
    expect(
      GoalCreationPolicy.authorize({
        userMessageID: "msg_confirm",
        userText: "Yeah, do it.",
        previousAssistantText: "This would benefit from Goal Mode. Should I create a Goal and start it for you?",
      }),
    ).toMatchObject({
      allowed: true,
      reason: "confirmed-agent-proposal",
      source: { userMessageID: "msg_confirm" },
    })

    for (const userText of ["Absolutely.", "Go for it.", "Proceed with it.", "Yes please.", "Let's do it.", "That works."]) {
      expect(
        GoalCreationPolicy.confirmsGoalProposal(
          userText,
          "I can put this into Goal Mode and track it as a durable Goal. Want me to?",
        ),
        userText,
      ).toBe(true)
    }
  })

  test("carries an older explicit Goal request across neutral follow-up turns", () => {
    const authorization = GoalCreationPolicy.authorize({
      userMessageID: "msg_current",
      userText: "Continue with the implementation.",
      priorUserTurns: [
        { userMessageID: "msg_goal_request", userText: "Set a Goal for this whole refactor and start it." },
        { userMessageID: "msg_older", userText: "Please inspect the package first." },
      ],
    })
    expect(authorization).toMatchObject({
      allowed: true,
      reason: "explicit-user-request",
      source: { userMessageID: "msg_goal_request" },
    })
  })

  test("uses newest relevant Goal directive so a later rejection revokes older consent", () => {
    expect(
      GoalCreationPolicy.authorize({
        userMessageID: "msg_current",
        userText: "Keep going.",
        priorUserTurns: [
          { userMessageID: "msg_revoke", userText: "Don't create a Goal for this after all." },
          { userMessageID: "msg_goal_request", userText: "Create a Goal for this refactor." },
        ],
      }).allowed,
    ).toBe(false)

    expect(
      GoalCreationPolicy.authorize({
        userMessageID: "msg_new_goal",
        userText: "Actually, create a Goal for it now.",
        priorUserTurns: [{ userMessageID: "msg_revoke", userText: "Don't create a Goal for this." }],
      }).allowed,
    ).toBe(true)
  })

  test("recognizes explicit current-turn Goal update directives without treating discussion as permission", () => {
    const updates = [
      "Update the goal and add stress-test corpuses.",
      "Revise the current Goal acceptance criteria.",
      "Could you please update the goal with stricter parity checks?",
      "Revise the acceptance criteria for the goal.",
      "Add bitmap parity to the goal.",
      "The goal should also require 1:1 bitmap parity.",
      "Make sure the goal includes a broad stress corpus.",
      "Extend my Goal with another verification step.",
    ]
    for (const userText of updates) {
      expect(GoalCreationPolicy.explicitlyRequestsGoalUpdate(userText), userText).toBe(true)
      expect(
        GoalCreationPolicy.authorizeUpdate({ userMessageID: "msg_goal_update", userText }).allowed,
        userText,
      ).toBe(true)
    }

    for (const userText of [
      "How do I update the goal?",
      "Should we update the goal?",
      "Could we update the goal later?",
      "Don't update the goal.",
      "Leave the goal unchanged.",
      "Continue working on the goal.",
    ]) {
      expect(GoalCreationPolicy.authorizeUpdate({ userMessageID: "msg_goal_update_no", userText }).allowed, userText).toBe(false)
    }
  })

  test("does not borrow stale Goal-update permission from older human turns", () => {
    expect(
      GoalCreationPolicy.authorizeUpdate({
        userMessageID: "msg_current",
        userText: "Continue with the implementation.",
        priorUserTurns: [{ userMessageID: "msg_old_update", userText: "Update the goal with more stress tests." }],
      }).allowed,
    ).toBe(false)
  })

  test("recognizes an explicit draft/no-start request", () => {
    expect(GoalCreationPolicy.explicitlyRequestsDraft("Create a Goal draft for this, but don't start it yet.")).toBe(true)
    expect(GoalCreationPolicy.explicitlyRequestsDraft("Set up the Goal but hold off on running it.")).toBe(true)
    expect(GoalCreationPolicy.explicitlyRequestsDraft("Leave it as a draft.")).toBe(true)
    expect(GoalCreationPolicy.explicitlyRequestsDraft("Create the goal without activating it.")).toBe(true)
    expect(GoalCreationPolicy.explicitlyRequestsDraft("Make the goal, but not yet.")).toBe(true)
    expect(GoalCreationPolicy.explicitlyRequestsDraft("Create and start a Goal for this.")).toBe(false)
  })
})
