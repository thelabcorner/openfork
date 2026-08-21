import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import type { PartGroup } from "@opencode-ai/session-ui/message-part"
import { Data, Equal } from "effect"

export type SummaryDiff = SnapshotFileDiff & { file: string }

export namespace TimelineRow {
  export class TurnGap extends Data.TaggedClass("TurnGap")<{
    userMessageID: string
  }> {}
  export class CommentStrip extends Data.TaggedClass("CommentStrip")<{
    userMessageID: string
  }> {}
  export class UserMessage extends Data.TaggedClass("UserMessage")<{
    userMessageID: string
    anchor: boolean
  }> {}
  export class TurnDivider extends Data.TaggedClass("TurnDivider")<{
    userMessageID: string
    label: "compaction" | "interrupted"
  }> {}
  export class AssistantPart extends Data.TaggedClass("AssistantPart")<{
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
    /**
     * Advisory pre-mount height hint (px) for markdown text parts, derived
     * from the pretext text-layout prior. PRETEXT PREDICTS, THE DOM DECIDES:
     * the virtualizer may use this before mount, but measured height is
     * authoritative. Always omitted when the OPENCODE_TEXT_LAYOUT flag is
     * "off", so row equality is byte-identical to the un-flagged build.
     */
    heightHint?: number
  }> {}
  export class Thinking extends Data.TaggedClass("Thinking")<{
    userMessageID: string
    reasoningHeading?: string
  }> {}
  export class DiffSummary extends Data.TaggedClass("DiffSummary")<{
    userMessageID: string
    diffs: SummaryDiff[]
  }> {}
  export class Error extends Data.TaggedClass("Error")<{
    userMessageID: string
    text: string
  }> {}
  export class Retry extends Data.TaggedClass("Retry")<{
    userMessageID: string
  }> {}

  export type TimelineRow =
    | TurnGap
    | CommentStrip
    | UserMessage
    | TurnDivider
    | AssistantPart
    | Thinking
    | DiffSummary
    | Error
    | Retry

  // Rows are immutable after construction (constructMessageRows creates fresh
  // instances; reuseTimelineRows copies rather than mutating), so the key is a
  // pure function of the row object and can be memoized once per row. key() is
  // on the hot path of every rows-list change (reconciliation, index maps,
  // virtualizer re-keying, estimateInput), where the string concat showed up
  // as measurable overhead -- the cache turns it into a WeakMap get.
  const keyCache = new WeakMap<TimelineRow, string>()
  export const key = (row: TimelineRow) => {
    const cached = keyCache.get(row)
    if (cached !== undefined) return cached
    const computed = computeKey(row)
    keyCache.set(row, computed)
    return computed
  }

  function computeKey(row: TimelineRow) {
    switch (row._tag) {
      case "TurnGap":
        return `turn-gap:${row.userMessageID}`
      case "CommentStrip":
        return `comment-strip:${row.userMessageID}`
      case "UserMessage":
        return `user-message:${row.userMessageID}`
      case "TurnDivider":
        return `turn-divider:${row.userMessageID}:${row.label}`
      case "AssistantPart":
        return `assistant-part:${row.userMessageID}:${row.group.key}`
      case "Thinking":
        return `thinking:${row.userMessageID}`
      case "DiffSummary":
        return `diff-summary:${row.userMessageID}`
      case "Error":
        return `error:${row.userMessageID}`
      case "Retry":
        return `retry:${row.userMessageID}`
    }
  }

  export function equals(a: TimelineRow, b: TimelineRow) {
    return Equal.equals(a, b)
  }
}
