/**
 * Disposable SQLite microbenchmark: three Context predicate indexes vs writer
 * insert cost. Does not use or modify the running OpenFork database.
 *
 * bun script/benchmark-context-probe-index.ts 5000
 */
import { Database } from "bun:sqlite"

const count = Math.max(100, Math.min(20000, Number(process.argv[2] ?? 5000) || 5000))
const partTextCharacters = Math.max(32, Math.min(131072, Number(process.argv[3] ?? 512) || 512))
const rounds = 5
type Mode = "control" | "summaryOnly" | "messageProbes" | "indexed" | "producerScalar"
const out: Record<Mode, { writes: number[]; probes: number[] }> = {
  control: { writes: [], probes: [] },
  summaryOnly: { writes: [], probes: [] },
  messageProbes: { writes: [], probes: [] },
  indexed: { writes: [], probes: [] },
  producerScalar: { writes: [], probes: [] },
}
const payloads = Array.from({ length: count }, (_, i) => ({
  messageID: "msg_context_sql_bench_" + i.toString().padStart(6, "0"),
  text: JSON.stringify({ role: i % 4 ? "user" : "assistant", summary: false,
    text: "x".repeat(120), userMetadata: i }),
  part: JSON.stringify({ type: "text", text: "y".repeat(partTextCharacters), metadata: {} }),
}))
function run(mode: Mode) {
  const db = new Database(":memory:")
  try {
    db.exec("CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, context_summary INTEGER NOT NULL DEFAULT 0, context_opaque INTEGER NOT NULL DEFAULT 0)")
    db.exec("CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL, context_compaction INTEGER NOT NULL DEFAULT 0, context_opaque INTEGER NOT NULL DEFAULT 0)")
    db.exec("CREATE INDEX message_session_id_idx ON message(session_id)")
    db.exec("CREATE INDEX part_session_id_idx ON part(session_id)")
    if (mode === "producerScalar") {
      db.exec("CREATE INDEX message_session_summary_probe_idx ON message(session_id) WHERE context_summary=1")
      db.exec("CREATE INDEX message_session_opaque_probe_idx ON message(session_id) WHERE context_opaque=1")
      db.exec("CREATE INDEX part_session_opaque_context_probe_idx ON part(session_id) WHERE context_opaque=1")
    } else if (mode !== "control") {
      db.exec("CREATE INDEX message_session_summary_probe_idx ON message(session_id) WHERE json_extract(data, '$.summary') = 1")
    }
    if (mode === "messageProbes" || mode === "indexed") {
      db.exec("CREATE INDEX message_session_opaque_probe_idx ON message(session_id) WHERE json_type(data, '$.\"$cdbRef\"') IS NOT NULL")
    }
    if (mode === "indexed") {
      db.exec("CREATE INDEX part_session_opaque_context_probe_idx ON part(session_id) WHERE json_type(data, '$.\"$cdbRef\"') IS NOT NULL")
    }
    const insertMessage = db.query("INSERT INTO message (id,session_id,data,context_summary,context_opaque) VALUES (?,?,?,?,?)")
    const insertPart = db.query("INSERT INTO part (id,message_id,session_id,data,context_compaction,context_opaque) VALUES (?,?,?,?,?,?)")
    const start = performance.now()
    db.transaction(() => {
      for (const row of payloads) {
        insertMessage.run(row.messageID, "ses_bench", row.text, 0, 0)
        insertPart.run("prt_" + row.messageID, row.messageID, "ses_bench", row.part, 0, 0)
      }
    })()
    const writeTime = performance.now() - start

    const scalar = mode === "producerScalar"
    const probeMessage = db.query(scalar
      ? "SELECT id FROM message WHERE session_id=? AND context_summary=1 LIMIT 1"
      : "SELECT id FROM message WHERE session_id=? AND json_extract(data, '$.summary')=1 LIMIT 1")
    const probeOpaque = db.query(scalar
      ? "SELECT id FROM message WHERE session_id=? AND context_opaque=1 LIMIT 1"
      : "SELECT id FROM message WHERE session_id=? AND json_type(data, '$.\"$cdbRef\"') IS NOT NULL LIMIT 1")
    const probePart = db.query(scalar
      ? "SELECT id FROM part WHERE session_id=? AND context_opaque=1 LIMIT 1"
      : "SELECT id FROM part WHERE session_id=? AND json_type(data, '$.\"$cdbRef\"') IS NOT NULL LIMIT 1")
    const probeStart = performance.now()
    for (let i = 0; i < 20; i++) {
      if (probeMessage.get("ses_bench") || probeOpaque.get("ses_bench") || probePart.get("ses_bench"))
        throw Error("Unexpected positive Context guard")
    }
    const probeTime = (performance.now() - probeStart) / 20
    return { writeTime, probeTime }
  } finally { db.close() }
}
for (let i = 0; i < rounds; i++) {
  for (const mode of i % 2
    ? ["producerScalar", "indexed", "messageProbes", "summaryOnly", "control"] as const
    : ["control", "summaryOnly", "messageProbes", "indexed", "producerScalar"] as const) {
    const result = run(mode)
    out[mode].writes.push(result.writeTime)
    out[mode].probes.push(result.probeTime)
  }
}
const median = (arr: number[]) => [...arr].sort((a,b) => a-b)[Math.floor(arr.length/2)]!
const writeBefore = median(out.control.writes), writeAfter=median(out.indexed.writes)
const readBefore=median(out.control.probes), readAfter=median(out.indexed.probes)
const scalarWrites=median(out.producerScalar.writes), scalarReads=median(out.producerScalar.probes)
console.log(JSON.stringify({
  pairs: count, partTextCharacters, rounds,
  writeControlMedianMs: +writeBefore.toFixed(3), writeIndexedMedianMs: +writeAfter.toFixed(3),
  writerOverheadPercent: +((writeAfter/writeBefore-1)*100).toFixed(1),
  guardProbeControlMedianMs: +readBefore.toFixed(3), guardProbeIndexedMedianMs: +readAfter.toFixed(3),
  guardProbeSpeedup: +(readBefore/readAfter).toFixed(1),
  producerScalarWriteMedianMs: +scalarWrites.toFixed(3),
  producerScalarWriteOverheadVsControlPercent: +((scalarWrites/writeBefore-1)*100).toFixed(1),
  producerScalarWriteGainVsJsonIndexPercent: +((1-scalarWrites/writeAfter)*100).toFixed(1),
  producerScalarProbeMedianMs: +scalarReads.toFixed(3),
  samples:out,
},null,2))
