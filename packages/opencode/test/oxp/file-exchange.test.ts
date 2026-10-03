import { afterAll, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OxpConfig } from "@/oxp/config"
import { OxpError } from "@/oxp/error"
import { OxpFileExchange } from "@/oxp/file-exchange"
import { OxpResult } from "@/oxp/result"
import { OxpRoot } from "@/oxp/root"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-file-exchange-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const layer = AppNodeBuilder.build(
  LayerNode.group([OxpFileExchange.node, OxpConfig.node, OxpRoot.node]),
  [[Global.node, Global.layerWith({ config: configDir, state: stateDir })]],
)
const it = testEffect(layer)

afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

describe("OxpFileExchange publication", () => {
  test("uses an exact action grammar before any authority or network work", () => {
    const decode = Schema.decodeUnknownSync(OxpFileExchange.OpenAiRuntimeParameters, {
      onExcessProperty: "error",
    })

    expect(decode({ action: "list", limit: 10 })).toMatchObject({ action: "list", limit: 10 })
    expect(decode({ action: "get", fileID: "file-abc" })).toMatchObject({ action: "get", fileID: "file-abc" })
    expect(
      decode({
        action: "upload",
        rootID: "00000000-0000-4000-8000-000000000001",
        path: "artifact.bin",
        purpose: "user_data",
      }),
    ).toMatchObject({ action: "upload", path: "artifact.bin" })
    expect(
      decode({
        action: "download",
        rootID: "00000000-0000-4000-8000-000000000001",
        path: "artifact.bin",
        fileID: "file-abc",
      }),
    ).toMatchObject({ action: "download", fileID: "file-abc" })

    expect(() => decode({ action: "get" })).toThrow()
    expect(() => decode({ action: "list", path: "must-not-be-accepted" })).toThrow()
    expect(() => decode({ action: "upload", path: "artifact.bin" })).toThrow()
    expect(() =>
      decode({
        action: "download",
        rootID: "00000000-0000-4000-8000-000000000001",
        path: "artifact.bin",
      }),
    ).toThrow()
  })

  test("publishes only after commit revalidation and returns a verified integrity receipt", async () => {
    await fs.mkdir(suite, { recursive: true })
    const destination = path.join(suite, "saved.bin")
    const payload = Buffer.from("verified payload\n")
    let commitChecks = 0

    const receipt = await OxpFileExchange.publish(
      new Response(payload, {
        status: 200,
        headers: { "content-length": String(payload.byteLength) },
      }),
      destination,
      payload.byteLength,
      async () => {
        commitChecks++
      },
    )

    expect(commitChecks).toBe(1)
    expect(receipt).toEqual({
      bytes: payload.byteLength,
      sha256: createHash("sha256").update(payload).digest("hex"),
      verified: true,
    })
    expect(await fs.readFile(destination)).toEqual(payload)
    expect((await fs.lstat(destination)).isFile()).toBe(true)

    await expect(
      OxpFileExchange.publish(
        new Response(payload, { status: 200 }),
        destination,
        payload.byteLength,
        async () => undefined,
      ),
    ).rejects.toMatchObject({ _tag: "OXP_CONFLICT" })
    expect(await fs.readFile(destination)).toEqual(payload)
  })

  test("does not publish or strand partial files when commit revalidation fails", async () => {
    await fs.mkdir(suite, { recursive: true })
    const destination = path.join(suite, "revoked.bin")
    const payload = Buffer.from("not committed\n")

    await expect(
      OxpFileExchange.publish(
        new Response(payload, { status: 200 }),
        destination,
        payload.byteLength,
        async () => {
          throw new OxpError.AuthRevoked({ detail: "authority changed" })
        },
      ),
    ).rejects.toMatchObject({ _tag: "OXP_AUTH_REVOKED" })

    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" })
    const leftovers = (await fs.readdir(suite)).filter((name) => name.includes(".openfork-oxp-transfer-"))
    expect(leftovers).toEqual([])
  })

  test("cancels a mid-body local publication without destination or partial debris", async () => {
    await fs.mkdir(suite, { recursive: true })
    const destination = path.join(suite, "cancelled.bin")
    const controller = new AbortController()
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        pulls++
        if (pulls === 1) {
          stream.enqueue(new TextEncoder().encode("prefix"))
          return
        }
        controller.abort()
        stream.error(new DOMException("aborted", "AbortError"))
      },
    })
    let commitChecks = 0

    await expect(
      OxpFileExchange.publish(
        new Response(body, { status: 200 }),
        destination,
        undefined,
        async () => {
          commitChecks++
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ _tag: "OXP_CANCELLED" })
    expect(commitChecks).toBe(0)
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" })
    const leftovers = (await fs.readdir(suite)).filter((name) => name.includes(".openfork-oxp-transfer-"))
    expect(leftovers).toEqual([])
  })

  test("marks ambiguous external outcomes reconcile-first instead of retryable", () => {
    const projection = OxpResult.projectError(
      new OxpError.AmbiguousExternalResult({
        detail: "publication outcome is ambiguous",
        metadata: { committed: true, bytes: 42 },
      }),
    )

    expect(projection).toEqual({
      code: "OXP_AMBIGUOUS_EXTERNAL_RESULT",
      message: "publication outcome is ambiguous",
      retryable: false,
      metadata: { committed: true, bytes: 42 },
    })
  })

  it.live("projects an aborted OpenAI metadata request as typed cancellation", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const files = yield* OxpFileExchange.Service
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true, write: true, filesReceive: true })
    const previousFetch = globalThis.fetch
    const previousKey = process.env.OPENCODE_OXP_OPENAI_API_KEY
    process.env.OPENCODE_OXP_OPENAI_API_KEY = "test-key"
    const controller = new AbortController()
    controller.abort()
    globalThis.fetch = (async () => {
      throw new DOMException("aborted", "AbortError")
    }) as unknown as typeof fetch
    try {
      const cancelled = yield* files.execute(
        { action: "list_openai_files", limit: 1 },
        controller.signal,
      ).pipe(Effect.flip)
      expect(cancelled._tag).toBe("OXP_CANCELLED")
      expect(cancelled.metadata).toBeUndefined()
    } finally {
      globalThis.fetch = previousFetch
      if (previousKey === undefined) delete process.env.OPENCODE_OXP_OPENAI_API_KEY
      else process.env.OPENCODE_OXP_OPENAI_API_KEY = previousKey
    }
  }))

  it.live("preserves cancellation intent while marking an in-flight upload result ambiguous", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const files = yield* OxpFileExchange.Service
    const rootDir = path.join(suite, "upload-root")
    yield* Effect.promise(() => fs.mkdir(rootDir, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "payload.txt"), "payload"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true, filesSend: true })
    const previousFetch = globalThis.fetch
    const previousKey = process.env.OPENCODE_OXP_OPENAI_API_KEY
    process.env.OPENCODE_OXP_OPENAI_API_KEY = "test-key"
    const controller = new AbortController()
    globalThis.fetch = (async () => {
      controller.abort()
      throw new DOMException("aborted", "AbortError")
    }) as unknown as typeof fetch
    try {
      const cancelled = yield* files.execute(
        {
          action: "upload_openai_file",
          rootID: root.id,
          source: "payload.txt",
          purpose: "user_data",
        },
        controller.signal,
      ).pipe(Effect.flip)
      expect(cancelled._tag).toBe("OXP_CANCELLED")
      expect(cancelled.metadata).toMatchObject({ ambiguous: true })
    } finally {
      globalThis.fetch = previousFetch
      if (previousKey === undefined) delete process.env.OPENCODE_OXP_OPENAI_API_KEY
      else process.env.OPENCODE_OXP_OPENAI_API_KEY = previousKey
    }
  }))

  it.live("streams multipart upload from the stable file descriptor with exact length and incremental hash", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const files = yield* OxpFileExchange.Service
    const rootDir = path.join(suite, "stream-upload-root")
    yield* Effect.promise(() => fs.mkdir(rootDir, { recursive: true }))
    const payload = Buffer.alloc(300 * 1024)
    for (let index = 0; index < payload.length; index++) payload[index] = index % 251
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "stream.bin"), payload))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true, filesSend: true })

    const previousFetch = globalThis.fetch
    const previousKey = process.env.OPENCODE_OXP_OPENAI_API_KEY
    process.env.OPENCODE_OXP_OPENAI_API_KEY = "test-key"
    let bodyWasStream = false
    let chunkCount = 0
    let bodyBytes = Buffer.alloc(0)
    let declaredLength = -1
    let contentType = ""
    globalThis.fetch = (async (_input, init) => {
      bodyWasStream = init?.body instanceof ReadableStream
      const headers = new Headers(init?.headers)
      declaredLength = Number(headers.get("content-length"))
      contentType = headers.get("content-type") ?? ""
      const body = init?.body as ReadableStream<Uint8Array>
      const reader = body.getReader()
      const chunks: Buffer[] = []
      while (true) {
        const next = await reader.read()
        if (next.done) break
        chunkCount++
        chunks.push(Buffer.from(next.value))
      }
      bodyBytes = Buffer.concat(chunks)
      return new Response(
        JSON.stringify({
          id: "file-streamed",
          filename: "stream.bin",
          bytes: payload.byteLength,
          purpose: "user_data",
          created_at: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch

    try {
      const result = yield* files.execute({
        action: "upload_openai_file",
        rootID: root.id,
        source: "stream.bin",
        purpose: "user_data",
      })
      expect(bodyWasStream).toBe(true)
      expect(chunkCount).toBeGreaterThanOrEqual(4)
      expect(declaredLength).toBe(bodyBytes.byteLength)
      expect(contentType).toMatch(/^multipart\/form-data; boundary=----openfork-oxp-/)
      expect(bodyBytes.indexOf(payload)).toBeGreaterThanOrEqual(0)
      expect(result.structured).toMatchObject({
        action: "upload_openai_file",
        source_bytes: payload.byteLength,
        source_sha256: createHash("sha256").update(payload).digest("hex"),
        file: { id: "file-streamed", filename: "stream.bin" },
      })
    } finally {
      globalThis.fetch = previousFetch
      if (previousKey === undefined) delete process.env.OPENCODE_OXP_OPENAI_API_KEY
      else process.env.OPENCODE_OXP_OPENAI_API_KEY = previousKey
    }
  }))

  it.live("rejects an oversize sparse upload as invalid input before network work", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const files = yield* OxpFileExchange.Service
    const rootDir = path.join(suite, "oversize-root")
    yield* Effect.promise(() => fs.mkdir(rootDir, { recursive: true }))
    const source = path.join(rootDir, "oversize.bin")
    yield* Effect.promise(async () => {
      const handle = await fs.open(source, "w")
      try {
        await handle.truncate(512 * 1024 * 1024 + 1)
      } finally {
        await handle.close()
      }
    })
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ read: true, filesSend: true })
    const previousFetch = globalThis.fetch
    let networkCalls = 0
    globalThis.fetch = (async () => {
      networkCalls++
      throw new Error("network should not be reached")
    }) as unknown as typeof fetch
    try {
      const rejected = yield* files.execute({
        action: "upload_openai_file",
        rootID: root.id,
        source: "oversize.bin",
      }).pipe(Effect.flip)
      expect(rejected._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(rejected.detail).toContain("512 MiB")
      expect(networkCalls).toBe(0)
    } finally {
      globalThis.fetch = previousFetch
    }
  }))
})
