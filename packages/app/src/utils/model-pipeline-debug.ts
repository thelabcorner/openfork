import { createStore } from "solid-js/store"

// TEMPORARY diagnostics for the model-catalog pricing pipeline. Pipeline
// stages call logPipeline(); ModelPipelineDebugOverlay renders the stream.
// Remove once the missing-openai-cost issue is resolved.

export type PipelineEntry = { seq: number; at: string; stage: string; detail: string }

const [log, setLog] = createStore<{ list: PipelineEntry[] }>({ list: [] })
const seen = new Map<string, string>()
let seq = 0

const MAX_ENTRIES = 250

export function pipelineEntries(): PipelineEntry[] {
  return log.list
}

export function clearPipeline() {
  seen.clear()
  setLog("list", [])
}

// Dedupes identical readings per stage so reactive memos/effects can call this
// on every recomputation without flooding the log.
export function logPipeline(stage: string, detail: string) {
  if (seen.get(stage) === detail) return
  seen.set(stage, detail)
  setLog("list", (list) => {
    const entry: PipelineEntry = { seq: ++seq, at: new Date().toISOString().slice(11, 23), stage, detail }
    const next = [...list, entry]
    return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
  })
}
