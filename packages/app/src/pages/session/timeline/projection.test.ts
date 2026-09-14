import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import type { PartGroup } from "@opencode-ai/session-ui/message-part"
import { reuseTimelineRows } from "./row-reconciliation"
import { TimelineRow } from "./timeline-row"
import { projectWorkingAssistantParts, workingAssistantPartsEqual } from "./working-part-structure"

const context = (key: string, partIDs: string[], userMessageID = "user-1") =>
  new TimelineRow.AssistantPart({
    userMessageID,
    group: {
      key,
      type: "context",
      refs: partIDs.map((partID) => ({ messageID: "assistant-1", partID })),
    } satisfies PartGroup,
    previousAssistantPart: false,
  })

const user = (userMessageID = "user-1") => new TimelineRow.UserMessage({ userMessageID, anchor: true })
const keys = (rows: TimelineRow.TimelineRow[]) => rows.map(TimelineRow.key)

describe("reuseTimelineRows", () => {
  test.each([
    {
      name: "reuses an unchanged context group",
      previous: [context("context:a", ["a", "b"])],
      rows: [context("context:a", ["a", "b"])],
      expected: ["assistant-part:user-1:context:a"],
      reused: [[0, 0]],
    },
    {
      name: "preserves the group key when a member is appended",
      previous: [context("context:a", ["a"])],
      rows: [context("context:a", ["a", "b"])],
      expected: ["assistant-part:user-1:context:a"],
      reused: [],
    },
    {
      name: "preserves the group key when the first member is removed",
      previous: [context("context:a", ["a", "b"])],
      rows: [context("context:b", ["b"])],
      expected: ["assistant-part:user-1:context:a"],
      reused: [],
    },
    {
      name: "lets only the natural owner retain an old key after a split",
      previous: [context("context:a", ["a", "b"])],
      rows: [context("context:a", ["a"]), context("context:b", ["b"])],
      expected: ["assistant-part:user-1:context:a", "assistant-part:user-1:context:b"],
      reused: [],
    },
    {
      name: "chooses the earliest prior key when groups merge",
      previous: [context("context:a", ["a"]), context("context:b", ["b"])],
      rows: [context("context:b", ["b", "a"])],
      expected: ["assistant-part:user-1:context:a"],
      reused: [],
    },
    {
      name: "reserves an old key for its natural owner when two new groups compete",
      previous: [context("context:a", ["a", "b"])],
      rows: [context("context:b", ["b"]), context("context:a", ["a"])],
      expected: ["assistant-part:user-1:context:b", "assistant-part:user-1:context:a"],
      reused: [],
    },
    {
      name: "does not reuse context identity across user messages",
      previous: [context("context:a", ["a", "b"], "user-1")],
      rows: [context("context:b", ["b"], "user-2")],
      expected: ["assistant-part:user-2:context:b"],
      reused: [],
    },
    {
      name: "reuses an unaffected ordinary row",
      previous: [user()],
      rows: [user()],
      expected: ["user-message:user-1"],
      reused: [[0, 0]],
    },
    {
      name: "does not create accidental key collisions",
      previous: [context("context:a", ["a", "b", "c"])],
      rows: [context("context:b", ["b"]), context("context:a", ["a"]), context("context:c", ["c"])],
      expected: [
        "assistant-part:user-1:context:b",
        "assistant-part:user-1:context:a",
        "assistant-part:user-1:context:c",
      ],
      reused: [],
    },
  ])("$name", ({ previous, rows, expected, reused }) => {
    const result = reuseTimelineRows([...previous], [...rows])

    expect(keys(result)).toEqual([...expected])
    expect(new Set(keys(result)).size).toBe(result.length)
    reused.forEach(([resultIndex, previousIndex]) => expect(result[resultIndex]).toBe(previous[previousIndex]))
  })
})

describe("working assistant structural projection", () => {
  const text = (value: string) => ({ id: "text", type: "text", text: value } as Part)
  const reasoning = (value: string) => ({ id: "reasoning", type: "reasoning", text: value } as Part)
  const tool = (name: string, status: string) =>
    ({ id: `${name}-tool`, type: "tool", tool: name, state: { status } } as unknown as Part)

  test("ignores append-only text and reasoning growth after content becomes visible", () => {
    const before = projectWorkingAssistantParts([text("hello"), reasoning("# Plan")])
    const after = projectWorkingAssistantParts([
      text("hello and another hundred streamed tokens"),
      reasoning("# Plan\n\nA much longer reasoning body"),
    ])
    expect(workingAssistantPartsEqual(before, after)).toBe(true)
  })

  test("detects the first visible character because it creates a renderable row", () => {
    const before = projectWorkingAssistantParts([text("   ")])
    const after = projectWorkingAssistantParts([text("answer")])
    expect(workingAssistantPartsEqual(before, after)).toBe(false)
  })

  test("ignores ordinary tool state churn but tracks question hidden-to-visible transition", () => {
    const readRunning = projectWorkingAssistantParts([tool("read", "running")])
    const readCompleted = projectWorkingAssistantParts([tool("read", "completed")])
    expect(workingAssistantPartsEqual(readRunning, readCompleted)).toBe(true)

    const questionPending = projectWorkingAssistantParts([tool("question", "pending")])
    const questionRunning = projectWorkingAssistantParts([tool("question", "running")])
    const questionCompleted = projectWorkingAssistantParts([tool("question", "completed")])
    expect(workingAssistantPartsEqual(questionPending, questionRunning)).toBe(true)
    expect(workingAssistantPartsEqual(questionPending, questionCompleted)).toBe(false)
  })

  test("tracks part identity/order and tool kind because both affect grouping", () => {
    const left = projectWorkingAssistantParts([tool("read", "completed"), text("x")])
    const reordered = projectWorkingAssistantParts([text("x"), tool("read", "completed")])
    const renamed = projectWorkingAssistantParts([tool("find", "completed"), text("x")])
    expect(workingAssistantPartsEqual(left, reordered)).toBe(false)
    expect(workingAssistantPartsEqual(left, renamed)).toBe(false)
  })
})
