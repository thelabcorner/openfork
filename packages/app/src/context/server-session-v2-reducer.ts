import type { OpenCodeEvent, SessionMessageInfo, SessionPendingMessage } from "@opencode-ai/client/promise"
import type * as SessionEvent from "@opencode-ai/schema/session-event"

type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>
type Compaction = Extract<SessionMessageInfo, { type: "compaction" }>
type Shell = Extract<SessionMessageInfo, { type: "shell" }>

type StreamIndex = {
  byID: Map<string, number>
  content: Map<
    string,
    {
      text: number[]
      reasoning: number[]
      tools: Map<string, number>
    }
  >
  runningCompaction?: number
}

type StreamContentIDs = {
  text: Map<string, number>
  reasoning: Map<string, number>
}

// `/api/event` carries the schema's encoded JSON representation. In
// particular DateTimeUtcFromMillis is a number on the wire, not DateTime.Utc.
type ReducerEvent = OpenCodeEvent | typeof SessionEvent.All.Encoded

const MAX_STREAM_INDEXES = 256

type IncrementalReduction =
  | {
      kind: "assistant-content"
      index: number
      messageID: string
      partID: string
      partIndex: number
      content: Assistant["content"][number]
    }
  | {
      kind: "message"
      index: number
      message: SessionMessageInfo
    }

export type V2SessionReduction =
  | {
      kind: "unchanged"
      sessionID: string
      touched: string[]
      missing?: string
      messages?: never
      incremental?: never
    }
  | {
      kind: "messages"
      sessionID: string
      messages: SessionMessageInfo[]
      touched: string[]
      missing?: string
      incremental?: IncrementalReduction
    }

