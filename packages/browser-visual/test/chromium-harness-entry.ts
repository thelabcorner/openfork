import { runVisualOperation } from "../src/runtime"
import type { SnapEyeBaseOperationOptions, SnapEyeDiffOptions } from "@zumer/snapeye/client"

type Baseline = { image: Uint8Array; meta: Record<string, unknown> | null }
type WriteTransfer = {
  kind: "baseline" | "run"
  totalBytes: number
  bytes: Uint8Array
  offset: number
  name?: string
  meta?: Record<string, unknown> | null
  runId?: string
  filename?: string
}

const baselines = new Map<string, Baseline>()
const reads = new Map<string, Uint8Array>()
const writes = new Map<string, WriteTransfer>()
const runArtifacts = new Map<string, Map<string, Uint8Array>>()
const results = new Map<string, unknown>()
let sequence = 0

const id = (prefix: string) => `${prefix}-${++sequence}`

const rpc = async (request: {
  id: string
  method: string
  payload: Record<string, unknown>
}) => {
  try {
    const payload = request.payload
    switch (request.method) {
      case "baseline_read_open": {
        const name = String(payload.name ?? "")
        const baseline = baselines.get(name)
        if (!baseline) return ok(request.id, null)
        const readId = id("read")
        reads.set(readId, baseline.image)
        return ok(request.id, {
          readId,
          byteLength: baseline.image.byteLength,
          meta: baseline.meta,
          maxChunkBytes: 128 * 1024,
        })
      }
      case "baseline_read_chunk": {
        const bytes = reads.get(String(payload.readId ?? ""))
        if (!bytes) throw new Error("unknown read")
        const offset = Number(payload.offset)
        const length = Number(payload.length)
        return ok(request.id, bytes.slice(offset, offset + length))
      }
      case "baseline_read_close":
        reads.delete(String(payload.readId ?? ""))
        return ok(request.id, null)
      case "baseline_write_begin": {
        const totalBytes = Number(payload.totalBytes)
        const writeId = id("write")
        writes.set(writeId, {
          kind: "baseline",
          totalBytes,
          bytes: new Uint8Array(totalBytes),
          offset: 0,
          name: String(payload.name ?? ""),
          meta: (payload.meta ?? null) as Record<string, unknown> | null,
        })
        return ok(request.id, { writeId, maxChunkBytes: 128 * 1024 })
      }
      case "run_write_begin": {
        const totalBytes = Number(payload.totalBytes)
        const writeId = id("write")
        writes.set(writeId, {
          kind: "run",
          totalBytes,
          bytes: new Uint8Array(totalBytes),
          offset: 0,
          runId: String(payload.runId ?? ""),
          filename: String(payload.filename ?? ""),
        })
        return ok(request.id, { writeId, maxChunkBytes: 128 * 1024 })
      }
      case "write_chunk": {
        const transfer = writes.get(String(payload.writeId ?? ""))
        if (!transfer) throw new Error("unknown write")
        const offset = Number(payload.offset)
        const bytes = payload.bytes
        if (!(bytes instanceof Uint8Array)) throw new Error("invalid bytes")
        if (offset !== transfer.offset || transfer.offset + bytes.byteLength > transfer.totalBytes) {
          throw new Error("invalid write offset")
        }
        transfer.bytes.set(bytes, transfer.offset)
        transfer.offset += bytes.byteLength
        return ok(request.id, { offset: transfer.offset })
      }
      case "write_commit": {
        const writeId = String(payload.writeId ?? "")
        const transfer = writes.get(writeId)
        if (!transfer) throw new Error("unknown write")
        if (transfer.offset !== transfer.totalBytes) throw new Error("short write")
        if (transfer.kind === "baseline") {
          baselines.set(transfer.name!, { image: transfer.bytes, meta: transfer.meta ?? null })
        } else {
          let artifacts = runArtifacts.get(transfer.runId!)
          if (!artifacts) runArtifacts.set(transfer.runId!, artifacts = new Map())
          artifacts.set(transfer.filename!, transfer.bytes)
        }
        writes.delete(writeId)
        return ok(request.id, null)
      }
      case "write_abort":
        writes.delete(String(payload.writeId ?? ""))
        return ok(request.id, null)
      case "result_commit": {
        const runId = String(payload.runId ?? "")
        results.set(runId, payload.result)
        return ok(request.id, payload.result)
      }
      default:
        throw new Error(`unknown RPC ${request.method}`)
    }
  } catch (error) {
    return {
      ok: false as const,
      id: request.id,
      error: { code: "HARNESS_RPC", message: error instanceof Error ? error.message : String(error) },
    }
  }
}

