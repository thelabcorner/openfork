/// <reference lib="webworker" />
import { createBinaryModuleFromUrl, LocalLinter } from "harper.js"
import wasmUrl from "../../../node_modules/harper.js/dist/harper_wasm_bg.wasm?url"

// Vite emits a separately cacheable, same-origin 16 MB WASM asset instead of
// parsing a 21 MB base64 JavaScript literal on each worker initialization.
// Deep file URL is intentional: Harper's published package exports omit a
// direct asset entry and its default binary URL fails under Vite prebundling.
const binary = createBinaryModuleFromUrl(wasmUrl, "full")

type Diagnostic = {
  start: number
  end: number
  kind: string
  message: string
  suggestions: string[]
}
type Request = { id: number; type: "lint"; text: string }

// Harper LocalLinter runs only in this same-origin module worker: no main-thread
// WASM compilation and no dynamically generated blob:/data: worker boot script.
let instance: LocalLinter | undefined
const setup = (async () => {
  const linter = new LocalLinter({ binary })
  await linter.setup()
  instance = linter
  self.postMessage({ type: "ready" })
})().catch((error: unknown) => {
  self.postMessage({
    type: "error",
    message: "Harper WASM initialization failed: " + (error instanceof Error ? error.message : String(error)),
  })
})

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data
  if (!request || request.type !== "lint") return
  void (async () => {
    await setup
    if (!instance) return
    // Defensive bound also lives on worker: untrusted messages cannot trigger
    // unbounded computation or memory use.
    if (request.text.length > 8_000) {
      self.postMessage({ type: "result", id: request.id, diagnostics: [] })
      return
    }
    try {
      const result = await instance.lint(request.text)
      const diagnostics: Diagnostic[] = []
      for (const item of result.slice(0, 80)) {
        const span = item.span()
        diagnostics.push({
          start: span.start, end: span.end, kind: item.lint_kind(),
          message: item.message(),
          suggestions: item.suggestions().slice(0, 4).map((suggestion) => suggestion.get_replacement_text()),
        })
      }
      self.postMessage({ type: "result", id: request.id, diagnostics })
    } catch {
      self.postMessage({ type: "error", id: request.id, message: "Harper lint request failed" })
    }
  })()
}
