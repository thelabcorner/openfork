import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable, EventSequenceTable } from "@opencode-ai/core/event/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { V1CurrentEventAudit } from "@opencode-ai/core/session/v1-current-event-audit"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
))
const sid = SessionSchema.ID.make("ses_event_shadow_audit")

describe("V1 vs current durable event-level lowering audit", () => {
  it.effect("distinguishes exact versioned event types without reading payloads or guessing gap completeness", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(EventSequenceTable).values({ aggregate_id: sid, seq: 12 }).run()
      const insert = (seq: number, type: string) =>
        db.insert(EventTable).values({
          id: EventV2.ID.make(`evt_shadow_${seq}`),
          aggregate_id: sid, seq, type,
          data: { raw: "payload-data-must-not-be-replayed" } as never,
        }).run()
      yield* insert(1, EventV2.versionedType(SessionV1.Event.Created.type, 1))
      yield* insert(3, EventV2.versionedType(SessionV1.Event.MessageUpdated.type, 1))
      yield* insert(5, EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1))
      yield* insert(7, EventV2.versionedType(SessionEvent.Tool.Called.type, 1))
      yield* insert(9, "message.part.updated.999")

      const first = yield* V1CurrentEventAudit.page(db, { sessionID: sid, limit: 2 })
      expect(first).toMatchObject({
        more: true, afterSeq: 3, cutoverSafe: false, eventSequenceHead: 12,
        counts: { legacy: 2, current: 0, unknown: 0, legacyTranscriptMutations: 1 },
      })
      expect(first.items.map((row) => row.seq)).toEqual([1, 3])
      const second = yield* V1CurrentEventAudit.page(db, {
        sessionID: sid, afterSeq: first.afterSeq, limit: 2,
      })
      expect(second).toMatchObject({
        more: true, afterSeq: 7,
        counts: { legacy: 1, current: 1, unknown: 0, legacyTranscriptMutations: 1 },
      })
      const last = yield* V1CurrentEventAudit.page(db, {
        sessionID: sid, afterSeq: second.afterSeq, limit: 2,
      })
      expect(last).toMatchObject({
        more: false, counts: { legacy: 0, current: 0, unknown: 1, legacyTranscriptMutations: 0 },
      })
      expect(last.items[0]).toMatchObject({
        source: "unknown", requiresReplay: true,
        category: "unknown-version-or-event",
      })
      expect(V1CurrentEventAudit.classify(
        EventV2.versionedType(SessionV1.Event.PartRemoved.type, 1),
      )).toMatchObject({
        source: "legacy", requiresReplay: true, category: "transcript-mutation",
      })
      expect(first.fingerprint).not.toEqual(second.fingerprint)
    }),
  )
})
