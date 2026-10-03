import { describe, expect } from "bun:test"
import { Effect } from "effect"
import type { Part } from "@opencode-ai/schema/session-v1"
import * as CurrentParts from "@opencode-ai/core/session/current-parts"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(CurrentParts.node))

describe("SessionCurrentParts", () => {
  it.effect("returns detached producer snapshots and protects a replacement from stale release", () =>
    Effect.gen(function* () {
      const current = yield* CurrentParts.Service
      const key = { sessionID: "ses_active", messageID: "msg_active", partID: "prt_active" }
      const producer = {
        id: key.partID,
        sessionID: key.sessionID,
        messageID: key.messageID,
        type: "text",
        text: "prefix",
        time: { start: 1 },
      } as Extract<Part, { type: "text" }>
      const first = current.register({ ...key, snapshot: () => producer })

      const repair = current.snapshot(key.sessionID, [key.messageID])
      expect(repair).toEqual([producer])
      ;(repair[0] as Extract<Part, { type: "text" }>).text = "consumer mutation"
      expect(producer.text).toBe("prefix")

      producer.text = "updated prefix"
      const replacement = current.register({ ...key, snapshot: () => producer })
      current.release(key, first)
      expect(current.snapshot(key.sessionID, [key.messageID])).toMatchObject([{ text: "updated prefix" }])

      current.release(key, replacement)
      expect(current.snapshot(key.sessionID, [key.messageID])).toEqual([])
    }),
  )
})
