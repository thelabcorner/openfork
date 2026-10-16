import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { hasUsableCompactionCheckpoint } from "../../src/session/compaction-checkpoint"
import { MessageV2 } from "../../src/session/message-v2"

type Fake = SessionV1.WithParts
const message = (id: string, role: "user" | "assistant", extras: object = {}, parts: object[] = []) =>
  ({ info: { id, role, ...extras }, parts }) as Fake

const olderUser = message("u0", "user", {}, [{ type: "text", text: "Do not modify the authorization rules." }])
const olderAssistant = message("a0", "assistant", { parentID: "u0", finish: "end_turn" }, [{ type: "text", text: "Working." }])
const compact = message("c0", "user", {}, [{ type: "compaction" }])
const nextUser = message("u1", "user", {}, [{ type: "text", text: "Continue." }])

const summary = (parts: object[], extra: object = {}) =>
  message("s0", "assistant", { parentID: "c0", summary: true, finish: "end_turn", ...extra }, parts)

const effective = (checkpoint: Fake) =>
  MessageV2.filterCompacted([nextUser, checkpoint, compact, olderAssistant, olderUser])
    .map((item) => String(item.info.id))

describe("V1 compaction checkpoint admission", () => {
  test("a completed blank summary cannot erase earlier user instructions", () => {
    const checkpoint = summary([{ type: "text", text: " \n\t " }])
    expect(hasUsableCompactionCheckpoint(checkpoint)).toBe(false)
    expect(effective(checkpoint)).toEqual(["u0", "a0", "c0", "s0", "u1"])
  })

  test("missing and non-text-only summary parts do not authorize truncation", () => {
    for (const parts of [[], [{ type: "reasoning", text: "internal" }], [{ type: "tool", tool: "bash" }]]) {
      const checkpoint = summary(parts)
      expect(hasUsableCompactionCheckpoint(checkpoint)).toBe(false)
      expect(effective(checkpoint)).toEqual(["u0", "a0", "c0", "s0", "u1"])
    }
  })

  test("ignored summary text, tool continuations, and media never truncate history", () => {
    for (const parts of [
      [{ type: "text", text: "invisible", ignored: true }],
      [{ type: "text", text: "summary" }, { type: "tool", tool: "write", state: { status: "completed" } }],
      [{ type: "text", text: "summary" }, { type: "file", mime: "image/png" }],
    ]) {
      const checkpoint = summary(parts)
      expect(hasUsableCompactionCheckpoint(checkpoint)).toBe(false)
      expect(effective(checkpoint)).toEqual(["u0", "a0", "c0", "s0", "u1"])
    }
  })

  test("failed, unfinished, and unmarked assistant turns cannot authorize truncation", () => {
    for (const extra of [
      { finish: undefined },
      { finish: "tool-calls" },
      { finish: "length" },
      { finish: "error" },
      { error: { name: "failed" } },
      { summary: false },
    ]) {
      const checkpoint = summary([{ type: "text", text: "Some summary" }], extra)
      expect(hasUsableCompactionCheckpoint(checkpoint)).toBe(false)
      expect(effective(checkpoint)).toEqual(["u0", "a0", "c0", "s0", "u1"])
    }
  })

  test("a valid historical or custom-format summary retains normal compaction semantics", () => {
    const checkpoint = summary([{ type: "text", text: "Remember user authorization rules." }])
    expect(hasUsableCompactionCheckpoint(checkpoint)).toBe(true)
    expect(effective(checkpoint)).toEqual(["c0", "s0", "u1"])
    expect(hasUsableCompactionCheckpoint(summary([{ type: "text", text: "Provider terminal success" }], {
      finish: "stop",
    }))).toBe(true)
  })

  test("a finished but unpromoted checkpoint never hides prior history, while legacy markers still work", () => {
    const checkpoint = summary([{ type: "text", text: "Important state." }])
    const pending = message("c0", "user", {}, [{ type: "compaction", pending: true }])
    const promoted = message("c0", "user", {}, [{ type: "compaction", pending: false }])
    const history = (marker: Fake) =>
      MessageV2.filterCompacted([nextUser, checkpoint, marker, olderAssistant, olderUser])
        .map((item) => String(item.info.id))
    expect(history(pending)).toEqual(["u0", "a0", "c0", "s0", "u1"])
    expect(history(promoted)).toEqual(["c0", "s0", "u1"])
    expect(history(compact)).toEqual(["c0", "s0", "u1"])
  })

  test("an interrupted checkpoint with a leftover tail pointer cannot reorder history", () => {
    const interrupted = message("c0", "user", {}, [{ type: "compaction", pending: true, tail_start_id: "a0" }])
    const history = MessageV2.filterCompacted([nextUser, summary([{ type: "text", text: "candidate" }]),
      interrupted, olderAssistant, olderUser])
    expect(history.map((item) => String(item.info.id))).toEqual(["u0", "a0", "c0", "s0", "u1"])
  })

  test("retry promotion selects the exact committed assistant and excludes stale checkpoint candidates", () => {
    const stale = summary([{ type: "text", text: "Stale attempt" }])
    const committed = message("s1", "assistant", {
      parentID: "c0",
      summary: true,
      finish: "stop",
    }, [{ type: "text", text: "Verified current checkpoint" }])
    const history = (checkpointID: string) => MessageV2.filterCompacted([
      nextUser,
      committed,
      stale,
      message("c0", "user", {}, [{
        type: "compaction",
        pending: false,
        checkpoint_message_id: checkpointID,
      }]),
      olderAssistant,
      olderUser,
    ]).map((item) => String(item.info.id))
    expect(history("s1")).toEqual(["c0", "s1", "u1"])
    // If a marker references a missing or invalid candidate, older history
    // must remain accessible rather than silently falling back to the stale one.
    expect(history("missing")).toEqual(["u0", "a0", "c0", "u1"])
  })

  test("an unrelated assistant summary never compacts another marker", () => {
    const checkpoint = message("s0", "assistant", { parentID: "unrelated", summary: true, finish: "end_turn" },
      [{ type: "text", text: "Another summary." }])
    expect(hasUsableCompactionCheckpoint(checkpoint)).toBe(true)
    expect(effective(checkpoint)).toEqual(["u0", "a0", "c0", "s0", "u1"])
  })

  test("twenty successive checkpoints preserve the last valid boundary and never promote partial results", () => {
    const immutable = "ANCHOR:AUTHORIZATION-BOUNDARY-DO-NOT-MODIFY"
    const chronological: Fake[] = [
      message("initial", "user", {}, [{ type: "text", text: immutable }]),
    ]
    let lastValid = -1
    for (let round = 0; round < 20; round++) {
      const userID = "u" + round
      const markerID = "c" + round
      chronological.push(
        message(userID, "user", {}, [{ type: "text", text: "Step " + round }]),
        message("a" + round, "assistant", { parentID: userID, finish: "end_turn" }, [
          { type: "text", text: "Observed step " + round },
        ]),
        message(markerID, "user", {}, [{ type: "compaction" }]),
      )
      const valid = round % 5 !== 4
      chronological.push(
        message("s" + round, "assistant", {
          parentID: markerID,
          summary: true,
          finish: valid ? "end_turn" : "length",
        }, [{ type: "text", text: immutable + " | checkpoint " + round }]),
      )
      if (valid) lastValid = round
      const effective = MessageV2.filterCompacted([...chronological].reverse())
      const boundary = chronological.findIndex((item) => item.info.id === "c" + lastValid)
      expect(effective.map((item) => item.info.id)).toEqual(chronological.slice(boundary).map((item) => item.info.id))
      expect(effective.some((item) =>
        item.parts.some((part) => part.type === "text" && part.text.includes(immutable)),
      )).toBe(true)
    }
  })
})