const api = {
  reset() {
    baselines.clear()
    reads.clear()
    writes.clear()
    runArtifacts.clear()
    results.clear()
  },
  importBaseline(name: string, baseline: { image: string; meta: Record<string, unknown> | null }) {
    baselines.set(name, { image: fromBase64(baseline.image), meta: baseline.meta })
  },
  async capture(
    name: string,
    target?: string,
    redaction?: { blocks?: string[]; attributes?: Array<{ selector: string; names: string[] }> },
    options?: SnapEyeBaseOperationOptions,
  ) {
    const runId = id("capture")
    const result = await runVisualOperation({
      operation: "capture",
      name,
      runId,
      capability: "harness",
      maxChunkBytes: 128 * 1024,
      rpc,
      target,
      redaction,
      options,
    })
    const baseline = baselines.get(name)
    if (!baseline) throw new Error("capture did not write baseline")
    return {
      result,
      baseline: { image: toBase64(baseline.image), meta: baseline.meta },
      artifactNames: [...(runArtifacts.get(runId)?.keys() ?? [])],
    }
  },
  async diff(
    name: string,
    target?: string,
    redaction?: { blocks?: string[]; attributes?: Array<{ selector: string; names: string[] }> },
    options?: SnapEyeDiffOptions,
  ) {
    const runId = id("diff")
    const result = await runVisualOperation({
      operation: "diff",
      name,
      runId,
      capability: "harness",
      maxChunkBytes: 128 * 1024,
      rpc,
      target,
      redaction,
      options,
    })
    return { result, artifactNames: [...(runArtifacts.get(runId)?.keys() ?? [])] }
  },
  async record(
    name: string,
    target?: string,
    options?: { duration?: number; fps?: number; format?: "gif" | "video" | "both"; scale?: number },
    redaction?: { blocks?: string[]; attributes?: Array<{ selector: string; names: string[] }> },
  ) {
    const runId = id("record")
    const result = await runVisualOperation({
      operation: "record",
      name,
      runId,
      capability: "harness",
      maxChunkBytes: 128 * 1024,
      rpc,
      target,
      redaction,
      options,
    })
    const artifacts = runArtifacts.get(runId)
    const gif = artifacts?.get("recording.gif")
    return {
      result,
      artifactNames: [...(artifacts?.keys() ?? [])],
      gifDecode: gif ? await decodeGifArtifact(gif) : null,
    }
  },
  async recordAbort(
    name: string,
    target?: string,
    options?: { duration?: number; fps?: number; format?: "gif" | "video" | "both"; scale?: number },
    abortAfterMs = 150,
  ) {
    const runId = id("record-abort")
    const controller = new AbortController()
    const started = performance.now()
    const timer = setTimeout(() => controller.abort(), abortAfterMs)
    let outcome: "resolved" | "rejected" = "resolved"
    let error: string | null = null
    try {
      await runVisualOperation({
        operation: "record",
        name,
        runId,
        capability: "harness",
        maxChunkBytes: 128 * 1024,
        rpc,
        signal: controller.signal,
        target,
        options,
      })
    } catch (caught) {
      outcome = "rejected"
      error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
    } finally {
      clearTimeout(timer)
    }
    return {
      outcome,
      error,
      elapsedMs: Math.round(performance.now() - started),
      terminalCommitted: results.has(runId),
      artifactNames: [...(runArtifacts.get(runId)?.keys() ?? [])],
    }
  },
}

async function decodeGifArtifact(bytes: Uint8Array): Promise<{
  frameCount: number
  decodedFrames: number
  width: number
  height: number
}> {
  const ImageDecoderImpl = (globalThis as typeof globalThis & {
    ImageDecoder?: new (input: { data: Uint8Array; type: string }) => {
      tracks: {
        ready: Promise<void>
        selectedTrack?: { frameCount?: number } | null
      }
      decode(input: { frameIndex: number }): Promise<{ image: { displayWidth: number; displayHeight: number; close(): void } }>
      close(): void
    }
  }).ImageDecoder
  if (typeof ImageDecoderImpl !== "function") throw new Error("Chromium ImageDecoder is unavailable for GIF certification")

  const decoder = new ImageDecoderImpl({ data: bytes, type: "image/gif" })
  try {
    await decoder.tracks.ready
    const frameCount = Number(decoder.tracks.selectedTrack?.frameCount ?? 0)
    if (!Number.isSafeInteger(frameCount) || frameCount < 1) {
      throw new Error(`Chromium ImageDecoder reported invalid GIF frame count ${frameCount}`)
    }
    let decodedFrames = 0
    let width = 0
    let height = 0
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      const decoded = await decoder.decode({ frameIndex })
      try {
        if (!width) width = decoded.image.displayWidth
        if (!height) height = decoded.image.displayHeight
        if (decoded.image.displayWidth !== width || decoded.image.displayHeight !== height) {
          throw new Error("Chromium decoded inconsistent GIF frame dimensions")
        }
        decodedFrames++
      } finally {
        decoded.image.close()
      }
    }
    return { frameCount, decodedFrames, width, height }
  } finally {
    decoder.close()
  }
}

;(globalThis as typeof globalThis & { __opencodeSnapEyeHarness?: typeof api }).__opencodeSnapEyeHarness = api

function ok(id: string, result: unknown) {
  return { ok: true as const, id, result }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  const block = 0x8000
  for (let offset = 0; offset < bytes.byteLength; offset += block) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + block)))
  }
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}