export function createV2SessionReducer() {
  const pending = new Map<string, SessionPendingMessage>()
  const indexes = new Map<string, StreamIndex>()
  // The compatibility HTTP history model predates explicit textID/reasoningID
  // fields, while the current native stream is keyed by those IDs. Keep the
  // tiny ID -> legacy ordinal bridge out-of-band instead of inflating every
  // historical content entry. It is bounded with the same session policy as
  // the stream indexes and rebuilt lazily after hydration/reconnect.
  const streamIDs = new Map<string, Map<string, StreamContentIDs>>()

  const rememberIndex = (sessionID: string, index: StreamIndex) => {
    indexes.delete(sessionID)
    indexes.set(sessionID, index)
    while (indexes.size > MAX_STREAM_INDEXES) {
      const oldest = indexes.keys().next().value
      if (oldest === undefined) break
      indexes.delete(oldest)
    }
  }

  const idsFor = (sessionID: string, messageID: string) => {
    let session = streamIDs.get(sessionID)
    if (!session) {
      session = new Map()
      streamIDs.set(sessionID, session)
      while (streamIDs.size > MAX_STREAM_INDEXES) {
        const oldest = streamIDs.keys().next().value
        if (oldest === undefined) break
        streamIDs.delete(oldest)
      }
    } else {
      streamIDs.delete(sessionID)
      streamIDs.set(sessionID, session)
    }
    let ids = session.get(messageID)
    if (!ids) {
      ids = { text: new Map(), reasoning: new Map() }
      session.set(messageID, ids)
    }
    return ids
  }

  const bindStreamID = (
    source: readonly SessionMessageInfo[],
    sessionID: string,
    messageID: string,
    type: "text" | "reasoning",
    id: string,
    preferExistingTail = false,
  ) => {
    // Known IDs are the token-rate path. Avoid LRU delete/reinsert churn for
    // every fragment; touching is only needed when creating a new binding.
    const known = streamIDs.get(sessionID)?.get(messageID)?.[type].get(id)
    if (known !== undefined) return known
    const ids = idsFor(sessionID, messageID)[type]
    const assistant = source.find((item): item is Assistant => item.id === messageID && item.type === "assistant")
    if (!assistant) return undefined
    let ordinal = 0
    let last = -1
    for (const content of assistant.content) {
      if (content.type !== type) continue
      last = ordinal++
    }
    const resolved = preferExistingTail && last >= 0 ? last : ordinal
    ids.set(id, resolved)
    return resolved
  }

  const streamOrdinal = (
    source: readonly SessionMessageInfo[],
    sessionID: string,
    messageID: string,
    type: "text" | "reasoning",
    id: string,
  ) => bindStreamID(source, sessionID, messageID, type, id, true)

  const forgetStreamID = (
    sessionID: string,
    messageID: string,
    type: "text" | "reasoning",
    id: string,
  ) => {
    const session = streamIDs.get(sessionID)
    const message = session?.get(messageID)
    if (!session || !message) return
    message[type].delete(id)
    if (message.text.size > 0 || message.reasoning.size > 0) return
    session.delete(messageID)
    if (session.size === 0) streamIDs.delete(sessionID)
  }

  const forgetMessageStreamIDs = (sessionID: string, messageID: string) => {
    const session = streamIDs.get(sessionID)
    if (!session) return
    session.delete(messageID)
    if (session.size === 0) streamIDs.delete(sessionID)
  }

  const reduce = (source: readonly SessionMessageInfo[], event: ReducerEvent): V2SessionReduction | undefined => {
    if (!("data" in event) || !("sessionID" in event.data) || typeof event.data.sessionID !== "string") return
    const sessionID = event.data.sessionID
    const result = (messages: SessionMessageInfo[], touched: string[] = []): V2SessionReduction => ({
      kind: "messages",
      sessionID,
      messages,
      touched,
    })
    const unchanged = (missing?: string): V2SessionReduction => ({
      kind: "unchanged",
      sessionID,
      touched: [],
      ...(missing === undefined ? {} : { missing }),
    })
    const append = (message: SessionMessageInfo) =>
      result(source.some((item) => item.id === message.id) ? [...source] : [...source, message], [message.id])

    const reduction = (() => {
      switch (event.type) {
      case "session.input.admitted":
        pending.set(key(sessionID, event.data.inputID), event.data.input)
        return unchanged()
      case "session.input.promoted": {
        const input = pending.get(key(sessionID, event.data.inputID))
        pending.delete(key(sessionID, event.data.inputID))
        if (!input) return unchanged(event.data.inputID)
        if (input.type === "user")
          return append({
            id: event.data.inputID,
            type: "user",
            metadata: input.data.metadata,
            text: input.data.text,
            files: input.data.files,
            agents: input.data.agents,
            time: { created: event.created },
          })
        return append({
          id: event.data.inputID,
          type: "synthetic",
          metadata: input.data.metadata,
          text: input.data.text,
          description: input.data.description,
          time: { created: event.created },
        })
      }
      case "session.agent.selected":
        return append({
          id: messageID(event.id),
          type: "agent-switched",
          metadata: event.metadata,
          agent: event.data.agent,
          time: { created: event.created },
        })
      case "session.model.selected":
        return append({
          id: messageID(event.id),
          type: "model-switched",
          metadata: event.metadata,
          model: event.data.model,
          previous: source.findLast(
            (item): item is Extract<SessionMessageInfo, { type: "model-switched" | "assistant" }> =>
              item.type === "model-switched" || item.type === "assistant",
          )?.model,
          time: { created: event.created },
        })
      case "session.synthetic":
        return append({
          id: messageID(event.id),
          type: "synthetic",
          metadata: event.data.metadata,
          text: event.data.text,
          description: event.data.description,
          time: { created: event.created },
        })
      case "session.skill.activated":
        return append({
          id: messageID(event.id),
          type: "skill",
          metadata: event.metadata,
          skill: event.data.id,
          name: event.data.name,
          text: event.data.text,
          time: { created: event.created },
        })
      case "session.shell.started":
        return append({
          id: messageID(event.id),
          type: "shell",
          metadata: event.metadata,
          shellID: event.data.shell.id,
          command: event.data.shell.command,
          status: event.data.shell.status,
          exit: event.data.shell.exit,
          time: { created: event.created },
        })
      case "session.shell.ended":
        return updateMessage<Shell>(
          source,
          (item): item is Shell => item.type === "shell" && item.shellID === event.data.shell.id,
          (item) => ({
            ...item,
            status: event.data.shell.status,
            exit: event.data.shell.exit,
            output: event.data.output,
            time: { ...item.time, completed: event.created },
          }),
          sessionID,
        )
      case "session.next.prompted":
        return append({
          id: event.data.messageID,
          type: "user",
          metadata: event.metadata as SessionMessageInfo["metadata"],
          text: event.data.prompt.text,
          files: event.data.prompt.files as Extract<SessionMessageInfo, { type: "user" }>["files"],
          agents: event.data.prompt.agents as Extract<SessionMessageInfo, { type: "user" }>["agents"],
          time: { created: event.data.timestamp },
        })
      case "session.next.prompt.admitted":
      case "session.next.moved":
        return unchanged()
      case "session.next.agent.switched":
        return append({
          id: event.data.messageID,
          type: "agent-switched",
          metadata: event.metadata as SessionMessageInfo["metadata"],
          agent: event.data.agent,
          time: { created: event.data.timestamp },
        })
      case "session.next.model.switched":
        return append({
          id: event.data.messageID,
          type: "model-switched",
          metadata: event.metadata as SessionMessageInfo["metadata"],
          model: event.data.model,
          previous: source.findLast(
            (item): item is Extract<SessionMessageInfo, { type: "model-switched" | "assistant" }> =>
              item.type === "model-switched" || item.type === "assistant",
          )?.model,
          time: { created: event.data.timestamp },
        })
      case "session.next.context.updated":
        return append({
          id: event.data.messageID,
          type: "system",
          text: event.data.text,
          time: { created: event.data.timestamp },
        })
      case "session.next.synthetic":
        return append({
          id: event.data.messageID,
          type: "synthetic",
          metadata: event.metadata as SessionMessageInfo["metadata"],
          text: event.data.text,
          time: { created: event.data.timestamp },
        })
      case "session.next.shell.started":
        return append({
          id: event.data.messageID,
          type: "shell",
          metadata: event.metadata as SessionMessageInfo["metadata"],
          shellID: event.data.callID,
          command: event.data.command,
          status: "running",
          time: { created: event.data.timestamp },
        })
      case "session.next.shell.ended":
        return updateMessage<Shell>(
          source,
          (item): item is Shell => item.type === "shell" && item.shellID === event.data.callID,
          (item) => ({
            ...item,
            status: "exited",
            output: {
              output: event.data.output,
              cursor: event.data.output.length,
              size: event.data.output.length,
              truncated: false,
            },
            time: { ...item.time, completed: event.data.timestamp },
          }),
          sessionID,
        )
      case "session.step.started": {
        const current = source.findLast((item): item is Assistant => item.type === "assistant" && !item.time.completed)
        const completed =
          current && current.id !== event.data.assistantMessageID
            ? update(source, current.id, (item) =>
                item.type === "assistant"
                  ? { ...item, retry: undefined, time: { ...item.time, completed: event.created } }
                  : item,
              )
            : [...source]
        const existing = completed.find((item) => item.id === event.data.assistantMessageID)
        if (existing?.type === "assistant")
          return result(
            update(completed, existing.id, (item) =>
              item.type === "assistant"
                ? {
                    ...item,
                    agent: event.data.agent,
                    model: event.data.model,
                    retry: undefined,
                    error: undefined,
                    finish: undefined,
                    snapshot: event.data.snapshot ? { ...item.snapshot, start: event.data.snapshot } : item.snapshot,
                    time: { ...item.time, completed: undefined },
                  }
                : item,
            ),
            current && current.id !== existing.id ? [current.id, existing.id] : [existing.id],
          )
        return result(
          [
            ...completed,
            {
              id: event.data.assistantMessageID,
              type: "assistant",
              metadata: event.metadata,
              agent: event.data.agent,
              model: event.data.model,
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
              time: { created: event.created },
            },
          ],
          current ? [current.id, event.data.assistantMessageID] : [event.data.assistantMessageID],
        )
      }
      case "session.next.step.started": {
        const current = source.findLast((item): item is Assistant => item.type === "assistant" && !item.time.completed)
        const completed =
          current && current.id !== event.data.assistantMessageID
            ? update(source, current.id, (item) =>
                item.type === "assistant"
                  ? { ...item, retry: undefined, time: { ...item.time, completed: event.data.timestamp } }
                  : item,
              )
            : [...source]
        const existing = completed.find((item) => item.id === event.data.assistantMessageID)
        const startedTime = {
          created: event.data.timestamp,
          ...(event.data.requestSentAt === undefined ? {} : { requestSentAt: event.data.requestSentAt }),
        } as Assistant["time"]
        if (existing?.type === "assistant")
          return result(
            update(completed, existing.id, (item) =>
              item.type === "assistant"
                ? {
                    ...item,
                    agent: event.data.agent,
                    model: event.data.model,
                    retry: undefined,
                    error: undefined,
                    finish: undefined,
                    snapshot: event.data.snapshot ? { ...item.snapshot, start: event.data.snapshot } : item.snapshot,
                    time: { ...startedTime, created: item.time.created, completed: undefined } as Assistant["time"],
                  }
                : item,
            ),
            current && current.id !== existing.id ? [current.id, existing.id] : [existing.id],
          )
        return result(
          [
            ...completed,
            {
              id: event.data.assistantMessageID,
              type: "assistant",
              metadata: event.metadata as Assistant["metadata"],
              agent: event.data.agent,
              model: event.data.model,
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
              time: startedTime,
            },
          ],
          current ? [current.id, event.data.assistantMessageID] : [event.data.assistantMessageID],
        )
      }
      case "session.step.ended":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          finish: event.data.finish,
          cost: event.data.cost,
          tokens: event.data.tokens,
          snapshot:
            event.data.snapshot || event.data.files
              ? { ...item.snapshot, end: event.data.snapshot, files: event.data.files }
              : item.snapshot,
          time: { ...item.time, completed: event.created },
        }))
      case "session.step.failed":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          finish: "error",
          error: event.data.error,
          retry: undefined,
          cost: event.data.cost ?? item.cost,
          tokens: event.data.tokens ?? item.tokens,
          snapshot:
            event.data.snapshot || event.data.files
              ? { ...item.snapshot, end: event.data.snapshot, files: event.data.files }
              : item.snapshot,
          time: { ...item.time, completed: event.created },
        }))
      case "session.next.step.streamed":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          time: {
            ...item.time,
            streamedAt: (item.time as Assistant["time"] & { streamedAt?: number }).streamedAt ?? event.data.timestamp,
          } as Assistant["time"],
        }))
      case "session.next.step.ended": {
        const reduction = updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          finish: event.data.finish as Assistant["finish"],
          cost: event.data.cost,
          tokens: event.data.tokens,
          snapshot:
            event.data.snapshot || event.data.files
              ? {
                  ...item.snapshot,
                  end: event.data.snapshot,
                  files: event.data.files ? Array.from(event.data.files) : undefined,
                }
              : item.snapshot,
          time: { ...item.time, completed: event.data.timestamp },
        }))
        forgetMessageStreamIDs(sessionID, event.data.assistantMessageID)
        return reduction
      }
      case "session.next.step.failed": {
        const reduction = updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          finish: "error",
          error: event.data.error,
          retry: undefined,
          time: { ...item.time, completed: event.data.timestamp },
        }))
        forgetMessageStreamIDs(sessionID, event.data.assistantMessageID)
        return reduction
      }
      case "session.text.started":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          content: insertOrdinal(item.content, "text", event.data.ordinal, { type: "text", text: "" }),
        }))
      case "session.text.delta":
        return updateIndexedContent(
          indexes,
          rememberIndex,
          source,
          sessionID,
          event.data.assistantMessageID,
          "text",
          event.data.ordinal,
          (item) => ({ ...item, text: item.text + event.data.delta }),
        )
      case "session.text.ended":
        return updateIndexedContent(
          indexes,
          rememberIndex,
          source,
          sessionID,
          event.data.assistantMessageID,
          "text",
          event.data.ordinal,
          (item) => ({ ...item, text: event.data.text }),
        )
      case "session.next.text.started": {
        const ordinal = bindStreamID(
          source,
          sessionID,
          event.data.assistantMessageID,
          "text",
          event.data.textID,
        )
        if (ordinal === undefined) return
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          time: {
            ...item.time,
            firstTokenAt:
              (item.time as Assistant["time"] & { firstTokenAt?: number }).firstTokenAt ?? event.data.timestamp,
          } as Assistant["time"],
          content: insertOrdinal(item.content, "text", ordinal, { type: "text", text: "" }),
        }))
      }
      case "session.next.text.delta": {
        const ordinal = streamOrdinal(
          source,
          sessionID,
          event.data.assistantMessageID,
          "text",
          event.data.textID,
        )
        if (ordinal === undefined) return
        return updateIndexedContent(
          indexes,
          rememberIndex,
          source,
          sessionID,
          event.data.assistantMessageID,
          "text",
          ordinal,
          (item) => ({ ...item, text: item.text + event.data.delta }),
        )
      }
      case "session.next.text.ended": {
        const ordinal = streamOrdinal(
          source,
          sessionID,
          event.data.assistantMessageID,
          "text",
          event.data.textID,
        )
        if (ordinal === undefined) return
        const reduction = updateIndexedContent(
          indexes,
          rememberIndex,
          source,
          sessionID,
          event.data.assistantMessageID,
          "text",
          ordinal,
          (item) => ({ ...item, text: event.data.text }),
        )
        forgetStreamID(sessionID, event.data.assistantMessageID, "text", event.data.textID)
        return reduction
      }
      case "session.reasoning.started":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          content: insertOrdinal(item.content, "reasoning", event.data.ordinal, {
            type: "reasoning",
            text: "",
            state: event.data.state,
            time: { created: event.created },
          }),
        }))
      case "session.reasoning.delta":
        return updateIndexedContent(
          indexes,
          rememberIndex,
          source,
          sessionID,
          event.data.assistantMessageID,
          "reasoning",
          event.data.ordinal,
          (item) => ({ ...item, text: item.text + event.data.delta }),
        )
      case "session.reasoning.ended":
        return updateIndexedContent(
          indexes,
          rememberIndex,
          source,
          sessionID,
          event.data.assistantMessageID,
          "reasoning",
          event.data.ordinal,
          (item) => ({
            ...item,
            text: event.data.text,
            state: event.data.state ?? item.state,
            time: { created: item.time?.created ?? event.created, completed: event.created },
          }),
        )
      case "session.next.reasoning.started": {
        const ordinal = bindStreamID(
          source,
          sessionID,
          event.data.assistantMessageID,
          "reasoning",
          event.data.reasoningID,
        )
        if (ordinal === undefined) return
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          time: {
            ...item.time,
            firstTokenAt:
              (item.time as Assistant["time"] & { firstTokenAt?: number }).firstTokenAt ?? event.data.timestamp,
          } as Assistant["time"],
          content: insertOrdinal(item.content, "reasoning", ordinal, {
            type: "reasoning",
            text: "",
            state: event.data.providerMetadata as Extract<Assistant["content"][number], { type: "reasoning" }>["state"],
            time: { created: event.data.timestamp },
          }),
        }))
      }
      case "session.next.reasoning.delta": {
        const ordinal = streamOrdinal(
          source,
          sessionID,
          event.data.assistantMessageID,
          "reasoning",
          event.data.reasoningID,
        )
        if (ordinal === undefined) return
        return updateIndexedContent(
          indexes,
          rememberIndex,
          source,
          sessionID,
          event.data.assistantMessageID,
          "reasoning",
          ordinal,
          (item) => ({ ...item, text: item.text + event.data.delta }),
        )
      }
      case "session.next.reasoning.ended": {
        const ordinal = streamOrdinal(
          source,
          sessionID,
          event.data.assistantMessageID,
          "reasoning",
          event.data.reasoningID,
        )
        if (ordinal === undefined) return
        const reduction = updateIndexedContent(
          indexes,
          rememberIndex,
          source,
          sessionID,
          event.data.assistantMessageID,
          "reasoning",
          ordinal,
          (item) => ({
            ...item,
            text: event.data.text,
            state:
              event.data.providerMetadata === undefined
                ? item.state
                : (event.data.providerMetadata as Extract<Assistant["content"][number], { type: "reasoning" }>["state"]),
            time: { created: item.time?.created ?? event.data.timestamp, completed: event.data.timestamp },
          }),
        )
        forgetStreamID(sessionID, event.data.assistantMessageID, "reasoning", event.data.reasoningID)
        return reduction
      }
      case "session.tool.input.started":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          content: item.content.some((content) => content.type === "tool" && content.id === event.data.callID)
            ? item.content
            : [
                ...item.content,
                {
                  type: "tool",
                  id: event.data.callID,
                  name: event.data.name,
                  state: { status: "streaming", input: "" },
                  time: { created: event.created },
                },
              ],
        }))
      case "session.tool.input.delta":
        return updateIndexedTool(
          indexes,
          rememberIndex,
          source,
          sessionID,
          event.data.assistantMessageID,
          event.data.callID,
          (tool) =>
            tool.state.status === "streaming"
              ? { ...tool, state: { ...tool.state, input: tool.state.input + event.data.delta } }
              : tool,
        )
      case "session.tool.input.ended":
        return updateIndexedTool(indexes, rememberIndex, source, sessionID, event.data.assistantMessageID, event.data.callID, (tool) =>
          tool.state.status === "streaming" ? { ...tool, state: { ...tool.state, input: event.data.text } } : tool,
        )
      case "session.tool.called":
        return updateIndexedTool(indexes, rememberIndex, source, sessionID, event.data.assistantMessageID, event.data.callID, (tool) => ({
          ...tool,
          executed: event.data.executed,
          providerState: event.data.state,
          // structured: {}, content: []
          state: { status: "running", input: event.data.input, metadata: {} },
          time: { ...tool.time, ran: event.created },
        }))
      case "session.tool.progress":
        return updateIndexedTool(indexes, rememberIndex, source, sessionID, event.data.assistantMessageID, event.data.callID, (tool) =>
          tool.state.status === "running"
            ? {
                ...tool,
                // state: { ...tool.state, structured: event.data.structured, content: event.data.content },
                state: { ...tool.state, metadata: event.data.metadata },
              }
            : tool,
        )
      case "session.tool.success":
        return updateIndexedTool(indexes, rememberIndex, source, sessionID, event.data.assistantMessageID, event.data.callID, (tool) => {
          if (tool.state.status !== "running") return tool
          return {
            ...tool,
            executed: event.data.executed || tool.executed === true,
            providerResultState: event.data.resultState,
            state: {
              status: "completed",
              input: tool.state.input,
              // structured: event.data.structured,
              metadata: event.data.metadata,
              content: event.data.content,
              // result: event.data.result,
            },
            time: { ...tool.time, completed: event.created },
          }
        })
      case "session.tool.failed":
        return updateIndexedTool(indexes, rememberIndex, source, sessionID, event.data.assistantMessageID, event.data.callID, (tool) => {
          if (tool.state.status !== "streaming" && tool.state.status !== "running") return tool
          return {
            ...tool,
            executed: event.data.executed || tool.executed === true,
            providerResultState: event.data.resultState,
            state: {
              status: "error",
              input: typeof tool.state.input === "string" ? {} : tool.state.input,
              // structured: tool.state.status === "running" ? tool.state.structured : {},
              metadata: event.data.metadata ?? (tool.state.status === "running" ? tool.state.metadata : {}),
              content: event.data.content,
              error: event.data.error,
              // result: event.data.result,
            },
            time: { ...tool.time, completed: event.created },
          }
        })
      case "session.next.tool.input.started":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          content: item.content.some((content) => content.type === "tool" && content.id === event.data.callID)
            ? item.content
            : [
                ...item.content,
                {
                  type: "tool",
                  id: event.data.callID,
                  name: event.data.name,
                  state: { status: "streaming", input: "" },
                  time: { created: event.data.timestamp },
                },
              ],
        }))
      case "session.next.tool.input.delta":
        return updateIndexedTool(
          indexes,
          rememberIndex,
          source,
          sessionID,
          event.data.assistantMessageID,
          event.data.callID,
          (tool) =>
            tool.state.status === "streaming"
              ? { ...tool, state: { ...tool.state, input: tool.state.input + event.data.delta } }
              : tool,
        )
      case "session.next.tool.input.ended":
        return updateIndexedTool(
          indexes,
          rememberIndex,
          source,
          sessionID,
          event.data.assistantMessageID,
          event.data.callID,
          (tool) =>
            tool.state.status === "streaming"
              ? { ...tool, state: { ...tool.state, input: event.data.text } }
              : tool,
        )
      case "session.next.tool.called":
        return updateIndexedTool(
          indexes,
          rememberIndex,
          source,
          sessionID,
          event.data.assistantMessageID,
          event.data.callID,
          (tool) => ({
            ...tool,
            name: event.data.tool,
            executed: event.data.provider.executed,
            providerState: event.data.provider.metadata as typeof tool.providerState,
            state: { status: "running", input: event.data.input as never, metadata: {} },
            time: { ...tool.time, ran: event.data.timestamp },
          }),
        )
      case "session.next.tool.progress":
        return updateIndexedTool(
          indexes,
          rememberIndex,
          source,
          sessionID,
          event.data.assistantMessageID,
          event.data.callID,
          (tool) =>
            tool.state.status === "running"
              ? {
                  ...tool,
                  state: {
                    ...tool.state,
                    metadata: event.data.structured as typeof tool.state.metadata,
                  },
                }
              : tool,
        )
      case "session.next.tool.success":
        return updateIndexedTool(
          indexes,
          rememberIndex,
          source,
          sessionID,
          event.data.assistantMessageID,
          event.data.callID,
          (tool) => {
            if (tool.state.status !== "running") return tool
            return {
              ...tool,
              executed: event.data.provider.executed || tool.executed === true,
              providerResultState: event.data.provider.metadata as typeof tool.providerResultState,
              state: {
                status: "completed",
                input: tool.state.input,
                metadata: event.data.structured as typeof tool.state.metadata,
                content: Array.from(event.data.content),
              } as Extract<typeof tool.state, { status: "completed" }>,
              time: { ...tool.time, completed: event.data.timestamp },
            }
          },
        )
      case "session.next.tool.failed":
        return updateIndexedTool(
          indexes,
          rememberIndex,
          source,
          sessionID,
          event.data.assistantMessageID,
          event.data.callID,
          (tool) => {
            if (tool.state.status !== "streaming" && tool.state.status !== "running") return tool
            return {
              ...tool,
              executed: event.data.provider.executed || tool.executed === true,
              providerResultState: event.data.provider.metadata as typeof tool.providerResultState,
              state: {
                status: "error",
                input: typeof tool.state.input === "string" ? {} : tool.state.input,
                metadata: tool.state.status === "running" ? tool.state.metadata : undefined,
                error: event.data.error,
              },
              time: { ...tool.time, completed: event.data.timestamp },
            }
          },
        )
      case "session.retry.scheduled":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          retry: { attempt: event.data.attempt, at: event.data.at, error: event.data.error },
        }))
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const current = source.findLast((item): item is Assistant => item.type === "assistant" && !item.time.completed)
        if (!current?.retry) return unchanged()
        return updateAssistant(source, current.id, sessionID, (item) => ({ ...item, retry: undefined }))
      }
      case "session.compaction.started":
        return append({
          id: event.data.inputID ?? messageID(event.id),
          type: "compaction",
          status: "running",
          metadata: event.metadata,
          reason: event.data.reason,
          summary: "",
          recent: event.data.recent,
          time: { created: event.created },
        })
      case "session.compaction.delta":
        return updateIndexedCompaction(
          indexes,
          rememberIndex,
          source,
          sessionID,
          (item) => ({ ...item, summary: item.summary + event.data.text }),
        )
      case "session.compaction.ended": {
        const current = source.findLast(
          (item): item is Extract<Compaction, { status: "running" }> =>
            item.type === "compaction" && item.status === "running",
        )
        if (!current)
          return append({
            id: messageID(event.id),
            type: "compaction",
            status: "completed",
            metadata: event.metadata,
            reason: event.data.reason,
            summary: event.data.text,
            recent: event.data.recent,
            time: { created: event.created },
          })
        return result(
          update(source, current.id, () => ({
            ...current,
            status: "completed",
            reason: event.data.reason,
            summary: event.data.text,
            recent: event.data.recent,
          })),
          [current.id],
        )
      }
      case "session.compaction.failed": {
        const current = source.findLast(
          (item): item is Extract<Compaction, { status: "running" }> =>
            item.type === "compaction" && item.status === "running",
        )
        const failed: Extract<Compaction, { status: "failed" }> = {
          id: current?.id ?? event.data.inputID ?? messageID(event.id),
          type: "compaction",
          status: "failed",
          metadata: current?.metadata ?? event.metadata,
          reason: event.data.reason,
          error: event.data.error,
          time: current?.time ?? { created: event.created },
        }
        if (!current) return append(failed)
        return result(
          update(source, current.id, () => failed),
          [failed.id],
        )
      }
      case "session.next.compaction.started":
        return append({
          id: event.data.messageID,
          type: "compaction",
          status: "running",
          metadata: event.metadata as SessionMessageInfo["metadata"],
          reason: event.data.reason,
          summary: "",
          recent: "",
          time: { created: event.data.timestamp },
        })
      case "session.next.compaction.delta": {
        return updateIndexedCompaction(
          indexes,
          rememberIndex,
          source,
          sessionID,
          (item) => (item.id === event.data.messageID ? { ...item, summary: item.summary + event.data.text } : item),
        )
      }
      case "session.next.compaction.ended": {
        const current = source.findLast(
          (item): item is Extract<Compaction, { status: "running" }> =>
            item.type === "compaction" && item.status === "running" && item.id === event.data.messageID,
        )
        if (!current)
          return append({
            id: event.data.messageID,
            type: "compaction",
            status: "completed",
            metadata: event.metadata as SessionMessageInfo["metadata"],
            reason: event.data.reason,
            summary: event.data.text,
            recent: event.data.recent,
            time: { created: event.data.timestamp },
          })
        return result(
          update(source, current.id, () => ({
            ...current,
            status: "completed",
            reason: event.data.reason,
            summary: event.data.text,
            recent: event.data.recent,
          })),
          [current.id],
        )
      }
      case "session.next.retried":
      case "session.next.revert.staged":
      case "session.next.revert.cleared":
      case "session.next.revert.committed":
      case "session.next.paused":
      case "session.next.resumed":
      case "session.next.renamed":
        return unchanged()
      default:
        return
      }
    })()

    // Stream indexes describe message/content layout, not event names. Indexed
    // reductions update a proven slot and projection no-ops change no layout,
    // so both retain the index. Every other message reduction is treated as
    // structural and invalidates conservatively after its semantic result is
    // known. This avoids lifecycle/control invalidation without a skip list.
    if (reduction?.kind === "messages" && !reduction.incremental) indexes.delete(sessionID)
    return reduction
  }

  return {
    reduce,
    clear(sessionID: string) {
      for (const id of pending.keys()) {
        if (id.startsWith(`${sessionID}:`)) pending.delete(id)
      }
      indexes.delete(sessionID)
      streamIDs.delete(sessionID)
    },
    invalidate(sessionID: string) {
      indexes.delete(sessionID)
      streamIDs.delete(sessionID)
    },
  }
}

