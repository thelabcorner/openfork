import { describe, expect, test } from "bun:test"
import { GoalCreationPolicy } from "@opencode-ai/core/goal/creation-policy"

describe("GoalCreationPolicy", () => {
  test("allows explicit user-directed Goal creation", () => {
    expect(
      GoalCreationPolicy.authorize({
        userMessageID: "msg_goal_create",
        userText: "Create a goal for finishing this implementation and start Goal Mode.",
      }),
    ).toEqual({ allowed: true, reason: "explicit-user-request" })
    expect(
      GoalCreationPolicy.authorize({ userMessageID: "msg_use_goal", userText: "Use Goal Mode for this task." }).allowed,
    ).toBe(true)
    expect(
      GoalCreationPolicy.authorize({ userMessageID: "msg_want_goal", userText: "I want a Goal for this refactor." }).allowed,
    ).toBe(true)
  })

  test("does not treat informational or negative Goal discussion as authorization", () => {
    expect(
      GoalCreationPolicy.authorize({ userMessageID: "msg_info", userText: "How do I create a goal in OpenCode?" }).allowed,
    ).toBe(false)
    expect(
      GoalCreationPolicy.authorize({ userMessageID: "msg_no", userText: "Do not create a goal for this." }).allowed,
    ).toBe(false)
  })

  test("allows an affirmative reply to the immediately preceding Goal proposal", () => {
    expect(
      GoalCreationPolicy.authorize({
        userMessageID: "msg_confirm",
        userText: "Yeah, do it.",
        previousAssistantText: "This would benefit from Goal Mode. Should I create a Goal and start it for you?",
      }),
    ).toEqual({ allowed: true, reason: "confirmed-agent-proposal" })
  })

  test("does not allow unattended mode without an explicit unattended request", () => {
    expect(GoalCreationPolicy.explicitlyRequestsUnattended("Create a goal for this task.")).toBe(false)
    expect(GoalCreationPolicy.explicitlyRequestsUnattended("Create an unattended goal for this task.")).toBe(true)
  })

  test("recognizes an explicit draft/no-start request", () => {
    expect(GoalCreationPolicy.explicitlyRequestsDraft("Create a Goal draft for this, but don't start it yet.")).toBe(true)
    expect(GoalCreationPolicy.explicitlyRequestsDraft("Create and start a Goal for this.")).toBe(false)
  })
})
