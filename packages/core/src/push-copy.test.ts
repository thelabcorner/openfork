import { describe, expect, test } from "bun:test"
import {
  completedCopy,
  errorText,
  failedCopy,
  permissionCopy,
  projectLabel,
  questionCopy,
  sessionTitle,
} from "./push-copy"

describe("push notification copy", () => {
  const context = { title: "Implement mobile pairing", projectName: "opencode" }

  test("names the completed chat and project", () => {
    expect(completedCopy(context, "ses_123")).toEqual({
      title: "Completed · Implement mobile pairing",
      body: "opencode · Your agent finished this chat.",
      sessionTitle: "Implement mobile pairing",
      projectLabel: "opencode",
    })
  })

  test("includes an actionable failure reason", () => {
    expect(failedCopy(context, "ses_123", { message: "Provider timed out" }).body).toBe("opencode · Provider timed out")
    expect(errorText({ data: { message: "Nested provider error" } })).toBe("Nested provider error")
  })

  test("makes approval and question notifications identifiable", () => {
    expect(permissionCopy(context, "ses_123", "bash").title).toBe("Approval needed · Implement mobile pairing")
    expect(questionCopy(context, "ses_123", "Which package should I update?").body).toBe(
      "opencode · Which package should I update?",
    )
  })

  test("falls back to a safe directory label and session id", () => {
    expect(projectLabel({ directory: "C:\\work\\mobile" })).toBe("mobile")
    expect(sessionTitle({}, "ses_abcdef123")).toBe("Untitled chat · bcdef123")
  })
})
