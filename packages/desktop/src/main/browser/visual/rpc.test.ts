import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserDispatchContext } from "../contracts"
import { VisualObservationCoordinator } from "./coordinator"
import { decodeVisualRpcWireRequest, runVisualRpcWire } from "./rpc"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("wire codec base64 is strict and round-trips chunks without normal BrokerResponse", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-visual-rpc-"))
  roots.push(root)
  const context: BrowserDispatchContext = {
    requestId: "req",
    sessionId: "sess",
    windowId: "win",
    directory: root,
    messageId: "msg",
    timeoutMs: 30_000,
  }
  const coordinator = new VisualObservationCoordinator({ extensionChunkBytes: 4 })
  const grant = await coordinator.begin({
    context,
    lane: "extension",
    tabId: "1",
    operation: "capture",
    name: "panel",
    runId: "run1",
    environment: {},
  })
  const begin = await runVisualRpcWire(coordinator, {
    id: "rpc-1",
    capability: grant.capability,
    method: "baseline_write_begin",
    payload: { name: "panel", meta: { schemaVersion: 1, name: "panel" }, totalBytes: 4 },
  })
  expect(begin.ok).toBe(true)
  const writeId = (begin as { ok: true; result: { writeId: string } }).result.writeId
  const chunk = await runVisualRpcWire(coordinator, {
    id: "rpc-2",
    capability: grant.capability,
    method: "write_chunk",
    payload: { writeId, offset: 0, bytes: Buffer.from([1, 2, 3, 4]).toString("base64") },
  })
  expect(chunk).toMatchObject({ ok: true, id: "rpc-2", result: { offset: 4 } })
  await runVisualRpcWire(coordinator, {
    id: "rpc-3",
    capability: grant.capability,
    method: "write_commit",
    payload: { writeId },
  })
  await coordinator.abort(grant.capability)
})

test("wire decoder rejects non-canonical or malformed base64", () => {
  expect(() =>
    decodeVisualRpcWireRequest({
      id: "1",
      capability: "cap",
      method: "write_chunk",
      payload: { writeId: "w", offset: 0, bytes: "%%%=" },
    }),
  ).toThrow()
})
