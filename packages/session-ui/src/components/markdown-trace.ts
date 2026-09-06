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
    }

type MarkdownTraceGlobal = typeof globalThis & {
  __opencodeMarkdownTrace?: (event: MarkdownTraceEvent) => void
}

export function markdownTraceEnabled() {
  return typeof (globalThis as MarkdownTraceGlobal).__opencodeMarkdownTrace === "function"
}

export function traceMarkdown(event: MarkdownTraceEvent) {
  ;(globalThis as MarkdownTraceGlobal).__opencodeMarkdownTrace?.(event)
}
