import { describe, expect, test } from "bun:test"
import { isUnavailableReasoningSentinel } from "@opencode-ai/core/reasoning-sentinel"
import type { Part } from "@opencode-ai/sdk/v2"
import { projectWorkingAssistantParts } from "./working-part-structure"

const partText = (part: Part) => (part.type === "reasoning" || part.type === "text" ? part.text : undefined)

const reasoning = (text: string) => ({
  id: "reasoning",
  type: "reasoning",
  text,
}) as Part

describe("session timeline reasoning sentinel integration", () => {
  test("known unavailability sentinels remain preserved but are not structurally visible", () => {
    for (const value of ["No reasoning available.", "No reasoning available.<|start|>"]) {
      expect(isUnavailableReasoningSentinel(value)).toBe(true)
      const input = reasoning(value)
      const projected = projectWorkingAssistantParts([input])[0]!
      expect(partText(projected)).toBe("")
      expect(partText(input)).toBe(value)
    }
  })

  test("real reasoning remains structurally visible", () => {
    for (const value of [
      "Evaluating the parser's failure states.",
      "No reasoning available. The provider supplied only a summary.",
    ]) {
      expect(partText(projectWorkingAssistantParts([reasoning(value)])[0]!)).toBe("x")
    }
  })

  test("does not flash unfinished prefixes or permanently hide completed genuine text", () => {
    const unfinished = { ...reasoning("No reasoning ava"), time: { start: 1 } } as Part
    const completed = { ...reasoning("No"), time: { start: 1, end: 2 } } as Part
    const substantive = { ...reasoning("No reasoning available. This is actually a discussion."), time: { start: 1 } } as Part
    expect(partText(projectWorkingAssistantParts([unfinished])[0]!)).toBe("")
    expect(partText(projectWorkingAssistantParts([completed])[0]!)).toBe("x")
    expect(partText(projectWorkingAssistantParts([substantive])[0]!)).toBe("x")
  })

  test("ordinary text with the same phrase is not suppressed", () => {
    const text = { id: "answer", type: "text", text: "No reasoning available." } as Part
    expect(partText(projectWorkingAssistantParts([text])[0]!)).toBe("x")
  })
})
