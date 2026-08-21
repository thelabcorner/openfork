/**
 * Epoch-3 worker-thread compressor. Runs `compressText` off the main thread so
 * the sealer's main thread stays free for sha256 + SQL while workers burn CPU
 * on compression. The worker imports the SAME `compressText` as the sync path,
 * so framing/CRC/codec behavior is identical and byte-exact rehydration holds.
 *
 * Message in:  { id, json, codec?, level? }
 * Message out: { id, kind: "string", value }  — not worth framing (TEXT kept)
 *              { id, kind: "bytes", value }    — OCDB frame (buffer transferred)
 */
import { parentPort } from "node:worker_threads"
import { compressText } from "./json-codec"

const port = parentPort
if (!port) throw new Error("compress-worker must run inside a Worker")

port.on("message", (msg: { id: number; json: string; codec?: 1 | 2 | 3; level?: number }) => {
  const result = compressText(
    msg.json,
    msg.codec !== undefined ? { codec: msg.codec, level: msg.level } : undefined,
  )
  if (typeof result === "string") {
    port.postMessage({ id: msg.id, kind: "string", value: result })
    return
  }
  port.postMessage({ id: msg.id, kind: "bytes", value: result }, [result.buffer as ArrayBuffer])
})