function key(sessionID: string, inputID: string) {
  return `${sessionID}:${inputID}`
}

function messageID(eventID: string) {
  return eventID.replace(/^evt_/, "msg_")
}

function update(
  source: readonly SessionMessageInfo[],
  id: string,
  apply: (item: SessionMessageInfo) => SessionMessageInfo,
) {
  return source.map((item) => (item.id === id ? apply(item) : item))
}

function updateMessage<T extends SessionMessageInfo>(
  source: readonly SessionMessageInfo[],
  matches: (item: SessionMessageInfo) => item is T,
  apply: (item: T) => T,
  sessionID: string,
): V2SessionReduction {
  const current = source.findLast(matches)
  if (!current) return { kind: "unchanged", sessionID, touched: [] }
  return {
    kind: "messages",
    sessionID,
    messages: update(source, current.id, (item) => (matches(item) ? apply(item) : item)),
    touched: [current.id],
  }
}

function updateAssistant(
  source: readonly SessionMessageInfo[],
  id: string,
  sessionID: string,
  apply: (item: Assistant) => Assistant,
): V2SessionReduction {
  if (!source.some((item) => item.id === id && item.type === "assistant"))
    return { kind: "unchanged", sessionID, touched: [] }
  return {
    kind: "messages",
    sessionID,
    messages: update(source, id, (item) => (item.type === "assistant" ? apply(item) : item)),
    touched: [id],
  }
}

