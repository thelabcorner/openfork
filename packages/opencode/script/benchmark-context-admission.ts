/**
 * Compare full V1 part hydration to content-free Context admission probes.
 * Runs ONLY on a disposable temporary SQLite database.
 *
 * bun script/benchmark-context-admission.ts 4
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { MessageV2 } from "../src/session/message-v2"
import { MessageID, SessionID } from "../src/session/schema"

const mb = Math.max(1, Math.min(32, Number(process.argv[2] ?? 4) || 4))
const folder = mkdtempSync(join(tmpdir(), "openfork-context-admission-"))
const file = join(folder, "context.db")
const sessionID = SessionID.make("ses_admission_benchmark")
const messageID = MessageID.make("msg_admission_benchmark")
const median = (numbers: number[]) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)]!
try {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`
      INSERT INTO project (id, worktree, name, sandboxes, time_created, time_updated)
      VALUES ('p_admission_benchmark', '/admission', 'admission', '[]', 1000, 1000)
    `)
    yield* db.run(sql`
      INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated)
      VALUES (${sessionID}, 'p_admission_benchmark', '/admission', 'admission', 'Admission', '1', 1000, 1000)
    `)
    yield* db.run(sql`
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (${messageID}, ${sessionID}, 1001, 1001,
        ${JSON.stringify({ id: messageID, sessionID, role: "assistant", time: { created: 1001 } })})
    `)
    const payload = "X".repeat(mb * 1024 * 1024)
    yield* db.run(sql`
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES ('prt_admission_benchmark', ${messageID}, ${sessionID}, 1002, 1002,
        ${JSON.stringify({ type: "tool", tool: "read", callID: "c1", state: { status: "completed", output: payload } })})
    `)

    const modes = {
      hydrated: () => MessageV2.get({ sessionID, messageID }),
      pinProbe: () => MessageV2.probeContextTargets({
        sessionID, messageIDs: [messageID], signatureMessageIDs: [], partIDs: [],
      }),
      excludeProbe: () => MessageV2.probeContextTargets({
        sessionID, messageIDs: [messageID], signatureMessageIDs: [messageID], partIDs: [],
      }),
    }
    const samples: Record<keyof typeof modes, number[]> = {
      hydrated: [], pinProbe: [], excludeProbe: [],
    }
    // Warm all code paths and ensure the probe preserves the unsigned fact.
    yield* modes.hydrated()
    yield* modes.pinProbe()
    const facts = yield* modes.excludeProbe()
    if (facts.messages.get(messageID)?.signedReasoning !== false) throw new Error("Unexpected reasoning signature")

    for (let i = 0; i < 7; i++) {
      const order = i % 2 ? ["pinProbe", "excludeProbe", "hydrated"] as const
        : ["hydrated", "excludeProbe", "pinProbe"] as const
      for (const mode of order) {
        const started = performance.now()
        yield* modes[mode]()
        samples[mode].push(performance.now() - started)
      }
    }
    const medians = Object.fromEntries(Object.entries(samples).map(([mode, values]) => [mode, median(values)]))
    return {
      outputMiB: mb,
      medianMs: Object.fromEntries(Object.entries(medians).map(([mode, ms]) => [mode, Number(ms.toFixed(3))])),
      pinSpeedup: Number((medians.hydrated! / medians.pinProbe!).toFixed(2)),
      exclusionSpeedup: Number((medians.hydrated! / medians.excludeProbe!).toFixed(2)),
      samples,
    }
  }).pipe(Effect.provide(Database.layerFromPath(file))))
  console.log(JSON.stringify(result, null, 2))
} finally {
  rmSync(folder, { recursive: true, force: true })
}
