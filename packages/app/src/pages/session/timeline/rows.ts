import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import { isSessionMessageStateProjection, type SessionMessageInfo } from "@/utils/session-message-info"
import { AssistantMessage, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { groupParts, renderable, type PartGroup } from "@opencode-ai/session-ui/message-part"
import { estimateMarkdownHeight, MARKDOWN_WIDTH_FALLBACK } from "@/pages/session/v2/project-explorer-markdown-height"
import { TimelineRow, type SummaryDiff } from "./timeline-row"
import { uniqueSummaryDiffs } from "./summary-diffs"
import { systemInjectionSignature } from "./system-injection"
import {
  compareMessages,
  isStateProjectionMessage,
  userTurnPresentation,
} from "@/utils/session-message"

export { TimelineRow, type SummaryDiff } from "./timeline-row"

export type TimelineRowMap = {
  TurnGap: { userMessageID: string }
  CommentStrip: {
    userMessageID: string
  }
  UserMessage: {
    userMessageID: string
    anchor: boolean
  }
  ContextMessage: {
    messageID: string
    kind: "system" | "skill"
    preview: string
    text: string
  }
  SystemInjection: {
    userMessageID: string
    signature: string
    count: number
  }
  TurnDivider: {
    userMessageID: string
    label: "compaction" | "interrupted"
  }
  AssistantPart: {
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
    heightHint?: number
  }
  Thinking: { userMessageID: string; reasoningHeading?: string }
  Retry: { userMessageID: string }
  DiffSummary: { userMessageID: string; diffs: SummaryDiff[] }
  Error: { userMessageID: string; text: string }
}

export type SessionMessageTimelineDisposition =
  | "turn-root"
  | "context-message"
  | "assistant-child"
  | "turn-decoration"
  | "state-projection"
  | "metadata-only"

/**
 * Exhaustive presentation contract for the current SessionMessageInfo union.
 *
 * Text/context-bearing records must have a visible timeline surface. Live Goal
 * STATE is the deliberate exception: it is replaceable domain state rendered by
 * Goal UI, not a conversational turn; historical STATE becomes normal visible
 * history. Agent/model selections are intentionally metadata-only: they annotate
 * the model/agent bound to subsequent turns and do not contain hidden prompt text.
 * Adding a new message variant now fails this switch at compile time until its
 * timeline semantics are classified.
 */
export function sessionMessageTimelineDisposition(message: SessionMessageInfo): SessionMessageTimelineDisposition {
  if (isSessionMessageStateProjection(message)) return "state-projection"
  switch (message.type) {
    case "user":
    case "synthetic":
    case "shell":
      return "turn-root"
    case "system":
    case "skill":
      return "context-message"
    case "assistant":
      return "assistant-child"
    case "compaction":
      return "turn-decoration"
    case "agent-switched":
    case "model-switched":
      return "metadata-only"
    default: {
      const exhaustive: never = message
      return exhaustive
    }
  }
}

export function contextMessageTimelineRow(message: SessionMessageInfo) {
  if (message.type === "system") {
    return new TimelineRow.ContextMessage({
      messageID: message.id,
      kind: "system",
      preview: firstNonBlankLine(message.text),
      text: message.text,
    })
  }
  if (message.type === "skill") {
    return new TimelineRow.ContextMessage({
      messageID: message.id,
      kind: "skill",
      preview: message.name || message.skill,
      text: message.text,
    })
  }
}

function firstNonBlankLine(text: string) {
  for (const line of text.split("\n")) {
    const value = line.trim()
    if (value) return value
  }
  return ""
}

export namespace Timeline {
  export type TurnGroup = { user: UserMessage; assistants: AssistantMessage[]; showUserMessage: boolean }

  function showTurnMessage(message: UserMessage) {
    const presentation = userTurnPresentation(message)
    return presentation === "user" || presentation === "host" || presentation === "synthetic"
  }

  export function constructSessionMessageRows(
    messages: SessionMessageInfo[],
    getMessage: (messageID: string) => UserMessage | AssistantMessage | undefined,
    getMessageParts: (messageID: string) => Part[],
    showReasoning: boolean,
    showSystemInjections: boolean,
    status: SessionStatus["type"],
    inlineComments: boolean,
    projectedUserMessages: UserMessage[],
  ) {
    const { activeMessageID, turns } = groupTurns(messages, getMessage, projectedUserMessages)
    const blocks = [
      ...turns.map((turn, index) => ({
        kind: "turn" as const,
        id: turn.user.id,
        created: turn.user.time.created,
        rows: constructMessageRows(
          turn.user,
          getMessageParts,
          turn.assistants,
          index,
          showReasoning,
          showSystemInjections,
          status,
          turn.user.id === activeMessageID,
          inlineComments,
          undefined,
          { showUserMessage: turn.showUserMessage },
        ),
      })),
      ...messages.flatMap((message) => {
        if (sessionMessageTimelineDisposition(message) !== "context-message") return []
        const row = contextMessageTimelineRow(message)
        if (!row) return []
        return [{
          kind: "context" as const,
          id: message.id,
          created: message.time.created,
          rows: [row],
        }]
      }),
    ]
    blocks.sort((left, right) => left.created - right.created || left.id.localeCompare(right.id))
    return {
      activeMessageID,
      rows: blocks.flatMap((block) => block.rows),
    }
  }

  // Pure grouping pass: which assistant messages belong to which user-message turn, and
  // in what order. Deliberately excludes row CONSTRUCTION (groupParts/markdown estimation/
  // comment parsing) so callers that only need turn membership (e.g. a per-turn reactive
  // cache) don't pay for reprocessing every turn's content on every message-list change.
  export function groupTurns(
    messages: readonly Pick<SessionMessageInfo, "id" | "type">[],
    getMessage: (messageID: string) => UserMessage | AssistantMessage | undefined,
    projectedUserMessages: UserMessage[],
  ) {
    const turns: TurnGroup[] = []
    const turnByUserID = new Map<string, (typeof turns)[number]>()
    const missingTurns: typeof turns = []
    let currentTurn: TurnGroup | undefined
    messages.forEach((message) => {
      const projected = getMessage(message.id)
      if (message.type === "shell" && projected?.role === "user") {
        const assistant = getMessage(`${message.id}:assistant`)
        const turn = {
          user: projected,
          assistants: assistant?.role === "assistant" ? [assistant] : [],
          showUserMessage: true,
        }
        turns.push(turn)
        turnByUserID.set(projected.id, turn)
        currentTurn = undefined
        return
      }
      if (projected?.role === "user") {
        if (turnByUserID.has(projected.id)) return
        // Replaceable STATE is context, not a hidden turn root. Keep the current
        // causal turn intact even when a paginated/replayed window begins with a
        // state projection.
        if (isStateProjectionMessage(projected)) return
        const turn = {
          user: projected,
          assistants: [],
          // Every durable conversational boundary gets a timeline equivalent.
          // Human prompts use the ordinary bubble; host/user Synthetic roots use
          // the automation card selected from durable provenance. Shell and
          // compaction retain their dedicated assistant/divider presentation.
          showUserMessage: showTurnMessage(projected),
        }
        turns.push(turn)
        turnByUserID.set(projected.id, turn)
        currentTurn = turn
        return
      }
      if (projected?.role !== "assistant") return
      const existing = turnByUserID.get(projected.parentID)
      if (existing) {
        existing.assistants.push(projected)
        currentTurn = existing
        return
      }
      const user = getMessage(projected.parentID)
      if (user?.role === "user") {
        if (isStateProjectionMessage(user)) return
        const turn = { user, assistants: [projected], showUserMessage: showTurnMessage(user) }
        // The parent is normalized/loaded but absent from this structural page.
        // Stage it with other projected-missing roots so the single linear merge
        // below restores chronological order without sorting the hot-path turns.
        missingTurns.push(turn)
        turnByUserID.set(user.id, turn)
        currentTurn = turn
        return
      }
      // Parent identity is authoritative whenever the normalized parent is
      // available. Adjacency is only a quarantined compatibility fallback for
      // malformed/legacy projections whose parent cannot be resolved at all.
      if (currentTurn) currentTurn.assistants.push(projected)
    })
    projectedUserMessages.forEach((user) => {
      if (turnByUserID.has(user.id)) return
      const turn = { user, assistants: [], showUserMessage: true }
      missingTurns.push(turn)
      turnByUserID.set(user.id, turn)
    })
    if (missingTurns.length > 0) {
      // Merge separately loaded projected messages in linear time. Repeated
      // findIndex/splice made large history hydration quadratic.
      missingTurns.sort((left, right) => compareMessages(left.user, right.user))
      const merged: typeof turns = []
      let existingIndex = 0
      let missingIndex = 0
      while (existingIndex < turns.length || missingIndex < missingTurns.length) {
        const existing = turns[existingIndex]
        const missing = missingTurns[missingIndex]
        if (!existing || (missing && compareMessages(missing.user, existing.user) < 0)) {
          merged.push(missingTurns[missingIndex++]!)
          continue
        }
        merged.push(existing)
        existingIndex += 1
      }
      turns.splice(0, turns.length, ...merged)
    }
    const activeMessageID = turns.at(-1)?.user.id
    // Keep the index we already built while grouping. Consumers that maintain
    // one memo per turn must not rediscover that turn with Array.find(): on a
    // structural append all of those memos wake together, so N independent
    // linear searches turn an otherwise linear regroup into O(N²) work.
    return { activeMessageID, turns, turnByUserID }
  }

  export function constructMessageRows(
    userMessage: UserMessage,
    getMessageParts: (messageID: string) => Part[],
    assistantMessages: AssistantMessage[],
    index: number,
    showReasoning: boolean,
    // Reveals the turn's server-injected (`synthetic`) text parts as their own
    // row. Off by default; when off the injection scan never runs at all.
    showSystemInjections: boolean,
    status: SessionStatus["type"],
    isActive: boolean,
    // v2 renders comments inside the user message attachments row instead of a strip row
    inlineComments: boolean,
    // The reactive projection can derive this through a memo that only
    // propagates when the visible heading changes. Presence of this options
    // object means "do not inspect live reasoning text here", including when
    // the current derived heading is undefined.
    live?: { reasoningHeading?: string },
    presentation?: { showUserMessage?: boolean },
  ) {
    const rows: TimelineRow.TimelineRow[] = []

    const previousUserMessage = index > 0
    const userParts = getMessageParts(userMessage.id)
    const comments = userParts.flatMap((p) => MessageComment.fromPart(p) ?? [])
    const compaction = userParts.some((p) => p.type === "compaction")
    const interruptedMessageIndex = assistantMessages.findIndex((m) => m.error?.name === "MessageAbortedError")
    const interrupted = interruptedMessageIndex !== -1
    const latestError = assistantMessages.at(-1)?.error
    const error = latestError?.name === "MessageAbortedError" ? undefined : latestError

    const assistantPartRefs = assistantMessages.flatMap((message, messageIndex) =>
      getMessageParts(message.id)
        .filter((part) => renderable(part, showReasoning))
        .map((part) => ({ messageID: message.id, messageIndex, part })),
    )
    const partByRef = new Map(assistantPartRefs.map((ref) => [`${ref.messageID}:${ref.part.id}` as const, ref.part]))
    const assistantItems =
      interrupted && !compaction
        ? [
            ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex <= interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
            { type: "interrupted" as const },
            ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex > interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
          ]
        : groupParts(assistantPartRefs).map((group) => ({ type: "part" as const, group }))
    if (previousUserMessage) rows.push(new TimelineRow.TurnGap({ userMessageID: userMessage.id }))

    if (comments.length > 0 && !inlineComments)
      rows.push(
        new TimelineRow.CommentStrip({
          userMessageID: userMessage.id,
        }),
      )

    if (presentation?.showUserMessage !== false)
      rows.push(
        new TimelineRow.UserMessage({
          userMessageID: userMessage.id,
          anchor: inlineComments || comments.length === 0,
        }),
      )

    // Sits directly under the prompt it was appended to, because that is what
    // the model actually received for this turn. Gated first so the scan is not
    // even attempted while the setting is off.
    if (showSystemInjections && userTurnPresentation(userMessage) === "user") {
      const injections = systemInjectionSignature(userParts)
      if (injections.count > 0) {
        rows.push(
          new TimelineRow.SystemInjection({
            userMessageID: userMessage.id,
            signature: injections.signature,
            count: injections.count,
          }),
        )
      }
    }
    if (compaction) {
      rows.push(
        new TimelineRow.TurnDivider({
          userMessageID: userMessage.id,
          label: "compaction",
        }),
      )
    }

    let assistantGroupIndex = 0
    // The hint is a PRE-MOUNT prior. A streaming turn's part text grows with
    // every delta; attaching the changing hint to its rows would break row
    // equality (the hint is the only text-derived field) and replace/remount
    // the markdown element mid-stream. Same workingTurn predicate as
    // message-timeline: skip the hint while the active turn is not idle.
    const workingTurn = isActive && status !== "idle"
    assistantItems.forEach((item) => {
      if (item.type === "interrupted") {
        rows.push(
          new TimelineRow.TurnDivider({
            userMessageID: userMessage.id,
            label: "interrupted",
          }),
        )
        return
      }

      const heightHint = workingTurn ? undefined : markdownRowHeightHint(item.group, partByRef)
      rows.push(
        new TimelineRow.AssistantPart({
          userMessageID: userMessage.id,
          group: item.group,
          previousAssistantPart: assistantGroupIndex > 0,
          // Omit the hint when absent so row equality is byte-identical to the
          // un-flagged build (flag "off" / working turn / non-markdown parts).
          ...(heightHint === undefined ? {} : { heightHint }),
        }),
      )
      assistantGroupIndex += 1
    })

    if (isActive && status === "busy" && !error && (showReasoning ? assistantPartRefs.length === 0 : true)) {
      const heading = live
        ? live.reasoningHeading
        : assistantMessages
            .flatMap((message) => getMessageParts(message.id))
            .map((part) => (part.type === "reasoning" && part.text ? reasoningHeading(part.text) : undefined))
            .find((value): value is string => !!value)

      rows.push(
        new TimelineRow.Thinking({
          userMessageID: userMessage.id,
          reasoningHeading: heading,
        }),
      )
    }

    if (isActive && status === "retry") rows.push(new TimelineRow.Retry({ userMessageID: userMessage.id }))

    const diffs = uniqueSummaryDiffs(userMessage.summary?.diffs)
    if (diffs.length > 0 && (status === "idle" || !isActive)) {
      rows.push(
        new TimelineRow.DiffSummary({
          userMessageID: userMessage.id,
          diffs,
        }),
      )
    }

    if (error) {
      const data = error.data?.message
      rows.push(
        new TimelineRow.Error({
          userMessageID: userMessage.id,
          text: unwrapErrorMessage(
            typeof data === "string" ? data : data === undefined || data === null ? "" : String(data),
          ),
        }),
      )
    }

    return rows
  }

  export function reasoningHeading(text: string) {
    const markdown = text.replace(/\r\n?/g, "\n")
    const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
    if (html?.[1]) {
      const value = cleanHeading(html[1].replace(/<[^>]+>/g, " "))
      if (value) return value
    }

    const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)
    if (atx?.[1]) {
      const value = cleanHeading(atx[1])
      if (value) return value
    }

    const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)
    if (setext?.[1]) {
      const value = cleanHeading(setext[1])
      if (value) return value
    }

    const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)
    if (strong?.[1]) {
      const value = cleanHeading(strong[1])
      if (value) return value
    }
  }

  function cleanHeading(value: string) {
    return value
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~]+/g, "")
      .trim()
  }

  function unwrapErrorMessage(message: string) {
    const text = message.replace(/^Error:\s*/, "").trim()

    const parse = (value: string) => {
      try {
        return JSON.parse(value) as unknown
      } catch {
        return undefined
      }
    }

    const read = (value: string) => {
      const first = parse(value)
      if (typeof first !== "string") return first
      return parse(first.trim())
    }

    let json = read(text)

    if (json === undefined) {
      const start = text.indexOf("{")
      const end = text.lastIndexOf("}")
      if (start !== -1 && end > start) json = read(text.slice(start, end + 1))
    }

    if (!record(json)) return message

    const err = record(json.error) ? json.error : undefined
    if (err) {
      const type = typeof err.type === "string" ? err.type : undefined
      const msg = typeof err.message === "string" ? err.message : undefined
      if (type && msg) return `${type}: ${msg}`
      if (msg) return msg
      if (type) return type
      const code = typeof err.code === "string" ? err.code : undefined
      if (code) return code
    }

    const msg = typeof json.message === "string" ? json.message : undefined
    if (msg) return msg

    const reason = typeof json.error === "string" ? json.error : undefined
    if (reason) return reason

    return message
  }

  function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }

  function markdownRowHeightHint(group: PartGroup, partByRef: Map<string, Part>) {
    if (group.type !== "part") return
    const part = partByRef.get(`${group.ref.messageID}:${group.ref.partID}`)
    if (part?.type !== "text") return
    return estimateMarkdownHeight(part.text, MARKDOWN_WIDTH_FALLBACK)
  }
}

export namespace MessageComment {
  export type MessageComment = {
    path: string
    comment: string
    selection?: {
      startLine: number
      endLine: number
    }
  }

  export const fromPart = (part: Part): MessageComment | undefined => {
    if (part.type !== "text" || !part.synthetic) return
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return
    return {
      path: next.path,
      comment: next.comment,
      selection: next.selection
        ? {
            startLine: next.selection.startLine,
            endLine: next.selection.endLine,
          }
        : undefined,
    }
  }
}