function buildStreamIndex(source: readonly SessionMessageInfo[]): StreamIndex {
  const byID = new Map<string, number>()
  const content = new Map<
    string,
    { text: number[]; reasoning: number[]; tools: Map<string, number> }
  >()
  let runningCompaction: number | undefined

  source.forEach((message, messageIndex) => {
    byID.set(message.id, messageIndex)
    if (message.type === "assistant") {
      const text: number[] = []
      const reasoning: number[] = []
      const tools = new Map<string, number>()
      message.content.forEach((part, partIndex) => {
        if (part.type === "text") text.push(partIndex)
        if (part.type === "reasoning") reasoning.push(partIndex)
        if (part.type === "tool") tools.set(part.id, partIndex)
      })
      content.set(message.id, {
        text,
        reasoning,
        tools,
      })
    }
    if (message.type === "compaction" && message.status === "running") runningCompaction = messageIndex
  })

  return { byID, content, runningCompaction }
}

function streamIndex(
  indexes: Map<string, StreamIndex>,
  rememberIndex: (sessionID: string, index: StreamIndex) => void,
  sessionID: string,
  source: readonly SessionMessageInfo[],
) {
  const existing = indexes.get(sessionID)
  if (existing && existing.byID.size === source.length) return existing
  const created = buildStreamIndex(source)
  rememberIndex(sessionID, created)
  return created
}

