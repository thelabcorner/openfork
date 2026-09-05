// Verifies the annotation persistence + reload path at the draft-store level.
//
// The persisted PromptStore routes through `platform.draftStore`. In the
// desktop app that is `createDraftStore` over the IPC-backed `drafts.sqlite`
// driver (packages/desktop/src/renderer/index.tsx); the web/PWA build uses the
// same `createDraftStore` over IndexedDB. `createPromptSession` + the
// persisted-prompt `normalize`/`merge` in persist.ts preserve the `prompt`
// array verbatim (no blank-discard), so whatever we commit through this store
// is what re-hydrates on reload.
//
// This test drives the REAL `createDraftStore` (the actual persistence
// mechanism) with an in-memory driver, commits an annotation's exact part
// shapes (a structured text part + a screenshot image blob part), then
// simulates a reload by re-opening the store over the same driver and asserts
// BOTH the annotation text AND the screenshot blob reference survive.
//
// It does not exercise the Solid `persisted()` wrapper itself (that needs the
// full Platform context); the unit test below covers that the text part is
// non-empty, which is the emptiness predicate's anchor.
import { createDraftStore, type DraftStore } from "@/utils/draft-store"
import { buildBrowserAnnotationPrompt } from "@/pages/session/v2/browser/browserAnnotationPrompt"
import type { BrowserAnnotationResult } from "@/pages/session/v2/browser/browserHostClient"

function inMemoryDriver() {
  const documents = new Map<string, string>()
  const blobs = new Map<string, Blob>()
  return {
    driver: {
      get: async (key: string) => documents.get(key) ?? null,
      set: async (key: string, value: string) => void documents.set(key, value),
      remove: async (key: string) => void documents.delete(key),
      putBlob: async (blob: Blob) => {
        const id = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()).then((b) =>
          Array.from(new Uint8Array(b))
            .map((x) => x.toString(16).padStart(2, "0"))
            .join(""),
        )
        blobs.set(id, blob)
        return id
      },
      getBlob: async (id: string) => blobs.get(id) ?? null,
    },
    documents,
    blobs,
  }
}

const annotation: BrowserAnnotationResult = {
  id: "anno-1",
  submission: "attach",
  pageUrl: "https://example.com",
  pageTitle: "Example",
  comment: "make the button green",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: { dataUrl: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png", width: 1, height: 1 },
  createdAt: "2026-09-04T00:00:00.000Z",
}

function buildImagePart(blobRef: { id: string; url: string }) {
  return {
    type: "image" as const,
    id: "img-1",
    filename: "browser-annotation-anno-1.png",
    mime: "image/png",
    blob: blobRef,
  }
}

async function putScreenshot(store: DraftStore, dataUrl: string) {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  const file = new File([blob], "browser-annotation-anno-1.png", { type: "image/png" })
  return store.putBlob(file)
}

test("annotation text part is non-empty (emptiness predicate anchor)", () => {
  const text = buildBrowserAnnotationPrompt(annotation)
  expect(text.length).toBeGreaterThan(0)
  expect(text).toContain("<browser_annotation>")
  expect(text).toContain("Browser annotation:")
})

test("annotation draft (text + screenshot blob) survives a reload round-trip", async () => {
  const mem = inMemoryDriver()
  const store = createDraftStore(mem.driver)

  // 1) Persist the annotation exactly the way attachAnnotation does: text part
  //    committed first, then the screenshot image blob part.
  const textPart = { type: "text" as const, content: buildBrowserAnnotationPrompt(annotation), start: 0, end: 0 }
  const blobRef = await putScreenshot(store, annotation.screenshot!.dataUrl)
  const imagePart = buildImagePart(blobRef)
  const promptDoc = { prompt: [textPart, imagePart] }
  await store.setItem("prompt", JSON.stringify(promptDoc))
  await store.flush()

  // Sanity: persisted document never carries a multi-MB data URL (invariant).
  expect(mem.documents.get("prompt")).not.toContain("data:image/png;base64")

  // 2) Simulate a reload: throw the store away, re-open over the SAME driver.
  const reloaded = createDraftStore(mem.driver)
  const raw = (await reloaded.getItem("prompt"))!
  const value = JSON.parse(raw) as { prompt: Array<Record<string, any>> }

  // 3) The annotation text content survived.
  const reText = value.prompt.find((p) => p.type === "text")
  expect(reText).toBeDefined()
  expect(reText!.content).toContain("<browser_annotation>")
  expect(reText!.content).toContain("Browser annotation:")

  // 4) The screenshot blob reference survived and re-hydrated into a live URL.
  const reImage = value.prompt.find((p) => p.type === "image")
  expect(reImage).toBeDefined()
  expect(reImage!.blob.id).toBe(blobRef.id)
  expect(typeof reImage!.blob.url).toBe("string")
  expect(reImage!.blob.url.startsWith("blob:")).toBe(true)
})
