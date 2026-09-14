import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { createMemo, mapArray, type Accessor } from "solid-js"
import { phaseTrace } from "@/context/phase-trace"
import { reuseTimelineRows } from "./row-reconciliation"
import { Timeline, TimelineRow } from "./rows"
import { projectWorkingAssistantParts, workingAssistantPartsEqual } from "./working-part-structure"

export { reuseTimelineRows } from "./row-reconciliation"

const emptyRows: TimelineRow.TimelineRow[] = []
const emptyIDs: string[] = []
const emptyParts: Part[] = []
type SessionMessageStructure = Pick<SessionMessageInfo, "id" | "type">
const emptySessionMessageStructure: SessionMessageStructure[] = []

function arraysShallowEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

function messageStructureEqual(a: SessionMessageStructure[], b: SessionMessageStructure[]) {
  if (a.length !== b.length) return false
  return a.every((value, index) => value.id === b[index]?.id && value.type === b[index]?.type)
}

export function createTimelineProjection(input: {
  messages: Accessor<Message[]>
  userMessages: Accessor<UserMessage[]>
  sessionMessages: Accessor<SessionMessageInfo[]>
  parts: (messageID: string) => Part[]
  status: Accessor<SessionStatus>
  showReasoningSummaries: Accessor<boolean>
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
      const reasoningHeading = createMemo(() => {
        for (const part of input.parts(assistantID)) {
          if (part.type !== "reasoning" || !part.text) continue
          const heading = Timeline.reasoningHeading(part.text)
          if (heading) return heading
        }
      })
      return { id: assistantID, message, structuralParts, reasoningHeading }
    })
    const assistantViewByID = createMemo(() => new Map(assistantViews().map((view) => [view.id, view] as const)))
    const liveReasoningHeading = createMemo(() => {
      for (const view of assistantViews()) {
        const heading = view.reasoningHeading()
        if (heading) return heading
      }
    })
    const isFirstTurn = createMemo(() => turnOrder()[0] === userMessageID)
    return createMemo<TimelineRow.TimelineRow[]>((previous) => {
      const started = phaseTrace.enabled ? performance.now() : 0
      const user = userMessage()
      if (user?.role !== "user") return emptyRows
      const views = assistantViews()
      const assistants = views
        .map((view) => view.message())
        .filter((message): message is AssistantMessage => message?.role === "assistant")
      const status = input.status().type
      const active = userMessageID === activeMessageID()
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
        status,
        active,
        input.inlineComments(),
        working ? { reasoningHeading: liveReasoningHeading() } : undefined,
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
  const rows = createMemo((previous: TimelineRow.TimelineRow[] | undefined) =>
    reuseTimelineRows(previous, perTurnRows().flatMap((turnRows) => turnRows())),
  )
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
      if (!("userMessageID" in row)) return
      const id = row.userMessageID
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