function assistantAt(
  index: StreamIndex,
  source: readonly SessionMessageInfo[],
  messageID: string,
): { messageIndex: number; assistant: Assistant } | undefined {
  const messageIndex = index.byID.get(messageID)
  if (messageIndex === undefined) return undefined
  const message = source[messageIndex]
  if (!message || message.id !== messageID || message.type !== "assistant") return undefined
  return { messageIndex, assistant: message }
}

function refreshStreamIndex(
  indexes: Map<string, StreamIndex>,
  rememberIndex: (sessionID: string, index: StreamIndex) => void,
  sessionID: string,
  source: readonly SessionMessageInfo[],
) {
  const created = buildStreamIndex(source)
  rememberIndex(sessionID, created)
  return created
}

function updateIndexedContent<T extends "text" | "reasoning">(
  indexes: Map<string, StreamIndex>,
  rememberIndex: (sessionID: string, index: StreamIndex) => void,
  source: readonly SessionMessageInfo[],
  sessionID: string,
  messageID: string,
  type: T,
  ordinal: number,
  apply: (
    item: Extract<Assistant["content"][number], { type: T }>,
  ) => Extract<Assistant["content"][number], { type: T }>,
): V2SessionReduction | undefined {
  let index = streamIndex(indexes, rememberIndex, sessionID, source)
  let target = assistantAt(index, source, messageID)
  if (!target) {
    index = refreshStreamIndex(indexes, rememberIndex, sessionID, source)
    target = assistantAt(index, source, messageID)
  }
  if (!target) return undefined

  let content = index.content.get(messageID)
  if (!content) {
    index = refreshStreamIndex(indexes, rememberIndex, sessionID, source)
    target = assistantAt(index, source, messageID)
    content = index.content.get(messageID)
  }
  if (!target || !content) return undefined
  const partIndex = content[type][ordinal]
  const part = partIndex === undefined ? undefined : target.assistant.content[partIndex]
  if (!part || part.type !== type) return undefined

  const nextPart = apply(part as Extract<Assistant["content"][number], { type: T }>)
  const incremental = {
    kind: "assistant-content" as const,
    index: target.messageIndex,
    messageID,
    partID: `${messageID}:${type}:${ordinal}`,
    partIndex,
    content: nextPart,
  }
  let materialized: SessionMessageInfo[] | undefined
  return {
    kind: "messages",
    sessionID,
    get messages() {
      if (materialized) return materialized
      materialized = materializeIncremental(source, incremental)
      return materialized
    },
    touched: [messageID],
    incremental,
  }
}

