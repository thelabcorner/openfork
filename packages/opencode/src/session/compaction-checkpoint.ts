import type { SessionV1 } from "@opencode-ai/core/v1/session"

/**
 * A provider's nonempty finish flag does not prove it produced a usable
 * checkpoint. A partial/tool-call/error finish must never hide durable history.
 *
 * Intentionally do not require a particular Markdown template: V1 permits
 * custom compaction prompts, and historical checkpoints predate that template.
 * Semantic fidelity is a separate (not yet certified) admission gate.
 */
export function hasUsableCompactionCheckpoint(message: SessionV1.WithParts): boolean {
  return message.info.role === "assistant" &&
    message.info.summary === true &&
    // V1 records provider stop as "stop"; imported/older host checkpoints
    // also use "end_turn". Both are terminal success, unlike length/tool/error.
    (message.info.finish === "stop" || message.info.finish === "end_turn") &&
    !message.info.error &&
    // A checkpoint is a text handoff, never an executable tool continuation
    // or a multimodal result. Ignored text is not provider-visible state.
    !message.parts.some((part) => part.type === "tool" || part.type === "file") &&
    message.parts.some(
      (part) => part.type === "text" && !part.ignored && typeof part.text === "string" && part.text.trim().length > 0,
    )
}

export * as CompactionCheckpoint from "./compaction-checkpoint"