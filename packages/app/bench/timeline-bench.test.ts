/**
 * Manual benchmark for the session timeline hot paths (NOT part of test
 * discovery; run explicitly: `bun test bench/timeline-bench.test.ts`).
 *
 * Benchmarks the pure algorithmic cores with realistic message volumes so
 * optimization candidates can be raced head-to-head before landing.
 */
import { describe, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { Message, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"

// rows.ts -> @opencode-ai/session-ui/message-part -> markdown.tsx -> a Vite
// ?worker&url import that bun cannot resolve. Provide the tiny pure functions
// rows.ts actually consumes (verbatim copies of the source) instead.
const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list"])
const HIDDEN_TOOLS = new Set(["todowrite"])
mock.module("@opencode-ai/session-ui/message-part", () => ({
  renderable: (
    part: { type: string; tool?: string; text?: string; state?: { status?: string } },
    showReasoningSummaries = true,
  ) => {
    if (part.type === "tool") {
      if (HIDDEN_TOOLS.has(part.tool!)) return false
      if (part.tool === "question") return part.state?.status !== "pending" && part.state?.status !== "running"
      return true
    }
    if (part.type === "text") return !!part.text?.trim()
    if (part.type === "reasoning") return showReasoningSummaries && !!part.text?.trim()
    return part.type === "step-start" || part.type === "step-finish"
  },
  groupParts: (parts: Array<{ messageID: string; part: { id: string; type?: string; tool?: string } }>) => {
    const result: Array<{
      type: "context" | "part"
      key: string
      ref?: { messageID: string; partID: string }
      refs?: Array<{ messageID: string; partID: string }>
    }> = []
    let start = -1
    const flush = (end: number) => {
      if (start < 0) return
      const first = parts[start]
      const last = parts[end]
      if (!first || !last) {
        start = -1
        return
      }
      result.push({
        key: `context:${first.part.id}`,
        type: "context",
        refs: parts.slice(start, end + 1).map((item) => ({ messageID: item.messageID, partID: item.part.id })),
      })
      start = -1
    }
    parts.forEach((item, index) => {
      if (item.part.type === "tool" && CONTEXT_GROUP_TOOLS.has(item.part.tool!)) {
        if (start < 0) start = index
        return
      }
      flush(index - 1)
      result.push({
        key: `part:${item.messageID}:${item.part.id}`,
        type: "part",
        ref: { messageID: item.messageID, partID: item.part.id },
      })
    })
    flush(parts.length - 1)
    return result
  },
}))

const { Timeline, TimelineRow } = await import("../src/pages/session/timeline/rows")
const { reuseTimelineRows } = await import("../src/pages/session/timeline/row-reconciliation")
const { createTimelineProjection } = await import("../src/pages/session/timeline/projection")

let counter = 0
function makePart(id: string, text: string): Part {
  return { id, type: "text", text, messageID: `msg_${id}` } as Part
}

function makeTurn(index: number, textLen: number): {
  sessionInfo: SessionMessageInfo
  user: UserMessage
  assistantInfo: SessionMessageInfo
  assistant: Message
  userParts: Part[]
  assistantParts: Part[]
} {
  const userID = `user_${index}`
  const assistantID = `assistant_${index}`
  const userText = `question ${index}: ${"the quick brown fox jumps over the lazy dog ".repeat(Math.max(1, textLen / 46))}`
  const answerText = `answer ${index}: ${"The quick brown fox jumps over the lazy dog and then runs away from the village. ".repeat(
    Math.max(1, textLen / 90),
  )}`
  const user = {
    id: userID,
    sessionID: "ses_1",
    role: "user",
    time: { created: index * 1000 },
    agent: "build",
    model: { modelID: "model", providerID: "provider" },
  } as unknown as UserMessage
  const assistant = {
    id: assistantID,
    sessionID: "ses_1",
    role: "assistant",
    parentID: userID,
    agent: "build",
    model: { modelID: "model", providerID: "provider" },
    time: { created: index * 1000 + 1, completed: index * 1000 + 2000 },
  } as unknown as Message
  return {
    sessionInfo: { id: userID, type: "user", time: { created: index * 1000 } },
    user,
    assistantInfo: { id: assistantID, type: "assistant", time: { created: index * 1000 + 1 } },
    assistant,
    userParts: [makePart(`${userID}:text`, userText)],
    assistantParts: [
      makePart(`${assistantID}:text`, answerText),
      makePart(`${assistantID}:reasoning`, "reasoning about the problem at hand"),
    ],
  }
}

const TURNS = 400
const partsByMessage = new Map<string, Part[]>()
const messagesByID = new Map<string, Message>()
const sessionInfos: SessionMessageInfo[] = []
const allUsers: UserMessage[] = []
const allMessages: Message[] = []
for (let i = 0; i < TURNS; i++) {
  const turn = makeTurn(i, 240)
  sessionInfos.push(turn.sessionInfo, turn.assistantInfo)
  partsByMessage.set(turn.user.id, turn.userParts)
  partsByMessage.set(turn.assistant.id, turn.assistantParts)
  messagesByID.set(turn.user.id, turn.user)
  messagesByID.set(turn.assistant.id, turn.assistant)
  allUsers.push(turn.user)
  allMessages.push(turn.user, turn.assistant)
}

function buildRows() {
  return Timeline.constructSessionMessageRows(
    sessionInfos,
    (id) => messagesByID.get(id) as UserMessage | undefined,
    (id) => partsByMessage.get(id) ?? [],
    true,
    "idle",
    true,
    allUsers,
  ).rows
}

function fivePassMaps(rows: TimelineRow.TimelineRow[]) {
  const rowByKey = new Map(rows.map((row) => [TimelineRow.key(row), row] as const))
  const messageRowIndex = new Map<string, number>()
  const messageRowIndices = new Map<string, number[]>()
  const messageLastRowIndex = new Map<string, number>()
  const lastAssistantGroupKey = new Map<string, string>()
  rows.forEach((row, index) => {
    if (!("userMessageID" in row)) return
    if (!messageRowIndex.has(row.userMessageID)) messageRowIndex.set(row.userMessageID, index)
    const list = messageRowIndices.get(row.userMessageID)
    if (list) list.push(index)
    else messageRowIndices.set(row.userMessageID, [index])
    messageLastRowIndex.set(row.userMessageID, index)
    if (row._tag === "AssistantPart") lastAssistantGroupKey.set(row.userMessageID, row.group.key)
  })
  return { rowByKey, messageRowIndex, messageRowIndices, messageLastRowIndex, lastAssistantGroupKey }
}

function mergedPassMaps(rows: TimelineRow.TimelineRow[]) {
  const rowByKey = new Map<string, TimelineRow.TimelineRow>()
  const messageRowIndex = new Map<string, number>()
  const messageRowIndices = new Map<string, number[]>()
  const messageLastRowIndex = new Map<string, number>()
  const lastAssistantGroupKey = new Map<string, string>()
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    rowByKey.set(TimelineRow.key(row), row)
    if (!("userMessageID" in row)) continue
    const id = row.userMessageID
    if (!messageRowIndex.has(id)) messageRowIndex.set(id, index)
    const list = messageRowIndices.get(id)
    if (list) list.push(index)
    else messageRowIndices.set(id, [index])
    messageLastRowIndex.set(id, index)
    if (row._tag === "AssistantPart") lastAssistantGroupKey.set(id, row.group.key)
  }
  return { rowByKey, messageRowIndex, messageRowIndices, messageLastRowIndex, lastAssistantGroupKey }
}

const keyCache = new WeakMap<TimelineRow.TimelineRow, string>()
function cachedKey(row: TimelineRow.TimelineRow): string {
  let key = keyCache.get(row)
  if (key === undefined) {
    key = TimelineRow.key(row)
    keyCache.set(row, key)
  }
  return key
}

function deriveTextCurrent(row: TimelineRow.TimelineRow, getParts: (id: string) => Part[]): string | undefined {
  if (row._tag === "UserMessage") {
    const parts = getParts(row.userMessageID)
    return (
      parts
        .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !!part.text)
        .map((part) => part.text)
        .join("\n") || undefined
    )
  }
  if (row._tag === "AssistantPart" && row.group.type === "part") {
    const part = getParts(row.group.ref.messageID).find((p) => p.id === row.group.ref.partID)
    if (part?.type === "text" && part.text) return part.text
  }
  return undefined
}

