export type MarkdownTraceEvent =
  | {
      phase: "paced"
      chars: number
      streaming: boolean
    }
  | {
      phase: "effect"
      ms: number
      textChars: number
      blockCount: number
      streaming: boolean
    }
  | {
      phase: "block"
      ms: number
      action: string
      mode: string
      chars: number
      htmlChars?: number
      innerHTMLMs?: number
      decorateMs?: number
      morphMs?: number
      codeMs?: number
      tokenCount?: number
    }
  | {
      phase: "sanitize"
      ms: number
      chars: number
      htmlChars: number
    }
  | {
      phase: "worker"
      kind: "parse" | "project" | "highlight"
      status: "ok" | "superseded" | "error" | "disposed"
      ms: number
      chars: number
      workerMs?: number
      workerQueueMs?: number
      dispatchWaitMs?: number
      responseWaitMs?: number
      incremental?: boolean
    }

type MarkdownTraceGlobal = typeof globalThis & {
  __opencodeMarkdownTrace?: (event: MarkdownTraceEvent) => void
  __opencodeMarkdownTraceEnabled?: () => boolean
}

export function markdownTraceEnabled() {
  const target = globalThis as MarkdownTraceGlobal
  if (typeof target.__opencodeMarkdownTraceEnabled === "function") return target.__opencodeMarkdownTraceEnabled()
  return typeof target.__opencodeMarkdownTrace === "function"
}

export function traceMarkdown(event: MarkdownTraceEvent) {
  ;(globalThis as MarkdownTraceGlobal).__opencodeMarkdownTrace?.(event)
}
