import { describe, expect, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createEffect, createRoot } from "solid-js"
import type { Platform } from "@/context/platform"
import { createPromptReady, createPromptSession } from "@/context/prompt-state"
import { ServerScope } from "@/utils/server-scope"
import { createDraftStore } from "@/utils/draft-store"

let read: ((value: string | null) => void) | undefined

const storage: AsyncStorage = {
  getItem: () => new Promise((resolve) => (read = resolve)),
  setItem: async () => undefined,
  removeItem: async () => undefined,
  clear: async () => undefined,
  key: async () => null,
  getLength: async () => 0,
  length: Promise.resolve(0),
}

const platform: Platform = {
  platform: "web",
  openExternal: () => undefined,
  restart: async () => undefined,
  notify: async () => undefined,
  draftStore: {
    ...storage,
    putBlob: async () => {
      throw new Error("putBlob is not used by this test")
    },
  },
}

describe("prompt persistence", () => {
  test("waits for an async draft to hydrate before reporting ready", async () => {
    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        const session = createPromptSession(ServerScope.local, { draftID: "draft-async" }, undefined, platform)
        const ready = createPromptReady(() => session)

        expect(ready()).toBe(false)
        expect(session.current()[0]).toMatchObject({ type: "text", content: "" })

        read?.(
          JSON.stringify({
            prompt: [{ type: "text", content: "persisted draft", start: 0, end: 15 }],
            cursor: 15,
            context: { items: [] },
          }),
        )

        createEffect(() => {
          if (!ready()) return
          try {
            expect(session.current()[0]).toMatchObject({ type: "text", content: "persisted draft" })
            dispose()
            resolve()
          } catch (error) {
            dispose()
            reject(error)
          }
        })
      })
    })
  })
})

test("moves legacy image data URLs into blobs and hydrates object URLs", async () => {
  const documents = new Map<string, string>()
  const blobs = new Map<string, Blob>()
  const store = createDraftStore({
    get: async (key) => documents.get(key) ?? null,
    set: async (key, value) => void documents.set(key, value),
    remove: async (key) => void documents.delete(key),
    putBlob: async (blob) => {
      const id = String(blob.size)
      blobs.set(id, blob)
      return id
    },
    getBlob: async (id) => blobs.get(id) ?? null,
  })

  await store.setItem("prompt", JSON.stringify({ prompt: [{ type: "image", dataUrl: "data:image/png;base64,YQ==" }] }))
  await store.flush()
  expect(documents.get("prompt")).not.toContain("dataUrl")
  const value = JSON.parse((await store.getItem("prompt"))!)
  expect(value.prompt[0].blob.id).toBe("1")
  expect(value.prompt[0].blob.url).toStartWith("blob:")
})

test("coalesces rapid draft writes into a single write of the latest value", async () => {
  const documents = new Map<string, string>()
  let writes = 0
  const store = createDraftStore({
    get: async () => null,
    set: async (key, value) => {
      writes++
      documents.set(key, value)
    },
    remove: async () => undefined,
    putBlob: async () => "blob",
    getBlob: async () => null,
  })

  await store.setItem("prompt", JSON.stringify({ prompt: [{ type: "text", content: "first" }] }))
  await store.setItem("prompt", JSON.stringify({ prompt: [{ type: "text", content: "second" }] }))
  expect(documents.has("prompt")).toBe(false)
  expect(await store.getItem("prompt")).toContain("second")

  await store.flush()
  expect(writes).toBe(1)
  expect(documents.get("prompt")).toContain("second")
})

test("removeItem cancels a pending debounced write instead of resurrecting the draft", async () => {
  const documents = new Map<string, string>()
  let writes = 0
  const store = createDraftStore({
    get: async () => null,
    set: async (key, value) => {
      writes++
      documents.set(key, value)
    },
    remove: async (key) => void documents.delete(key),
    putBlob: async () => "blob",
    getBlob: async () => null,
  })

  await store.setItem("prompt", JSON.stringify({ prompt: [{ type: "text", content: "draft" }] }))
  await store.removeItem("prompt")
  await store.flush()

  expect(writes).toBe(0)
  expect(documents.has("prompt")).toBe(false)
})

test("does not let an in-flight older commit overwrite a newer draft", async () => {
  const documents = new Map<string, string>()
  const migration = Promise.withResolvers<void>()
  const store = createDraftStore({
    get: async () => null,
    set: async (key, value) => void documents.set(key, value),
    remove: async () => undefined,
    putBlob: async () => {
      await migration.promise
      return "blob"
    },
    getBlob: async () => null,
  })
  const older = store.setItem("prompt", JSON.stringify({ prompt: [{ type: "image", dataUrl: "data:image/png;base64,YQ==" }] }))
  const firstCommit = store.flush()
  await store.setItem("prompt", JSON.stringify({ prompt: [{ type: "text", content: "latest" }] }))

  await store.flush()
  expect(documents.get("prompt")).toContain("latest")
  migration.resolve()
  await firstCommit
  await older

  expect(documents.get("prompt")).toContain("latest")
})
