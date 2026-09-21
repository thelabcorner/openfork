import { describe, expect, test } from "bun:test"
import { ScheduledTaskCreationPolicy } from "@opencode-ai/core/scheduled-task/creation-policy"

describe("ScheduledTaskCreationPolicy", () => {
  test("accepts explicit conversational scheduling requests", () => {
    for (const text of [
      "Schedule a task every weekday at 9am to run the dependency audit.",
      "Create a scheduled task that runs nightly.",
      "Schedule this for tomorrow at 3 PM.",
      "Set up a daily 9am task to check CI.",
      "Every weekday at 9, run the dependency audit.",
      "Remind me every morning to review the overnight failures.",
    ]) {
      expect(ScheduledTaskCreationPolicy.authorize({ userMessageID: "msg", userText: text }).allowed).toBe(true)
    }
  })

  test("accepts immediate confirmation of an agent scheduling proposal", () => {
    expect(
      ScheduledTaskCreationPolicy.authorize({
        userMessageID: "msg",
        userText: "Yes, do it.",
        previousAssistantText: "Would you like me to schedule a daily task at 9am for this?",
      }),
    ).toEqual({ allowed: true, reason: "confirmed-agent-proposal" })
  })

  test("rejects unsolicited, informational, and negated creation", () => {
    for (const text of [
      "Please fix the tests.",
      "How do scheduled tasks work?",
      "Don't schedule a task for this.",
      "Never schedule this automatically.",
    ]) {
      expect(ScheduledTaskCreationPolicy.authorize({ userMessageID: "msg", userText: text }).allowed).toBe(false)
    }
    expect(ScheduledTaskCreationPolicy.authorize(undefined).allowed).toBe(false)
  })

  test("does not treat bare affirmation as authority without a scheduling proposal", () => {
    expect(
      ScheduledTaskCreationPolicy.authorize({
        userMessageID: "msg",
        userText: "Yes, do it.",
        previousAssistantText: "Should I refactor this module now?",
      }).allowed,
    ).toBe(false)
  })

  test("recognizes an explicit draft/disabled schedule request", () => {
    expect(ScheduledTaskCreationPolicy.explicitlyRequestsDisabled("Create this as a draft schedule.")).toBe(true)
    expect(ScheduledTaskCreationPolicy.explicitlyRequestsDisabled("Schedule it but leave it disabled.")).toBe(true)
    expect(ScheduledTaskCreationPolicy.explicitlyRequestsDisabled("Schedule it without enabling it.")).toBe(true)
    expect(ScheduledTaskCreationPolicy.explicitlyRequestsDisabled("Schedule it every morning.")).toBe(false)
  })

  test("requires explicit human intent for management mutations including acknowledgement", () => {
    expect(
      ScheduledTaskCreationPolicy.authorizeManagement("acknowledge", {
        userMessageID: "msg",
        userText: "Mark that scheduled task result as read.",
      }),
    ).toEqual({ allowed: true, reason: "explicit-user-request" })
    expect(
      ScheduledTaskCreationPolicy.authorizeManagement("acknowledge", {
        userMessageID: "msg",
        userText: "Show me the scheduled task result.",
      }).allowed,
    ).toBe(false)
  })
})
