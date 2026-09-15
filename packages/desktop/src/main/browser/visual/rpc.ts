import { VisualArtifactError, isPlainObject, type SnapEyeResult } from "./protocol"
import { VisualCapabilityError, VisualObservationCoordinator } from "./coordinator"

export const VISUAL_RPC_PATH = "/v1/browser/visual/rpc"
export const VISUAL_RPC_MAX_JSON_BYTES = 1024 * 1024

export type VisualRpcMethod =
  | "baseline_read_open"
  | "baseline_read_chunk"
  | "baseline_read_close"
  | "baseline_write_begin"
  | "run_write_begin"
  | "write_chunk"
  | "write_commit"
  | "write_abort"
  | "result_commit"

export interface VisualRpcRequest {
  id: string
  capability: string
  method: VisualRpcMethod
  payload: Record<string, unknown>
}

export type VisualRpcResponse =
  | { ok: true; id: string; result: unknown }
  | { ok: false; id: string; error: { code: string; message: string } }

/** Transport-neutral RPC dispatch. Electron can pass Uint8Array directly. */
export const dispatchVisualRpc = async (
  coordinator: VisualObservationCoordinator,
  request: VisualRpcRequest,
): Promise<unknown> => {
  const payload = request.payload
  switch (request.method) {
    case "baseline_read_open":
      return coordinator.baselineReadOpen(request.capability, requiredString(payload.name, "name"))
    case "baseline_read_chunk":
      return coordinator.baselineReadChunk(
        request.capability,
        requiredString(payload.readId, "readId"),
        requiredNonNegativeInt(payload.offset, "offset"),
        requiredNonNegativeInt(payload.length, "length"),
      )
    case "baseline_read_close":
      await coordinator.baselineReadClose(request.capability, requiredString(payload.readId, "readId"))
      return { closed: true }
    case "baseline_write_begin":
      return coordinator.baselineWriteBegin(
        request.capability,
        requiredString(payload.name, "name"),
        optionalPlainObject(payload.meta, "meta"),
        requiredNonNegativeInt(payload.totalBytes, "totalBytes"),
      )
    case "run_write_begin":
      return coordinator.runWriteBegin(
        request.capability,
        requiredString(payload.runId, "runId"),
        requiredString(payload.filename, "filename"),
        requiredNonNegativeInt(payload.totalBytes, "totalBytes"),
      )
    case "write_chunk":
      return coordinator.writeChunk(
        request.capability,
        requiredString(payload.writeId, "writeId"),
        requiredNonNegativeInt(payload.offset, "offset"),
        requiredBytes(payload.bytes),
      )
    case "write_commit":
      await coordinator.writeCommit(request.capability, requiredString(payload.writeId, "writeId"))
      return { committed: true }
    case "write_abort":
      await coordinator.writeAbort(request.capability, requiredString(payload.writeId, "writeId"))
      return { aborted: true }
    case "result_commit":
      return coordinator.resultCommit(
        request.capability,
        requiredString(payload.runId, "runId"),
        requiredPlainObject(payload.result, "result") as unknown as SnapEyeResult,
      )
  }
}

/** Decode the JSON/native wire representation. Only byte chunks use base64. */
export const decodeVisualRpcWireRequest = (value: unknown): VisualRpcRequest => {
  if (!isPlainObject(value)) throw invalid("Visual RPC request must be an object")
  const id = requiredString(value.id, "id")
  const capability = requiredString(value.capability, "capability")
  const method = value.method
  if (!isVisualRpcMethod(method)) throw invalid(`Unknown visual RPC method: ${String(method)}`)
  const payload = requiredPlainObject(value.payload, "payload")
  if (method === "write_chunk") {
    const encoded = requiredString(payload.bytes, "bytes")
    if (!isCanonicalBase64(encoded)) throw invalid("Visual write chunk is not valid base64")
    return { id, capability, method, payload: { ...payload, bytes: Buffer.from(encoded, "base64") } }
  }
  return { id, capability, method, payload }
}

/** Encode raw bytes for the Chrome/native JSON carrier without touching normal BrokerResponse. */
export const encodeVisualRpcWireResult = (result: unknown): unknown => {
  if (result instanceof Uint8Array) {
    return { bytes: Buffer.from(result.buffer, result.byteOffset, result.byteLength).toString("base64"), byteLength: result.byteLength }
  }
  return result
}

export const runVisualRpcWire = async (
  coordinator: VisualObservationCoordinator,
  value: unknown,
): Promise<VisualRpcResponse> => {
  let id = ""
  try {
    const request = decodeVisualRpcWireRequest(value)
    id = request.id
    const result = await dispatchVisualRpc(coordinator, request)
    return { ok: true, id, result: encodeVisualRpcWireResult(result) }
  } catch (error) {
    return { ok: false, id, error: visualRpcError(error) }
  }
}

/** Electron guest transport: preserve Uint8Array through structured clone. */
export const runVisualRpcLocal = async (
  coordinator: VisualObservationCoordinator,
  value: unknown,
): Promise<VisualRpcResponse> => {
  let id = ""
  try {
    if (!isVisualRpcRequest(value)) throw invalid("Visual RPC request must be a valid local request")
    id = value.id
    const result = await dispatchVisualRpc(coordinator, value)
    return { ok: true, id, result }
  } catch (error) {
    return { ok: false, id, error: visualRpcError(error) }
  }
}

export const isVisualRpcRequest = (value: unknown): value is VisualRpcRequest => {
  if (!isPlainObject(value)) return false
  if (typeof value.id !== "string" || value.id.length === 0) return false
  if (typeof value.capability !== "string" || value.capability.length === 0) return false
  if (!isVisualRpcMethod(value.method)) return false
  return isPlainObject(value.payload)
}

const METHODS = new Set<VisualRpcMethod>([
  "baseline_read_open",
  "baseline_read_chunk",
  "baseline_read_close",
  "baseline_write_begin",
  "run_write_begin",
  "write_chunk",
  "write_commit",
  "write_abort",
  "result_commit",
])

const isVisualRpcMethod = (value: unknown): value is VisualRpcMethod =>
  typeof value === "string" && METHODS.has(value as VisualRpcMethod)

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) throw invalid(`${field} must be a non-empty string`)
  return value
}

const requiredNonNegativeInt = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(`${field} must be a non-negative safe integer`)
  return value as number
}

const requiredPlainObject = (value: unknown, field: string): Record<string, unknown> => {
  if (!isPlainObject(value)) throw invalid(`${field} must be an object`)
  return value
}

const optionalPlainObject = (value: unknown, field: string): Record<string, unknown> | null => {
  if (value === null || value === undefined) return null
  return requiredPlainObject(value, field)
}

const requiredBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw invalid("bytes must be Uint8Array/ArrayBuffer on the local transport")
}

const isCanonicalBase64 = (value: string): boolean => {
  if (value.length === 0) return true
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false
  try {
    return Buffer.from(value, "base64").toString("base64") === value
  } catch {
    return false
  }
}

const invalid = (message: string) => new VisualCapabilityError("VISUAL_TRANSFER_INVALID", message)

const visualRpcError = (error: unknown): { code: string; message: string } => {
  if (error instanceof VisualCapabilityError || error instanceof VisualArtifactError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof Error) return { code: "VISUAL_RPC_FAILED", message: error.message }
  return { code: "VISUAL_RPC_FAILED", message: "Visual artifact RPC failed" }
}
