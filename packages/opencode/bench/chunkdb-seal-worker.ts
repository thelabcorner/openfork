/**
 * ChunkDB sealer worker — compresses a batch of raw event.data rows.
 * Runs in a worker_thread (Bun + Node). Receives { msgId, rows: {id,data}[] },
 * returns { msgId, rows: framed[] } where each framed row is
 * { id, frame: Uint8Array, rawBytes, storedBytes }.
 */
import { parentPort } from "node:worker_threads"
import { compressText } from "@opencode-ai/core/database/json-codec"

parentPort!.on("message", (msg: { msgId: number; rows: { id: string; data: string }[] }) => {
  const framed: { id: string; frame: Uint8Array; rawBytes: number; storedBytes: number }[] = []
  for (const row of msg.rows) {
    const out = compressText(row.data)
    if (typeof out === "string") continue
    framed.push({ id: row.id, frame: out, rawBytes: row.data.length, storedBytes: out.byteLength })
  }
  parentPort!.postMessage(
    { msgId: msg.msgId, rows: framed },
    framed.map((f) => f.frame.buffer).filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer),
  )
})
