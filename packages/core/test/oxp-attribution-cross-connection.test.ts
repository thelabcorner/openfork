import { afterAll, describe, expect } from "bun:test"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { OxpActivity } from "@opencode-ai/core/oxp-activity/activity"
import { OxpInvocationTable } from "@opencode-ai/core/oxp-activity/sql"
import { OxpAttribution } from "@opencode-ai/core/oxp-attribution/attribution"
import { OxpAttributionRevision } from "@opencode-ai/core/oxp-attribution/revision"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const tmp = await tmpdir()
const file = path.join(tmp.path, "oxp-attribution-cross-connection.sqlite")
const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, OxpActivity.node, OxpAttribution.node]),
  [[Database.node, Database.layerFromPath(file)]],
))

afterAll(async () => { await tmp[Symbol.asyncDispose]().catch(() => {}) })

describe("OXP attribution cross-connection correctness", () => {
  it.live("rebuilds global evidence after a foreign SQLite update and delete with no local revision", Effect.gen(function* () {
    const activity = yield* OxpActivity.Service
    const attribution = yield* OxpAttribution.Service
    const started = yield* activity.begin({
      correlation: { scheme: "openai/session", digest: "cross-process-oxp", scope: "conversation" },
      hostRunID: "cross-process-oxp", plane: "augmentation", tool: "read", startedAt: 90_000,
      contextRequest: { chars: 113, source: "observed_boundary", schema: "oxp-boundary-primary-text/v1" },
    })
    yield* activity.settle({
      invocationID: started.invocationID, status: "success", completedAt: 90_100,
      contextResult: { chars: 211, source: "observed_boundary", schema: "oxp-boundary-primary-text/v1" },
    })
    const before = yield* attribution.snapshot()
    expect(before.totals.resultChars).toBe(211)
    const localRevision = OxpAttributionRevision.current()

    // Mimics a second sidecar/backfill connection: no OXP producer event and
    // no change to the process-local journal. SQLite data_version must win.
    yield* Database.withBackfillDb(file, (conn) => conn
      .update(OxpInvocationTable)
      .set({ context_result_chars: 637 })
      .where(eq(OxpInvocationTable.id, started.invocationID))
      .run().pipe(Effect.orDie)).pipe(Effect.orDie)
    expect(OxpAttributionRevision.current()).toBe(localRevision)
    const updated = yield* attribution.snapshot()
    expect(updated.totals.resultChars).toBe(637)
    expect(updated.totals.calls).toBe(1)

    yield* Database.withBackfillDb(file, (conn) => conn
      .delete(OxpInvocationTable)
      .where(eq(OxpInvocationTable.id, started.invocationID))
      .run().pipe(Effect.orDie)).pipe(Effect.orDie)
    const removed = yield* attribution.snapshot()
    expect(removed.totals.calls).toBe(0)
    expect(removed.coverage.complete).toBe(true)
  }))
})