import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { createMemo, mapArray, type Accessor } from "solid-js"
import { reuseTimelineRows } from "./row-reconciliation"
import { Timeline, TimelineRow } from "./rows"

export { reuseTimelineRows } from "./row-reconciliation"

const emptyRows: TimelineRow.TimelineRow[] = []
const emptyIDs: string[] = []

function arraysShallowEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
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

  // Fine-grained per-turn row construction. `grouped()` is cheap (a single pass over
  // messages, no part reads) and is expected to rerun on every message-list change.
  // The EXPENSIVE part -- groupParts/markdown-height-estimation/comment parsing inside
  // constructMessageRows -- must not rerun for a turn whose own messages/parts didn't
  // change. Solid store mutations (message.part.delta, message.updated) are applied
  // in place via `produce`/`reconcile`, so array/object REFERENCES stay stable across
  // unrelated updates -- reference diffing can't detect real changes. Instead each turn
  // gets its own `createMemo`, reading messages/parts directly off the store (via
  // `getMessageDirect`/`input.parts`, not through a derived Map that gets rebuilt -- and
  // therefore looks "changed" by reference -- on every message-list event), so Solid's
  // own fine-grained dependency tracking decides which turn actually needs to recompute.
  const grouped = createMemo(() =>
    Timeline.groupTurns(
      input.sessionMessages(),
      (messageID) => messageByID().get(messageID) as UserMessage | AssistantMessage | undefined,
      input.userMessages(),
    ),
  )
  const activeMessageID = createMemo(() => grouped().activeMessageID)
  const turnOrder = createMemo(() => grouped().turns.map((turn) => turn.user.id), emptyIDs, {
    equals: arraysShallowEqual,
  })
  const getMessageDirect = (messageID: string) => input.messages().find((message) => message.id === messageID)

  const perTurnRows = mapArray(turnOrder, (userMessageID) => {
    const assistantIDs = createMemo(
      () => grouped().turns.find((turn) => turn.user.id === userMessageID)?.assistants.map((a) => a.id) ?? emptyIDs,
      emptyIDs,
      { equals: arraysShallowEqual },
    )
    // `getMessageDirect` reads `input.messages().length` (an Array.prototype.find
    // implementation detail), which a new unrelated message anywhere would touch. Wrapping
    // each lookup in its own createMemo with default (reference) equals absorbs that
    // spurious re-run here instead of letting it cascade into the expensive row-construction
    // memo below -- which must only re-execute when THIS turn's own message objects change.
    const userMessage = createMemo(() => getMessageDirect(userMessageID))
    const assistantMessages = mapArray(assistantIDs, (assistantID) => createMemo(() => getMessageDirect(assistantID)))
    const isFirstTurn = createMemo(() => turnOrder()[0] === userMessageID)
    return createMemo<TimelineRow.TimelineRow[]>(() => {
      const user = userMessage()
      if (user?.role !== "user") return emptyRows
      const assistants = assistantMessages()
        .map((get) => get())
        .filter((message): message is AssistantMessage => message?.role === "assistant")
      return Timeline.constructMessageRows(
        user,
        input.parts,
        assistants,
        isFirstTurn() ? 0 : 1,
        input.showReasoningSummaries(),
        input.status().type,
        userMessageID === activeMessageID(),
        input.inlineComments(),
      )
    })
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
    const messageRowIndex = new Map<string, number>()
    const messageRowIndices = new Map<string, number[]>()
    const messageLastRowIndex = new Map<string, number>()
    const lastAssistantGroupKey = new Map<string, string>()
    rows().forEach((row, index) => {
      rowByKey.set(TimelineRow.key(row), row)
      if (!("userMessageID" in row)) return
      const id = row.userMessageID
      if (!messageRowIndex.has(id)) messageRowIndex.set(id, index)
      const list = messageRowIndices.get(id)
      if (list) list.push(index)
      else messageRowIndices.set(id, [index])
      messageLastRowIndex.set(id, index)
      if (row._tag === "AssistantPart") lastAssistantGroupKey.set(id, row.group.key)
    })
    return { rowByKey, messageRowIndex, messageRowIndices, messageLastRowIndex, lastAssistantGroupKey }
  })
  const rowByKey = createMemo(() => rowIndexMaps().rowByKey)
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
    rows,
  }
}
