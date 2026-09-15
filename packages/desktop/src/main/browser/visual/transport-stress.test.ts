import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserDispatchContext } from "../contracts"
import { VisualObservationCoordinator } from "./coordinator"
import { runVisualRpcWire, VISUAL_RPC_MAX_JSON_BYTES, type VisualRpcResponse } from "./rpc"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const environment = { engineMajor: 140, appearance: "dark" as const, snapeyeVersion: "0.4.0", snapdomVersion: "3.0.0" }
const context = (directory: string, requestId: string): BrowserDispatchContext => ({
  requestId,
  sessionId: "ses-transport",
  windowId: "win-transport",
  workspaceId: "workspace-transport",
  directory,
  messageId: `msg-${requestId}`,
  toolCallId: `tool-${requestId}`,
  timeoutMs: 30_000,
})

test("extension artifact wire round-trips 1/8/32 MiB baselines in bounded chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-visual-transport-"))
  roots.push(root)
  const coordinator = new VisualObservationCoordinator()

  for (const sizeMiB of [1, 8, 32]) {
    const totalBytes = sizeMiB * 1024 * 1024
    const name = `stress-${sizeMiB}mib`
    const captureRun = `cap${sizeMiB}`
    const capture = await coordinator.begin({
      context: context(root, `capture-${sizeMiB}`),
      lane: "extension",
      tabId: "chrome-42",
      operation: "capture",
      name,
      runId: captureRun,
      environment,
    })

    const begun = await wire(coordinator, capture.capability, "baseline_write_begin", {
      name,
      meta: { schemaVersion: 1, name, image: { cssWidth: 1, cssHeight: 1, pixelWidth: 1, pixelHeight: 1, scale: 1 } },
      totalBytes,
    }) as { writeId: string; maxChunkBytes: number }
    expect(begun.maxChunkBytes).toBe(384 * 1024)

    const expected = createHash("sha256")
    let offset = 0
    while (offset < totalBytes) {
      const length = Math.min(begun.maxChunkBytes, totalBytes - offset)
      const bytes = deterministicBytes(offset, length)
      expected.update(bytes)
      const encoded = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")
      const request = {
        id: `write-${sizeMiB}-${offset}`,
        capability: capture.capability,
        method: "write_chunk",
        payload: { writeId: begun.writeId, offset, bytes: encoded },
      }
      expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(VISUAL_RPC_MAX_JSON_BYTES)
      const response = await runVisualRpcWire(coordinator, request)
      expect(response).toMatchObject({ ok: true, id: request.id, result: { offset: offset + length } })
      offset += length
    }
    await wire(coordinator, capture.capability, "write_commit", { writeId: begun.writeId })
    await wire(coordinator, capture.capability, "result_commit", {
      runId: captureRun,
      result: {
        schemaVersion: 1,
        protocolVersion: 1,
        runId: captureRun,
        status: "ok",
        operation: "capture",
        name,
      },
    })

    const diff = await coordinator.begin({
      context: context(root, `diff-${sizeMiB}`),
      lane: "extension",
      tabId: "chrome-42",
      operation: "diff",
      name,
      runId: `diff${sizeMiB}`,
      environment,
    })
    const opened = await wire(coordinator, diff.capability, "baseline_read_open", { name }) as {
      readId: string
      byteLength: number
      maxChunkBytes: number
    }
    expect(opened.byteLength).toBe(totalBytes)
    const actual = createHash("sha256")
    offset = 0
    while (offset < totalBytes) {
      const length = Math.min(opened.maxChunkBytes, totalBytes - offset)
      const response = await runVisualRpcWire(coordinator, {
        id: `read-${sizeMiB}-${offset}`,
        capability: diff.capability,
        method: "baseline_read_chunk",
        payload: { readId: opened.readId, offset, length },
      })
      expect(response.ok).toBe(true)
      expect(Buffer.byteLength(JSON.stringify({ type: "artifact_rpc_result", response }))).toBeLessThan(VISUAL_RPC_MAX_JSON_BYTES)
      const encoded = (response as Extract<VisualRpcResponse, { ok: true }>).result as { bytes: string; byteLength: number }
      const bytes = Buffer.from(encoded.bytes, "base64")
      expect(bytes.byteLength).toBe(encoded.byteLength)
      actual.update(bytes)
      offset += bytes.byteLength
    }
    await wire(coordinator, diff.capability, "baseline_read_close", { readId: opened.readId })
    expect(actual.digest("hex")).toBe(expected.digest("hex"))
    await coordinator.abort(diff.capability)
  }
}, 30_000)

async function wire(
  coordinator: VisualObservationCoordinator,
  capability: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const response = await runVisualRpcWire(coordinator, { id: `${method}-${Math.random()}`, capability, method, payload })
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
  return response.result
}

function deterministicBytes(offset: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index++) bytes[index] = ((offset + index) * 31 + 17) & 0xff
  return bytes
}