function updateIndexedTool(
  indexes: Map<string, StreamIndex>,
  rememberIndex: (sessionID: string, index: StreamIndex) => void,
  source: readonly SessionMessageInfo[],
  sessionID: string,
  messageID: string,
  callID: string,
  apply: (item: Extract<Assistant["content"][number], { type: "tool" }>) => Extract<Assistant["content"][number], { type: "tool" }>,
): V2SessionReduction | undefined {
  let index = streamIndex(indexes, rememberIndex, sessionID, source)
  let target = assistantAt(index, source, messageID)
  if (!target) {
    index = refreshStreamIndex(indexes, rememberIndex, sessionID, source)
    target = assistantAt(index, source, messageID)
  }
  if (!target) return undefined

  let content = index.content.get(messageID)
  if (!content) {
    index = refreshStreamIndex(indexes, rememberIndex, sessionID, source)
    target = assistantAt(index, source, messageID)
    content = index.content.get(messageID)
  }
  if (!target || !content) return undefined
  const partIndex = content.tools.get(callID)
  if (partIndex === undefined) return undefined
  const part = target.assistant.content[partIndex]
  if (!part || part.type !== "tool") return undefined

  const nextPart = apply(part)
  const incremental = {
    kind: "assistant-content" as const,
    index: target.messageIndex,
    messageID,
    partID: callID,
    partIndex,
    content: nextPart,
  }
  let materialized: SessionMessageInfo[] | undefined
  return {
    kind: "messages",
    sessionID,
    get messages() {
      if (materialized) return materialized
      materialized = materializeIncremental(source, incremental)
      return materialized
    },
    touched: [messageID],
    incremental,
  }
}

