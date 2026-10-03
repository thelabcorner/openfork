import type { SessionMessageInfo } from "@/utils/session-message-info"
import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, mapArray, onCleanup, type Accessor } from "solid-js"
import { phaseTrace } from "@/context/phase-trace"
import { reuseTimelineRows } from "./row-reconciliation"
import {
  contextMessageTimelineRow,
  sessionMessageTimelineDisposition,
  Timeline,
  TimelineRow,
} from "./rows"
import { projectWorkingAssistantParts, workingAssistantPartsEqual } from "./working-part-structure"

export { reuseTimelineRows } from "./row-reconciliation"

const emptyRows: TimelineRow.TimelineRow[] = []
const emptyIDs: string[] = []
const emptyParts: Part[] = []
type SessionMessageStructure = Pick<SessionMessageInfo, "id" | "type">
const emptySessionMessageStructure: SessionMessageStructure[] = []
type ContextMessageStructure = {
  readonly id: string
  readonly created: number
  readonly kind: "system" | "skill"
  readonly preview: string
  readonly text: string
}
const emptyContextMessageStructure: ContextMessageStructure[] = []
const REASONING_HEADING_REFRESH_MS = 200

type TimelineBlock = {
  readonly id: string
  readonly created: number
  readonly rows: TimelineRow.TimelineRow[]
}

function arraysShallowEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

function messageStructureEqual(a: SessionMessageStructure[], b: SessionMessageStructure[]) {
  if (a.length !== b.length) return false
  return a.every((value, index) => value.id === b[index]?.id && value.type === b[index]?.type)
}

function contextMessageStructureEqual(a: ContextMessageStructure[], b: ContextMessageStructure[]) {
  if (a.length !== b.length) return false
  return a.every(
    (value, index) =>
      value.id === b[index]?.id &&
      value.created === b[index]?.created &&
      value.kind === b[index]?.kind &&
      value.preview === b[index]?.preview &&
      value.text === b[index]?.text,
  )
}

function blockBeforeOrEqual(left: Pick<TimelineBlock, "id" | "created">, right: Pick<TimelineBlock, "id" | "created">) {
  return left.created < right.created || (left.created === right.created && left.id <= right.id)
}

/** Merge two already-chronological projections in O(n + m).
 *
 * grouped turns are kept chronological, including recovered/missing roots, and
 * contextMessages is a stable subsequence of sessionMessages. Avoid Array.sort
 * on this structural-append path: long sessions should pay linear projection
 * cost, not O(history log history), just to interleave a usually-tiny context stream.
 */
function mergeTimelineBlocks(turns: readonly TimelineBlock[], context: readonly TimelineBlock[]) {
  if (context.length === 0) return turns.flatMap((block) => block.rows)
  if (turns.length === 0) return context.flatMap((block) => block.rows)

  const rows: TimelineRow.TimelineRow[] = []
  let turnIndex = 0
  let contextIndex = 0
  while (turnIndex < turns.length || contextIndex < context.length) {
    const turn = turns[turnIndex]
    const item = context[contextIndex]
    if (!item || (turn && blockBeforeOrEqual(turn, item))) {
      rows.push(...turn!.rows)
      turnIndex += 1
      continue
    }
    rows.push(...item.rows)
    contextIndex += 1
  }
  return rows
}

