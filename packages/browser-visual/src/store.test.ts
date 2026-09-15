import { expect, test } from "bun:test"
import { RemoteVisualArtifactStore, type VisualRpcRequest, type VisualRpcResponse } from "./store"

test("remote baseline reads reconstruct an image/png Blob for SnapEye decoding", async () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
  const rpc = async (request: VisualRpcRequest): Promise<VisualRpcResponse> => {
    if (request.method === "baseline_read_open") {
      return {
        ok: true,
        id: request.id,
        result: { readId: "read-1", byteLength: png.byteLength, meta: { schemaVersion: 1 }, maxChunkBytes: 5 },
      }
    }
    if (request.method === "baseline_read_chunk") {
      const offset = Number(request.payload.offset)
      const length = Number(request.payload.length)
      return { ok: true, id: request.id, result: png.slice(offset, offset + length) }
    }
    if (request.method === "baseline_read_close") return { ok: true, id: request.id, result: null }
    return { ok: false, id: request.id, error: { code: "TEST_UNEXPECTED", message: request.method } }
  }

  const store = new RemoteVisualArtifactStore("capability", 8, rpc)
  const baseline = await store.readBaseline("fixture")
  expect(baseline).not.toBeNull()
  expect(baseline!.image).toBeInstanceOf(Blob)
  expect((baseline!.image as Blob).type).toBe("image/png")
  expect(Array.from(new Uint8Array(await (baseline!.image as Blob).arrayBuffer()))).toEqual(Array.from(png))
})

test("remote baseline reads fail when host close-time integrity verification fails", async () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  const rpc = async (request: VisualRpcRequest): Promise<VisualRpcResponse> => {
    if (request.method === "baseline_read_open") {
      return { ok: true, id: request.id, result: { readId: "read-1", byteLength: png.byteLength, meta: null, maxChunkBytes: 4 } }
    }
    if (request.method === "baseline_read_chunk") {
      const offset = Number(request.payload.offset)
      const length = Number(request.payload.length)
      return { ok: true, id: request.id, result: png.slice(offset, offset + length) }
    }
    if (request.method === "baseline_read_close") {
      return { ok: false, id: request.id, error: { code: "BASELINE_INTEGRITY", message: "digest mismatch" } }
    }
    return { ok: false, id: request.id, error: { code: "TEST_UNEXPECTED", message: request.method } }
  }

  const store = new RemoteVisualArtifactStore("capability", 8, rpc)
  await expect(store.readBaseline("fixture")).rejects.toMatchObject({ code: "BASELINE_INTEGRITY" })
})
