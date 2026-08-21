/**
 * Epoch-3 worker-thread decompressor. Runs the DECOMPRESS half of
 * `decodeValueBytesObject` (frame decode + CRC verify) off the main thread so
 * the read path stays free for other queries while a jumbo payload (or a wide
 * batch of references) decompresses in parallel. The worker imports the SAME
 * `decodeValueBytesRaw` as the sync path, so framing/CRC/codec behavior is
 * identical and byte-exact rehydration holds.
 *
 * The worker sends ONLY the raw bytes (transferred, zero-copy) — the parsed
 * object is built on the main thread via JSON.parse. Structured-cloning a large
 * parsed object across the worker boundary is the dominant cost of a pooled
 * decode (the main thread deserializes it serially), so it is deliberately
 * avoided.
 *
 * Message in:  { id, bytes }                       — an event_value.bytes frame
 * Message out: { id, raw }                         — raw UTF-8 bytes (transferred)
 */
import { parentPort } from "node:worker_threads"
import { decodeValueBytesRaw } from "./json-codec"

const port = parentPort
if (!port) throw new Error("decompress-worker must run inside a Worker")

port.on("message", (msg: { id: number; bytes: Uint8Array }) => {
  const raw = decodeValueBytesRaw(msg.bytes)
  port.postMessage({ id: msg.id, raw }, [raw.buffer as ArrayBuffer])
})