export function createTimelineProjection(input: {
  messages: Accessor<Message[]>
  userMessages: Accessor<UserMessage[]>
  sessionMessages: Accessor<SessionMessageInfo[]>
  parts: (messageID: string) => Part[]
  status: Accessor<SessionStatus>
  showReasoningSummaries: Accessor<boolean>
  showSystemInjections: Accessor<boolean>
  inlineComments: Accessor<boolean>
}) {
  const messageByID = createMemo(() => new Map(input.messages().map((message) => [message.id, message] as const)))
  const assistantMessagesByParent = createMemo(() => {
    const result = new Map<string, AssistantMessage[]>()
    input.messages().forEach((message) => {
      if (message.role !== "assistant") return
      const messages = result.get(message.parentID)
      if (messages) {
        messages.push(message)
        return
      }
      result.set(message.parentID, [message])
    })
    return result
  })
  // Turn membership depends only on ordered message identity/type plus the
  // normalized Message lookup below. Streaming text/reasoning/tool deltas replace
  // one SessionMessageInfo object per token, but they do not change either of
  // these structural fields. Solid's store tracks `id`/`type` at property
  // granularity, so this memo stays asleep for content-only replacements; the
  // explicit equality guard also protects non-store/accessor callers that hand
  // us a fresh but structurally identical array. This removes an O(history)
  // groupTurns pass from the per-token renderer path.
  const structuralMessages = createMemo(
    () => input.sessionMessages().map((message): SessionMessageStructure => ({ id: message.id, type: message.type })),
    emptySessionMessageStructure,
    { equals: messageStructureEqual },
  )
  const contextMessages = createMemo(
    () =>
      input.sessionMessages().flatMap((message): ContextMessageStructure[] => {
        if (sessionMessageTimelineDisposition(message) !== "context-message") return []
        const row = contextMessageTimelineRow(message)
        if (!row) return []
        return [{
          id: message.id,
          created: message.time.created,
          kind: row.kind,
          preview: row.preview,
          text: row.text,
        }]
      }),
    emptyContextMessageStructure,
    { equals: contextMessageStructureEqual },
  )

  // Fine-grained per-turn row construction. `grouped()` is cheap (a single pass over
  // structural messages, no part reads) and only reruns when turn membership can change.
  // The EXPENSIVE part -- groupParts/markdown-height-estimation/comment parsing inside
  // constructMessageRows -- must not rerun for a turn whose own messages/parts didn't
  // change. Solid store mutations (message.part.delta, message.updated) are applied
  // in place via `produce`/`reconcile`, so array/object REFERENCES stay stable across
  // unrelated updates -- reference diffing can't detect real changes. Instead each turn
  // gets its own `createMemo`, reading its message references through O(1) indexes
  // and its own parts directly from the store, so Solid's fine-grained dependency
  // tracking decides which turn actually needs to recompute.
  const grouped = createMemo(() => {
    const started = phaseTrace.enabled ? performance.now() : 0
    const turns = Timeline.groupTurns(
      structuralMessages(),
      (messageID) => messageByID().get(messageID) as UserMessage | AssistantMessage | undefined,
      input.userMessages(),
    )
    if (phaseTrace.enabled) phaseTrace.projection(performance.now() - started, turns.turns.length)
    return turns
  })
  const activeMessageID = createMemo(() => grouped().activeMessageID)
  const turnOrder = createMemo(() => grouped().turns.map((turn) => turn.user.id), emptyIDs, {
    equals: arraysShallowEqual,
  })
  const perTurnRows = mapArray(turnOrder, (userMessageID) => {
    const assistantIDs = createMemo(
      () => grouped().turnByUserID.get(userMessageID)?.assistants.map((a) => a.id) ?? emptyIDs,
      emptyIDs,
      { equals: arraysShallowEqual },
    )
    const showUserMessage = createMemo(() => grouped().turnByUserID.get(userMessageID)?.showUserMessage !== false)
    // A message append rebuilds messageByID(), so these tiny lookup memos wake,
    // but each lookup is O(1) and default reference equality prevents unchanged
    // messages from propagating into row construction. The previous implementation
    // used `messages.find(id)` here: every append woke every turn and each lookup
    // rescanned the whole session, making structural growth O(turns × messages).
    const userMessage = createMemo(() => messageByID().get(userMessageID))
    const assistantViews = mapArray(assistantIDs, (assistantID) => {
      const message = createMemo(() => messageByID().get(assistantID))
      // This memo may evaluate on every delta in this assistant message, but it
      // only notifies row construction when the structural projection changes.
      // After text becomes non-empty, another 100k streamed characters compare
      // equal to the same one-character marker.
      const structuralParts = createMemo(
        () => projectWorkingAssistantParts(input.parts(assistantID)),
        emptyParts,
        { equals: workingAssistantPartsEqual },
      )
      return { id: assistantID, message, structuralParts }
    })
    const assistantViewByID = createMemo(() => new Map(assistantViews().map((view) => [view.id, view] as const)))
    const [reasoningHeading, setReasoningHeading] = createSignal<string>()
    let reasoningTexts: string[] = []
    let lastHeadingRefresh: number | undefined
    let headingTimer: ReturnType<typeof setTimeout> | undefined
    const refreshReasoningHeading = () => {
      headingTimer = undefined
      lastHeadingRefresh = performance.now()
      for (const text of reasoningTexts) {
        const heading = Timeline.reasoningHeading(text)
        if (heading) {
          setReasoningHeading(heading)
          return
        }
      }
      setReasoningHeading(undefined)
    }
    createEffect(() => {
      // Only the active busy turn needs a reasoning heading. Historical turns
      // must not parse or retain their reasoning text just because the timeline
      // mounted. Keep the full current text and run the compatibility parser at
      // a bounded cadence; this preserves late headings and parser precedence.
      const active = userMessageID === activeMessageID()
      const status = active ? input.status().type : "idle"
      const views = active && status === "busy" ? assistantViews() : []
      const assistants = views
        .map((view) => view.message())
        .filter((message): message is AssistantMessage => message?.role === "assistant")
      const latestError = assistants.at(-1)?.error
      const hasError = latestError !== undefined && latestError.name !== "MessageAbortedError"
      const busy = active && status === "busy" && !hasError && !input.showReasoningSummaries()
      if (!busy) {
        if (headingTimer !== undefined) clearTimeout(headingTimer)
        headingTimer = undefined
        reasoningTexts = []
        setReasoningHeading(undefined)
        return
      }
      reasoningTexts = []
      for (const view of views) {
        for (const part of input.parts(view.id)) {
          if (part.type !== "reasoning" || !part.text) continue
          reasoningTexts.push(part.text)
        }
      }
      const now = performance.now()
      const wait =
        lastHeadingRefresh === undefined ? 0 : REASONING_HEADING_REFRESH_MS - (now - lastHeadingRefresh)
      if (wait <= 0) {
        if (headingTimer !== undefined) clearTimeout(headingTimer)
        refreshReasoningHeading()
        return
      }
      if (headingTimer !== undefined) return
      headingTimer = setTimeout(refreshReasoningHeading, wait)
    })
    onCleanup(() => {
      if (headingTimer !== undefined) clearTimeout(headingTimer)
    })
    const liveReasoningHeading = createMemo(() => {
      return reasoningHeading()
    })
    const isFirstTurn = createMemo(() => turnOrder()[0] === userMessageID)
    return createMemo<TimelineRow.TimelineRow[]>((previous) => {
      const started = phaseTrace.enabled ? performance.now() : 0
      const user = userMessage()
      // groupTurns() is the single authority for whether a projected user-role
      // row establishes a timeline turn. Host-owned Synthetic roots (special
      // agents, scheduled work, Goal continuations, etc.) are visible automation
      // boundaries even though they are not semantic human-user turns.
      // Re-classifying semantics here creates a contradictory second filter:
      // grouped() can own a valid turn that the row projector then silently erases.
      if (user?.role !== "user") return emptyRows
      const views = assistantViews()
      const assistants = views
        .map((view) => view.message())
        .filter((message): message is AssistantMessage => message?.role === "assistant")
      const active = userMessageID === activeMessageID()
      // Session status is global to the timeline, but only the active turn can
      // render status-dependent rows or use the working structural projection.
      // Read it conditionally so a busy/idle/retry transition does not rebuild
      // every historical turn's rows in a long session.
      const status = active ? input.status().type : "idle"
      const working = active && status !== "idle"
      const structural = assistantViewByID()
      const getParts = working
        ? (messageID: string) => structural.get(messageID)?.structuralParts() ?? input.parts(messageID)
        : input.parts
      const rows = Timeline.constructMessageRows(
        user,
        getParts,
        assistants,
        isFirstTurn() ? 0 : 1,
        input.showReasoningSummaries(),
        input.showSystemInjections(),
        status,
        active,
        input.inlineComments(),
        working ? { reasoningHeading: liveReasoningHeading() } : undefined,
        { showUserMessage: showUserMessage() },
      )
      // Streamed text/reasoning lives in the part store and is consumed by the
      // mounted row component directly; it is deliberately absent from the row
      // descriptor. Stabilize topology HERE, at the turn boundary, so a token
      // that leaves this turn's row keys/metadata unchanged returns the exact
      // same array reference. That prevents the session-wide flatMap,
      // reconciliation, index-map rebuild, and virtualizer topology from waking
      // for content-only deltas.
      const stable = reuseTimelineRows(previous, rows)
      if (phaseTrace.enabled) phaseTrace.row(userMessageID, performance.now() - started)
      return stable
    }, emptyRows)
  })
  const rows = createMemo((previous: TimelineRow.TimelineRow[] | undefined) => {
    const projectedTurnRows = perTurnRows()
    const turnBlocks = grouped().turns.map(
      (turn, index): TimelineBlock => ({
        id: turn.user.id,
        created: turn.user.time.created,
        rows: projectedTurnRows[index]?.() ?? emptyRows,
      }),
    )
    const contextBlocks = contextMessages().map(
      (message): TimelineBlock => ({
        id: message.id,
        created: message.created,
        rows: [
          new TimelineRow.ContextMessage({
            messageID: message.id,
            kind: message.kind,
            preview: message.preview,
            text: message.text,
          }),
        ],
      }),
    )
    return reuseTimelineRows(previous, mergeTimelineBlocks(turnBlocks, contextBlocks))
  })
  // All per-row index maps are built in ONE pass over rows() (five separate
  // memos each iterated the list; a rows-list change happens on every message
  // append, so this is a per-append O(rows) hot path).
  // - messageRowIndex: first row index per message (turn start)
  // - messageRowIndices: all row indices per message (session find scrolls to
  //   the exact row containing a match, not just the turn start)
  const rowIndexMaps = createMemo(() => {
    const rowByKey = new Map<string, TimelineRow.TimelineRow>()
    const rowIndexByKey = new Map<string, number>()
    const messageRowIndex = new Map<string, number>()
    const messageRowIndices = new Map<string, number[]>()
    const messageLastRowIndex = new Map<string, number>()
    const lastAssistantGroupKey = new Map<string, string>()
    rows().forEach((row, index) => {
      const key = TimelineRow.key(row)
      rowByKey.set(key, row)
      rowIndexByKey.set(key, index)
      const id = row._tag === "ContextMessage" ? row.messageID : "userMessageID" in row ? row.userMessageID : undefined
      if (!id) return
      if (!messageRowIndex.has(id)) messageRowIndex.set(id, index)
      const list = messageRowIndices.get(id)
      if (list) list.push(index)
      else messageRowIndices.set(id, [index])
      messageLastRowIndex.set(id, index)
      if (row._tag === "AssistantPart") lastAssistantGroupKey.set(id, row.group.key)
    })
    return { rowByKey, rowIndexByKey, messageRowIndex, messageRowIndices, messageLastRowIndex, lastAssistantGroupKey }
  })
  const rowByKey = createMemo(() => rowIndexMaps().rowByKey)
  const rowIndexByKey = createMemo(() => rowIndexMaps().rowIndexByKey)
  const messageRowIndex = createMemo(() => rowIndexMaps().messageRowIndex)
  const messageRowIndices = createMemo(() => rowIndexMaps().messageRowIndices)
  const messageLastRowIndex = createMemo(() => rowIndexMaps().messageLastRowIndex)
  const lastAssistantGroupKey = createMemo(() => rowIndexMaps().lastAssistantGroupKey)

  return {
    activeMessageID,
    assistantMessagesByParent,
    lastAssistantGroupKey,
    messageByID,
    messageRowIndex,
    messageRowIndices,
    messageLastRowIndex,
    rowByKey,
    rowIndexByKey,
    rows,
  }
}