function updateIndexedCompaction(
  indexes: Map<string, StreamIndex>,
  rememberIndex: (sessionID: string, index: StreamIndex) => void,
  source: readonly SessionMessageInfo[],
  sessionID: string,
  apply: (item: Extract<Compaction, { status: "running" }>) => Extract<Compaction, { status: "running" }>,
): V2SessionReduction | undefined {
  let index = streamIndex(indexes, rememberIndex, sessionID, source)
  let messageIndex = index.runningCompaction
  let message = messageIndex === undefined ? undefined : source[messageIndex]
  if (!message || message.type !== "compaction" || message.status !== "running") {
    index = refreshStreamIndex(indexes, rememberIndex, sessionID, source)
    messageIndex = index.runningCompaction
    message = messageIndex === undefined ? undefined : source[messageIndex]
  }
  if (!message || messageIndex === undefined || message.type !== "compaction" || message.status !== "running") return undefined

  const nextMessage = apply(message)
  const incremental = { kind: "message" as const, index: messageIndex, message: nextMessage }
  let materialized: SessionMessageInfo[] | undefined
  return {
    kind: "messages",
    sessionID,
    get messages() {
      if (materialized) return materialized
      materialized = materializeIncremental(source, incremental)
      return materialized
    },
    touched: [message.id],
    incremental,
  }
}

function materializeIncremental(
  source: readonly SessionMessageInfo[],
  incremental: NonNullable<V2SessionReduction["incremental"]>,
) {
  const next = source.slice()
  if (incremental.kind === "message") {
    const at =
      source[incremental.index]?.id === incremental.message.id
        ? incremental.index
        : source.findIndex((message) => message.id === incremental.message.id)
    if (at >= 0) next[at] = incremental.message
    return next
  }

  const at =
    source[incremental.index]?.id === incremental.messageID
      ? incremental.index
      : source.findIndex((message) => message.id === incremental.messageID)
  if (at < 0) return next
  const message = source[at]
  if (!message || message.type !== "assistant") return next
  const content = message.content.slice()
  content[incremental.partIndex] = incremental.content
  next[at] = { ...message, content }
  return next
}

function insertOrdinal<T extends Assistant["content"][number]["type"]>(
  source: Assistant["content"],
  type: T,
  ordinal: number,
  item: Extract<Assistant["content"][number], { type: T }>,
) {
  const matches = source.filter((content) => content.type === type)
  if (matches[ordinal]) return source
  return [...source, item]
}
