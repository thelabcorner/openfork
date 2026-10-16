import type { SessionMessageInfo } from "@/utils/session-message-info"
import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, mapArray, onCleanup, type Accessor } from "solid-js"
import { phaseTrace } from "@/context/phase-trace"
import { reuseTimelineRows, syncTimelineRows } from "./row-reconciliation"
import { clearTimelineRowIndexes, createTimelineRowIndexes, indexTimelineRow, truncateTimelineRowIndexes } from "./row-index"
import {
  contextMessageTimelineRow,
  sessionMessageTimelineDisposition,
  Timeline,
  TimelineRow,
} from "./rows"
import { projectWorkingAssistantParts, workingAssistantPartsEqual } from "./working-part-structure"
import { compareMessages, isStateProjectionMessage, userTurnPresentation } from "@/utils/session-message"
import { sessionStatusIsWorking } from "@/utils/session-status"

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

/** Check tail-only updates without allocating a prefix slice per revision. */
function sameTurnRowPrefix(a: readonly TimelineRow.TimelineRow[][], b: readonly TimelineRow.TimelineRow[][]) {
  if (a.length !== b.length) return false
  for (let i = 0; i + 1 < a.length; i++) if (a[i] !== b[i]) return false
  return true
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
  structureChange?: Accessor<{
    revision: number
    operation: { kind: "append"; message: SessionMessageInfo; messages?: Message[] } | { kind: "reset" }
  }>
  parts: (messageID: string) => Part[]
  status: Accessor<SessionStatus>
  showReasoningSummaries: Accessor<boolean>
  showSystemInjections: Accessor<boolean>
  inlineComments: Accessor<boolean>
}) {
  let messageIndexRevision: number | undefined
  let messageIndexStructureLength: number | undefined
  const messageByID = createMemo<Map<string, Message>>((previous) => {
    const messages = input.messages()
    const structure = input.sessionMessages()
    const change = input.structureChange?.()
    if (
      previous &&
      change?.operation.kind === "append" &&
      messageIndexRevision !== undefined &&
      change.revision === messageIndexRevision + 1 &&
      messageIndexStructureLength !== undefined &&
      structure.length === messageIndexStructureLength + 1 &&
      structure.at(-1)?.id === change.operation.message.id
    ) {
      const tail = messages.at(-1)
      for (const message of change.operation.messages ?? []) {
        const current = tail?.id === message.id ? tail : message
        previous.set(current.id, current)
      }
      messageIndexRevision = change.revision
      messageIndexStructureLength = structure.length
      return previous
    }
    phaseTrace.projectionScan("messages", messages.length)
    messageIndexRevision = change?.revision
    messageIndexStructureLength = structure.length
    return new Map(messages.map((message) => [message.id, message] as const))
  }, new Map(), { equals: false })
  let assistantIndexRevision: number | undefined
  let assistantIndexStructureLength: number | undefined
  let assistantParentByID = new Map<string, string>()
  const assistantMessagesByParent = createMemo<Map<string, AssistantMessage[]>>((previous) => {
    const messages = input.messages()
    const structure = input.sessionMessages()
    const change = input.structureChange?.()
    if (
      previous &&
      change?.operation.kind === "append" &&
      assistantIndexRevision !== undefined &&
      change.revision === assistantIndexRevision + 1 &&
      assistantIndexStructureLength !== undefined &&
      structure.length === assistantIndexStructureLength + 1 &&
      structure.at(-1)?.id === change.operation.message.id
    ) {
      const tail = messages.at(-1)
      for (const message of change.operation.messages ?? []) {
        const current = tail?.id === message.id ? tail : message
        const oldParent = assistantParentByID.get(current.id)
        if (oldParent) {
          const siblings = previous.get(oldParent)
          const index = siblings?.findIndex((item) => item.id === current.id) ?? -1
          if (siblings && index >= 0) siblings.splice(index, 1)
          if (siblings?.length === 0) previous.delete(oldParent)
        }
        assistantParentByID.delete(current.id)
        if (current.role !== "assistant") continue
        const siblings = previous.get(current.parentID)
        if (siblings) siblings.push(current)
        else previous.set(current.parentID, [current])
        assistantParentByID.set(current.id, current.parentID)
      }
      assistantIndexRevision = change.revision
      assistantIndexStructureLength = structure.length
      return previous
    }
    const result = new Map<string, AssistantMessage[]>()
    assistantParentByID = new Map()
    phaseTrace.projectionScan("assistant-parents", messages.length)
    messages.forEach((message) => {
      if (message.role !== "assistant") return
      assistantParentByID.set(message.id, message.parentID)
      const messages = result.get(message.parentID)
      if (messages) {
        messages.push(message)
        return
      }
      result.set(message.parentID, [message])
    })
    assistantIndexRevision = change?.revision
    assistantIndexStructureLength = structure.length
    return result
  }, new Map(), { equals: false })
  // Turn membership depends only on ordered message identity/type plus the
  // normalized Message lookup below. Streaming text/reasoning/tool deltas replace
  // one SessionMessageInfo object per token, but they do not change either of
  // these structural fields. Solid's store tracks `id`/`type` at property
  // granularity, so this memo stays asleep for content-only replacements; the
  // explicit equality guard also protects non-store/accessor callers that hand
  // us a fresh but structurally identical array. This removes an O(history)
  // groupTurns pass from the per-token renderer path.
  let structuralRevision: number | undefined
  const structuralMessages = createMemo<SessionMessageStructure[]>(
    (previous = emptySessionMessageStructure) => {
      const messages = input.sessionMessages()
      const change = input.structureChange?.()
      const contiguousAppend =
        !!change &&
        change.operation.kind === "append" &&
        structuralRevision !== undefined &&
        change.revision === structuralRevision + 1 &&
        messages.length === previous.length + 1 &&
        messages.at(-1)?.id === change.operation.message.id
      if (contiguousAppend) {
        if (!change || change.operation.kind !== "append") return previous
        previous.push({ id: change.operation.message.id, type: change.operation.message.type })
        structuralRevision = change.revision
        return previous
      }
      structuralRevision = change?.revision
      phaseTrace.projectionScan("session-structure", messages.length)
      return messages.map((message): SessionMessageStructure => ({ id: message.id, type: message.type }))
    },
    emptySessionMessageStructure,
    { equals: false },
  )
  let contextRevision: number | undefined
  let contextSourceLength: number | undefined
  const contextMessages = createMemo<ContextMessageStructure[]>(
    (previous = emptyContextMessageStructure) => {
      const messages = input.sessionMessages()
      const change = input.structureChange?.()
      if (
        change &&
        change.operation.kind === "append" &&
        contextRevision !== undefined &&
        change.revision === contextRevision + 1 &&
        contextSourceLength !== undefined &&
        messages.length === contextSourceLength + 1 &&
        messages.at(-1)?.id === change.operation.message.id
      ) {
        const row = contextMessageTimelineRow(change.operation.message)
        if (!row) {
          contextRevision = change.revision
          contextSourceLength = messages.length
          return previous
        }
        const next = {
          id: change.operation.message.id,
          created: change.operation.message.time.created,
          kind: row.kind,
          preview: row.preview,
          text: row.text,
        }
        const tail = previous.at(-1)
        if (!tail || blockBeforeOrEqual(tail, next)) {
          contextRevision = change.revision
          contextSourceLength = messages.length
          return [...previous, next]
        }
      }
      contextRevision = change?.revision
      contextSourceLength = messages.length
      phaseTrace.projectionScan("context-structure", messages.length)
      return messages.flatMap((message): ContextMessageStructure[] => {
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
      })
    },
    emptyContextMessageStructure,
    { equals: false },
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
  let groupedRevision: number | undefined
  const grouped = createMemo<ReturnType<typeof Timeline.groupTurns>>((previous) => {
    const structure = structuralMessages()
    const change = input.structureChange?.()
    const users = input.userMessages()
    const message = change?.operation.kind === "append" ? change.operation.message : undefined
    const contiguous =
      !!previous &&
      !!message &&
      groupedRevision !== undefined &&
      change?.revision === groupedRevision + 1 &&
      structure.length > 0 &&
      structure.at(-1)?.id === message.id
    if (contiguous && change?.operation.kind === "append" && message) {
      groupedRevision = change?.revision
      const projected = messageByID().get(message.id) as UserMessage | AssistantMessage | undefined
      if (message.type === "assistant") {
        if (projected?.role !== "assistant") return previous
        const turn = previous.turnByUserID.get(projected.parentID)
        if (!turn) return rebuildGroups(structure, users)
        turn.assistants.push(projected)
        return { ...previous }
      }
      if (message.type === "user" || message.type === "synthetic" || message.type === "shell") {
        if (projected?.role !== "user") return previous
        if (message.type !== "shell" && isStateProjectionMessage(projected)) return previous
        const tail = previous.turns.at(-1)
        if (tail && compareMessages(tail.user, projected) > 0) return rebuildGroups(structure, users)
        const existing = previous.turnByUserID.get(projected.id)
        if (existing) return rebuildGroups(structure, users)
        const assistants =
          message.type === "shell"
            ? [messageByID().get(`${message.id}:assistant`) as AssistantMessage | undefined].filter(
                (item): item is AssistantMessage => item?.role === "assistant",
              )
            : []
        const presentation = userTurnPresentation(projected)
        const turn = {
          user: projected,
          assistants,
          showUserMessage: message.type === "shell" || presentation === "user" || presentation === "host" || presentation === "synthetic",
        }
        previous.turns.push(turn)
        previous.turnByUserID.set(projected.id, turn)
        return { ...previous, activeMessageID: projected.id }
      }
      return previous
    }
    return rebuildGroups(structure, users)
  })
  function rebuildGroups(structure: SessionMessageStructure[], users: UserMessage[]) {
    const started = phaseTrace.enabled ? performance.now() : 0
    phaseTrace.projectionScan("group-turns", structure.length)
    const result = Timeline.groupTurns(
      structure,
      (messageID) => messageByID().get(messageID) as UserMessage | AssistantMessage | undefined,
      users,
    )
    const change = input.structureChange?.()
    groupedRevision = change?.revision
    if (phaseTrace.enabled) phaseTrace.projection(performance.now() - started, result.turns.length)
    return result
  }
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
    // A message append updates the indexed lookup once, so these tiny lookups
    // wake but remain O(1); reference equality prevents unchanged messages from
    // propagating into row construction. The previous implementation used
    // `messages.find(id)` here: every append woke every turn and each lookup
    // rescanned the whole session, making structural growth O(turns × messages).
    const userMessage = createMemo(() => messageByID().get(userMessageID))
    // Legacy V1 can announce a user-message shell before the current Prompted
    // event carries its body. Do not put a zero-height placeholder in the
    // virtualizer: it immediately changes size when the authoritative text
    // arrives and can trigger ResizeObserver feedback with auto-scroll. Parts
    // are already loaded for the visible timeline; this stays turn-local and
    // does not hydrate history or scan other turns.
    const showUserMessage = createMemo(() => {
      if (grouped().turnByUserID.get(userMessageID)?.showUserMessage === false) return false
      return input.parts(userMessageID).some((part) => {
        if (part.type === "text") return !!part.text.trim()
        return part.type === "file" || part.type === "agent"
      })
    })
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
      const working = active && sessionStatusIsWorking(status)
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
  // Keep the public timeline and lookup maps in place. A normal contiguous
  // append changes only the final turn, but flattening/reconciling all prior
  // turns and rebuilding every index made history seeding O(turns * rows).
  // Non-tail updates, context rows, resets, and any missed revision still use
  // the authoritative full rebuild below.
  const timelineRows: TimelineRow.TimelineRow[] = []
  const rowIndexes = createTimelineRowIndexes()
  const { rowByKey, rowIndexByKey, messageRowIndex, messageRowIndices, messageLastRowIndex, lastAssistantGroupKey } = rowIndexes
  const [rowsRevision, setRowsRevision] = createSignal(0)
  const [indexesRevision, setIndexesRevision] = createSignal(0)
  let indexedStructureRevision: number | undefined
  let indexedTurnCount = 0
  let lastTurnStart = 0
  let lastTurnLength = 0
  let indexedTurnRows: TimelineRow.TimelineRow[][] = []
  let indexedContexts: ContextMessageStructure[] | undefined

  function indexRow(row: TimelineRow.TimelineRow, index: number) {
    indexTimelineRow(rowIndexes, row, index)
  }

  function replaceTailRows(start: number, replacement: TimelineRow.TimelineRow[]) {
    const previousLength = timelineRows.length
    phaseTrace.rowIndex("tail-update", (previousLength - start) + replacement.length)
    truncateTimelineRowIndexes(rowIndexes, timelineRows, start)
    timelineRows.length = start
    for (const row of replacement) timelineRows.push(row)
    for (let index = start; index < timelineRows.length; index++) indexRow(timelineRows[index]!, index)
    lastTurnStart = start
    lastTurnLength = replacement.length
  }

  function rebuildIndexes() {
    clearTimelineRowIndexes(rowIndexes)
    phaseTrace.rowIndex("full-rebuild", timelineRows.length)
    timelineRows.forEach(indexRow)
  }

  const rows = createMemo<TimelineRow.TimelineRow[]>(() => {
    // Reading all three owners tracks topology, while per-turn row memos keep
    // content-only updates local to the turn that owns them.
    const turnRows = perTurnRows()
    // Keep dependencies on every turn memo. The values are stable for turns
    // whose own parts did not change; this small identity pass lets an older
    // turn replacement, setting change, or status correction invalidate the
    // materialized list and take the safe rebuild path.
    const projectedTurnRows = turnRows.map((readRows) => readRows())
    const turns = grouped().turns
    const contexts = contextMessages()
    const change = input.structureChange?.()
    const contiguousAppend =
      change?.operation.kind === "append" &&
      indexedStructureRevision !== undefined &&
      change.revision === indexedStructureRevision + 1 &&
      turns.length > 0 &&
      lastTurnLength > 0 &&
      lastTurnStart + lastTurnLength === timelineRows.length

    if (contiguousAppend && change.operation.kind === "append") {
      const message = change.operation.message
      const lastTurn = turns.at(-1)!
      const previousTurn = turns.at(-2)
      const chronologicalTail = !previousTurn || compareMessages(previousTurn.user, lastTurn.user) <= 0
      const isNewRoot =
        (message.type === "user" || message.type === "synthetic" || message.type === "shell") &&
        message.id === lastTurn.user.id &&
        chronologicalTail &&
        turns.length === indexedTurnCount + 1
      const projected = messageByID().get(message.id)
      const isTailAssistant =
        message.type === "assistant" &&
        projected?.role === "assistant" &&
        projected.parentID === lastTurn.user.id &&
        turns.length === indexedTurnCount
      if (isNewRoot || isTailAssistant) {
        const start = isNewRoot ? timelineRows.length : lastTurnStart
        const replacement = projectedTurnRows.at(-1) ?? emptyRows
        replaceTailRows(start, replacement)
        indexedTurnCount = turns.length
        indexedStructureRevision = change.revision
        indexedTurnRows = projectedTurnRows
        indexedContexts = contexts
        setRowsRevision((value) => value + 1)
        setIndexesRevision((value) => value + 1)
        return timelineRows
      }
    }

    // Completion/retry/status changes can revise the final turn's row hints
    // without changing message structure. Keep those updates local too. A
    // setting toggle, historical replacement, or any earlier-turn change
    // fails this identity proof and takes the full rebuild below.
    const onlyTailRowsChanged =
      change?.revision === indexedStructureRevision &&
      turns.length > 0 &&
      turns.length === indexedTurnCount &&
      contexts === indexedContexts &&
      lastTurnStart + lastTurnLength === timelineRows.length &&
      indexedTurnRows.length === projectedTurnRows.length &&
      projectedTurnRows.at(-1) !== indexedTurnRows.at(-1) &&
      sameTurnRowPrefix(projectedTurnRows, indexedTurnRows)
    if (onlyTailRowsChanged) {
      replaceTailRows(lastTurnStart, projectedTurnRows.at(-1) ?? emptyRows)
      indexedTurnRows = projectedTurnRows
      setRowsRevision((value) => value + 1)
      setIndexesRevision((value) => value + 1)
      return timelineRows
    }

    const turnBlocks = turns.map(
      (turn, index): TimelineBlock => ({
        id: turn.user.id,
        created: turn.user.time.created,
        rows: projectedTurnRows[index] ?? emptyRows,
      }),
    )
    const contextBlocks = contexts.map(
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
    const next = reuseTimelineRows(timelineRows, mergeTimelineBlocks(turnBlocks, contextBlocks))
    syncTimelineRows(timelineRows, next)
    rebuildIndexes()
    const lastTurn = turns.at(-1)
    lastTurnLength = lastTurn ? turnBlocks.at(-1)?.rows.length ?? 0 : 0
    lastTurnStart = lastTurn ? timelineRows.length - lastTurnLength : 0
    indexedTurnCount = turns.length
    indexedStructureRevision = change?.revision
    indexedTurnRows = projectedTurnRows
    indexedContexts = contexts
    setRowsRevision((value) => value + 1)
    setIndexesRevision((value) => value + 1)
    return timelineRows
  }, emptyRows, { equals: false })

  // The backing Maps are deliberately stable so append updates touch only the
  // tail. Reading the revision inside each accessor still invalidates Solid
  // consumers after a mutation; returning a same-identity Map through a memo
  // would suppress that notification.
  const rowByKeyValue = () => (rowsRevision(), rowByKey)
  const rowIndexByKeyValue = () => (rowsRevision(), rowIndexByKey)
  const messageRowIndexValue = () => (indexesRevision(), messageRowIndex)
  const messageRowIndicesValue = () => (indexesRevision(), messageRowIndices)
  const messageLastRowIndexValue = () => (indexesRevision(), messageLastRowIndex)
  const lastAssistantGroupKeyValue = () => (indexesRevision(), lastAssistantGroupKey)

  return {
    activeMessageID,
    assistantMessagesByParent,
    lastAssistantGroupKey: lastAssistantGroupKeyValue,
    messageByID,
    messageRowIndex: messageRowIndexValue,
    messageRowIndices: messageRowIndicesValue,
    messageLastRowIndex: messageLastRowIndexValue,
    rowByKey: rowByKeyValue,
    rowIndexByKey: rowIndexByKeyValue,
    rows,
  }
}
