import type { ArtifactStore, SnapEyeArtifactData, SnapEyeResult, StoredBaseline } from "@zumer/snapeye/client"

export interface VisualRpcRequest {
  id: string
  capability: string
  method:
    | "baseline_read_open"
    | "baseline_read_chunk"
    | "baseline_read_close"
    | "baseline_write_begin"
    | "run_write_begin"
    | "write_chunk"
    | "write_commit"
    | "write_abort"
    | "result_commit"
  payload: Record<string, unknown>
}

export type VisualRpcResponse =
  | { ok: true; id: string; result: unknown }
  | { ok: false; id: string; error: { code: string; message: string } }

export type VisualRpc = (request: VisualRpcRequest) => Promise<VisualRpcResponse>

export class RemoteVisualStoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = "RemoteVisualStoreError"
  }
}

/** SnapEye ArtifactStore transported through OpenCode's scoped visual RPC. */
export class RemoteVisualArtifactStore implements ArtifactStore {
  lastCommittedResult: SnapEyeResult | null = null
  private sequence = 0

  constructor(
    private readonly capability: string,
    private readonly maxChunkBytes: number,
    private readonly rpc: VisualRpc,
  ) {
    if (!capability) throw new TypeError("Visual store requires a capability")
    if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1) throw new TypeError("Visual store maxChunkBytes must be positive")
  }

  async readBaseline(name: string): Promise<StoredBaseline | null> {
    const opened = await this.call("baseline_read_open", { name }) as {
      readId: string
      byteLength: number
      meta: StoredBaseline["meta"]
      maxChunkBytes?: number
    } | null
    if (!opened) return null
    const chunkBytes = Math.min(this.maxChunkBytes, opened.maxChunkBytes ?? this.maxChunkBytes)
    const image = new Uint8Array(opened.byteLength)
    let offset = 0
    let closeAttempted = false
    try {
      while (offset < image.byteLength) {
        const length = Math.min(chunkBytes, image.byteLength - offset)
        const value = await this.call("baseline_read_chunk", { readId: opened.readId, offset, length })
        const bytes = toRpcBytes(value)
        if (bytes.byteLength === 0 && length > 0) throw new RemoteVisualStoreError("VISUAL_SHORT_READ", "Visual baseline read ended early")
        image.set(bytes, offset)
        offset += bytes.byteLength
      }
      // For OpenCode-created baselines the host validates the committed digest
      // over the same bytes it just streamed. Close is therefore part of the
      // integrity barrier and must succeed before SnapEye can receive the Blob.
      closeAttempted = true
      await this.call("baseline_read_close", { readId: opened.readId })
      // SnapEye's browser runtime decodes a stored baseline with
      // createImageBitmap()/URL.createObjectURL(), both of which require a Blob
      // rather than an arbitrary byte view. Keep chunk reconstruction in a
      // Uint8Array for efficient transport, then cross the ArtifactStore seam as
      // an explicit image/png Blob.
      return { name, image: new Blob([image], { type: "image/png" }), meta: opened.meta }
    } finally {
      if (!closeAttempted) await this.call("baseline_read_close", { readId: opened.readId }).catch(() => undefined)
    }
  }

  async writeBaseline(name: string, baseline: StoredBaseline): Promise<void> {
    const source = binarySource(baseline.image)
    const begin = await this.call("baseline_write_begin", {
      name,
      meta: baseline.meta,
      totalBytes: source.byteLength,
    }) as { writeId: string; maxChunkBytes?: number }
    await this.streamWrite(begin.writeId, source, begin.maxChunkBytes)
  }

  async writeRunArtifact(runId: string, filename: string, data: SnapEyeArtifactData): Promise<void> {
    const source = artifactSource(data)
    const begin = await this.call("run_write_begin", {
      runId,
      filename,
      totalBytes: source.byteLength,
    }) as { writeId: string; maxChunkBytes?: number }
    await this.streamWrite(begin.writeId, source, begin.maxChunkBytes)
  }

  async commitResult(runId: string, result: SnapEyeResult): Promise<void> {
    this.lastCommittedResult = await this.call("result_commit", { runId, result }) as SnapEyeResult
  }

  private async streamWrite(writeId: string, source: ByteSource, remoteMax?: number): Promise<void> {
    const chunkBytes = Math.min(this.maxChunkBytes, remoteMax ?? this.maxChunkBytes)
    let offset = 0
    try {
      while (offset < source.byteLength) {
        const length = Math.min(chunkBytes, source.byteLength - offset)
        const bytes = await source.slice(offset, offset + length)
        const result = await this.call("write_chunk", { writeId, offset, bytes }) as { offset?: number }
        const next = result.offset
        if (next !== offset + bytes.byteLength) {
          throw new RemoteVisualStoreError("VISUAL_OFFSET_MISMATCH", `Host acknowledged offset ${String(next)}; expected ${offset + bytes.byteLength}`)
        }
        offset = next
      }
      await this.call("write_commit", { writeId })
    } catch (error) {
      await this.call("write_abort", { writeId }).catch(() => undefined)
      throw error
    }
  }

  private async call(method: VisualRpcRequest["method"], payload: Record<string, unknown>): Promise<unknown> {
    const id = `${Date.now().toString(36)}-${(++this.sequence).toString(36)}`
    const response = await this.rpc({ id, capability: this.capability, method, payload })
    if (!response.ok) throw new RemoteVisualStoreError(response.error.code, response.error.message)
    if (response.id !== id) throw new RemoteVisualStoreError("VISUAL_RPC_MISMATCH", `Visual RPC response id ${response.id} does not match ${id}`)
    return response.result
  }
}

interface ByteSource {
  byteLength: number
  slice(start: number, end: number): Promise<Uint8Array>
}

const binarySource = (value: StoredBaseline["image"]): ByteSource => {
  if (value instanceof Blob) return blobSource(value)
  if (value instanceof Uint8Array) return uint8Source(value)
  if (value instanceof ArrayBuffer) return uint8Source(new Uint8Array(value))
  throw new TypeError("Unsupported SnapEye baseline image type")
}

const artifactSource = (value: SnapEyeArtifactData): ByteSource => {
  if (typeof value === "string") return blobSource(new Blob([value], { type: "text/plain;charset=utf-8" }))
  return binarySource(value)
}

const blobSource = (blob: Blob): ByteSource => ({
  byteLength: blob.size,
  slice: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
})

const uint8Source = (bytes: Uint8Array): ByteSource => ({
  byteLength: bytes.byteLength,
  slice: async (start, end) => bytes.subarray(start, end),
})

const toRpcBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (value && typeof value === "object" && "bytes" in value && typeof (value as { bytes?: unknown }).bytes === "string") {
    const encoded = (value as { bytes: string }).bytes
    const ctor = Uint8Array as typeof Uint8Array & { fromBase64?: (value: string) => Uint8Array }
    if (typeof ctor.fromBase64 === "function") return ctor.fromBase64(encoded)
    const binary = atob(encoded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  }
  throw new RemoteVisualStoreError("VISUAL_INVALID_BYTES", "Visual RPC returned an invalid byte chunk")
}