function deriveTextValidated(
  row: TimelineRow.TimelineRow,
  getParts: (id: string) => Part[],
  cache: WeakMap<TimelineRow.TimelineRow, { texts: (string | undefined)[]; text: string | undefined }>,
): string | undefined {
  if (row._tag === "UserMessage") {
    const parts = getParts(row.userMessageID)
    const cached = cache.get(row)
    if (cached && cached.texts.length === parts.length) {
      let same = true
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!
        const text = part.type === "text" ? part.text : undefined
        if (text !== cached.texts[i]) {
          same = false
          break
        }
      }
      if (same) return cached.text
    }
    let text: string | undefined
    const partsText: (string | undefined)[] = []
    for (const part of parts) {
      partsText.push(part.type === "text" ? part.text : undefined)
      if (part.type === "text" && part.text) text = text === undefined ? part.text : `${text}\n${part.text}`
    }
    const entry = { texts: partsText, text: text || undefined }
    cache.set(row, entry)
    return entry.text
  }
  if (row._tag === "AssistantPart" && row.group.type === "part") {
    const part = getParts(row.group.ref.messageID).find((p) => p.id === row.group.ref.partID)
    if (part?.type === "text" && part.text) return part.text
  }
  return undefined
}

function contentHash(text: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function observeCurrent(history: Map<string, number>, type: string, text: string, width: number, height: number) {
  if (!text) return
  const key = `${type}:${contentHash(text)}:${Math.floor(width / 64)}`
  const previous = history.get(key)
  if (previous !== undefined) {
    history.set(key, previous + height)
    return
  }
  history.set(key, height)
}

function observeSkipStreaming(history: Map<string, number>, type: string, text: string, width: number, height: number) {
  if (!text) return
  const key = `${type}:${contentHash(text)}:${Math.floor(width / 64)}`
  const previous = history.get(key)
  if (previous !== undefined) {
    history.set(key, previous + height)
    return
  }
  history.set(key, height)
}

const timed = (name: string, iterations: number, fn: () => void) => {
  fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  const elapsed = (performance.now() - start) / iterations
  console.log(`  ${name.padEnd(52)} ${elapsed.toFixed(3)} ms/iter`)
  return elapsed
}

describe("timeline hot-path benchmark", () => {
  test("run", () => {
    const rows = buildRows()
    console.log(`fixture: ${TURNS} turns, ${rows.length} rows\n`)

    console.log("--- 1. row index map passes (1500 rows) ---")
    timed("5 separate passes", 100, () => fivePassMaps(rows))
    timed("1 merged pass", 100, () => mergedPassMaps(rows))

    console.log("\n--- 2. TimelineRow.key (concat vs WeakMap) x100k ---")
    timed("raw concat", 100, () => {
      for (let i = 0; i < 100_000; i++) TimelineRow.key(rows[i % rows.length]!)
    })
    timed("WeakMap cached", 100, () => {
      for (let i = 0; i < 100_000; i++) cachedKey(rows[i % rows.length]!)
    })

    console.log("\n--- 3. estimateInput text derivation (60 rows x 200 calls) ---")
    const estRows = rows.slice(0, 60)
    timed("current (filter+map+join per call)", 30, () => {
      for (let i = 0; i < 200; i++) {
        const row = estRows[i % estRows.length]!
        deriveTextCurrent(row, (id) => partsByMessage.get(id) ?? [])
      }
    })
    const validatedCache = new WeakMap<
      TimelineRow.TimelineRow,
      { texts: (string | undefined)[]; text: string | undefined }
    >()
    timed("validated cache (pointer compare)", 30, () => {
      for (let i = 0; i < 200; i++) {
        const row = estRows[i % estRows.length]!
        deriveTextValidated(row, (id) => partsByMessage.get(id) ?? [], validatedCache)
      }
    })

    console.log("\n--- 4. streaming observe (500 deltas, text grows to 20k chars) ---")
    timed("current (hash per delta)", 20, () => {
      const history = new Map<string, number>()
      let text = ""
      for (let i = 0; i < 500; i++) {
        text += "the quick brown fox jumps over the lazy dog, "
        observeCurrent(history, "assistant-text", text, 800, 22.4)
      }
    })
    timed("skip hash while streaming", 20, () => {
      const history = new Map<string, number>()
      let text = ""
      for (let i = 0; i < 500; i++) {
        text += "the quick brown fox jumps over the lazy dog, "
        observeSkipStreaming(history, "assistant-text", "", 800, 22.4)
      }
    })

    console.log("\n--- 5. reuseTimelineRows (1500 rows, 100 append cycles of 5 rows) ---")
    timed("reconcile per append cycle", 20, () => {
      let previous = rows
      let next = rows
      for (let cycle = 0; cycle < 100; cycle++) {
        const extra: TimelineRow.TimelineRow[] = []
        for (let i = 0; i < 5; i++) {
          counter += 1
          const id = `appended_${counter}`
          extra.push(
            new TimelineRow.TurnGap({ userMessageID: id }),
            new TimelineRow.UserMessage({ userMessageID: id, anchor: true }),
          )
        }
        next = [...next, ...extra]
        previous = reuseTimelineRows(previous, next)
      }
    })

    console.log("\n--- 5b. per-append full-session derived maps (copy part + turn duration) ---")
    const turnByParent = (() => {
      const result = new Map<string, Message[]>()
      for (const message of allMessages) {
        if (message.role !== "assistant") continue
        const list = result.get(message.parentID!)
        if (list) list.push(message)
        else result.set(message.parentID!, [message])
      }
      return result
    })()
    const fullSessionCopyParts = () => {
      const result = new Map<string, string>()
      for (const [userMessageID, messages] of turnByParent) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const part = (partsByMessage.get(messages[i]!.id) ?? []).findLast(
            (item) => item.type === "text" && !!item.text?.trim(),
          )
          if (part?.type === "text") {
            result.set(userMessageID, part.id)
            break
          }
        }
      }
      return result
    }
    const fullSessionDurations = () => {
      const result = new Map<string, number>()
      for (const [userMessageID, messages] of turnByParent) {
        const message = messagesByID.get(userMessageID)
        if (!message || message.role !== "user") continue
        let end: number | undefined
        for (const item of messages) {
          const completed = item.time.completed
          if (typeof completed === "number" && (end === undefined || completed > end)) end = completed
        }
        if (end !== undefined && end >= message.time.created) result.set(userMessageID, end - message.time.created)
      }
      return result
    }
    timed("copy-part map + duration map (800 messages, 1 append)", 100, () => {
      fullSessionCopyParts()
      fullSessionDurations()
    })

    console.log("\n--- 6. full projection (solid memos, 400 turns) ---")
    timed("initial build", 20, () => buildRows())

    timed("100 reactive appends", 5, () => {
      createRoot((dispose) => {
        const [messages, setMessages] = createSignal<Message[]>([...allMessages])
        const [infos, setInfos] = createSignal<SessionMessageInfo[]>([...sessionInfos])
        const [users, setUsers] = createSignal<UserMessage[]>([...allUsers])
        const [status, setStatus] = createSignal<SessionStatus>({ type: "idle", sessionID: "ses_1" })
        const projection = createTimelineProjection({
          messages,
          userMessages: users,
          sessionMessages: infos,
          parts: (id) => partsByMessage.get(id) ?? [],
          status,
          showReasoningSummaries: () => true,
          inlineComments: () => true,
        })
        projection.rows()
        for (let i = TURNS; i < TURNS + 100; i++) {
          const turn = makeTurn(i, 240)
          partsByMessage.set(turn.user.id, turn.userParts)
          partsByMessage.set(turn.assistant.id, turn.assistantParts)
          messagesByID.set(turn.user.id, turn.user)
          messagesByID.set(turn.assistant.id, turn.assistant)
          allUsers.push(turn.user)
          allMessages.push(turn.user, turn.assistant)
          sessionInfos.push(turn.sessionInfo, turn.assistantInfo)
          setMessages([...allMessages])
          setInfos([...sessionInfos])
          setUsers([...allUsers])
          projection.rows()
        }
        dispose()
      })
    })
  })
})