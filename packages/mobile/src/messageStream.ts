import type { MessageBundle } from "./api"

export type MessageReductionResult = {
  messages: MessageBundle[]
  changed: boolean
  stale?: boolean
  messageIndex?: number
  topology?: boolean
  /** Message/part membership changed; history-wide structural analytics may refresh. */
  structure?: boolean
}
type Result = MessageReductionResult

type MessageIndex = {
  source: MessageBundle[]
  messages: Map<string, number>
  parts: Map<string, Map<string, number>>
}

let hotIndex: MessageIndex | undefined

function indexFor(messages: MessageBundle[]) {
  if (hotIndex?.source === messages) return hotIndex
  const messageMap = new Map<string, number>()
  const partMap = new Map<string, Map<string, number>>()
  for (let i = 0; i < messages.length; i++) {
    const bundle = messages[i]!
    messageMap.set(bundle.info.id, i)
    const parts = new Map<string, number>()
    for (let j = 0; j < bundle.parts.length; j++) parts.set(bundle.parts[j]!.id, j)
    partMap.set(bundle.info.id, parts)
  }
  hotIndex = { source: messages, messages: messageMap, parts: partMap }
  return hotIndex
}

function adoptIndex(previous: MessageBundle[], next: MessageBundle[], messageID?: string, partsChanged = false) {
  const current = indexFor(previous)
  if (partsChanged && messageID) {
    const bundle = next[current.messages.get(messageID) ?? -1]
    if (bundle) current.parts.set(messageID, new Map(bundle.parts.map((part, index) => [part.id, index] as const)))
  }
  // These maps are an internal projection cache, never observable by Solid or
  // callers. Reusing them when topology is unchanged is what makes token-rate
  // updates O(1) with respect to history; cloning a 5k-entry Map per token is
  // just an O(history) scan wearing a different data structure.
  hotIndex = { source: next, messages: current.messages, parts: current.parts }
}

function appendBundle(messages: MessageBundle[], bundle: MessageBundle, mutableOuter = false) {
  const current = indexFor(messages)
  const index = messages.length
  const next = mutableOuter ? messages : [...messages, bundle]
  if (mutableOuter) next.push(bundle)
  current.messages.set(bundle.info.id, index)
  current.parts.set(bundle.info.id, new Map(bundle.parts.map((part, index) => [part.id, index] as const)))
  hotIndex = { source: next, messages: current.messages, parts: current.parts }
  return next
}

function updateBundle(
  messages: MessageBundle[],
  messageID: string,
  update: (bundle: MessageBundle) => MessageBundle,
  partsChanged = false,
  mutableOuter = false,
): Result {
  const index = indexFor(messages).messages.get(messageID) ?? -1
  if (index < 0) return { messages, changed: false, stale: true }
  const updated = update(messages[index]!)
  if (updated === messages[index]) return { messages, changed: false, stale: true }
  if (mutableOuter) {
    messages[index] = updated
    if (partsChanged) {
      indexFor(messages).parts.set(messageID, new Map(updated.parts.map((part, partIndex) => [part.id, partIndex] as const)))
    }
    return { messages, changed: true, messageIndex: index, structure: partsChanged }
  }
  const next = messages.slice()
  next[index] = updated
  adoptIndex(messages, next, messageID, partsChanged)
  return { messages: next, changed: true, messageIndex: index, structure: partsChanged }
}

function updatePart(
  messages: MessageBundle[],
  messageID: string,
  partID: string,
  update: (part: any) => any,
  mutableOuter = false,
): Result {
  return updateBundle(messages, messageID, (bundle) => {
    const index = indexFor(messages).parts.get(messageID)?.get(partID) ?? -1
    if (index < 0) return bundle
    const parts = bundle.parts.slice()
    parts[index] = update(parts[index])
    const updated = { ...bundle, parts }
    return updated
  }, false, mutableOuter)
}

function upsertPart(messages: MessageBundle[], messageID: string, part: any, mutableOuter = false): Result {
  const partIndex = indexFor(messages).parts.get(messageID)?.get(part.id) ?? -1
  return updateBundle(messages, messageID, (bundle) => {
    if (partIndex < 0) return { ...bundle, parts: [...bundle.parts, part] }
    const parts = bundle.parts.slice()
    parts[partIndex] = part
    return { ...bundle, parts }
  }, partIndex < 0, mutableOuter)
}

function assistant(props: any) {
  return {
    id: props.assistantMessageID,
    sessionID: props.sessionID,
    role: "assistant",
    parentID: props.parentID ?? "",
    providerID: props.model?.providerID ?? "",
    modelID: props.model?.modelID ?? props.model?.id ?? "",
    mode: props.agent ?? "",
    agent: props.agent ?? "",
    path: { cwd: "", root: "" },
    time: { created: props.timestamp ?? Date.now() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function toolOutput(content: any) {
  if (!Array.isArray(content)) return ""
  // Jumbo tool results are commonly one text item. Returning that exact string
  // avoids allocating a second multi-megabyte copy through filter/map/join.
  if (content.length === 1 && content[0]?.type === "text") return content[0].text ?? ""
  let output = ""
  let first = true
  for (const item of content) {
    if (item?.type !== "text") continue
    if (!first) output += "\n"
    output += item.text ?? ""
    first = false
  }
  return output
}

function reduceMessageEventCore(messages: MessageBundle[], type: string, props: any, mutableOuter: boolean): Result {
  if (type === "message.updated" && props.info) {
    const index = indexFor(messages).messages.get(props.info.id) ?? -1
    if (index < 0)
      return {
        messages: appendBundle(messages, { info: props.info, parts: [] }, mutableOuter),
        changed: true,
        topology: true,
        structure: true,
      }
    if (mutableOuter) {
      messages[index] = { ...messages[index]!, info: props.info }
      return { messages, changed: true, messageIndex: index }
    }
    const next = messages.slice()
    next[index] = { ...messages[index]!, info: props.info }
    adoptIndex(messages, next, props.info.id)
    return { messages: next, changed: true, messageIndex: index }
  }
  if (type === "message.removed") {
    const index = indexFor(messages).messages.get(props.messageID) ?? -1
    if (index < 0) return { messages, changed: false }
    const next = mutableOuter ? messages : messages.slice()
    next.splice(index, 1)
    // Removal shifts every following index; rebuild once at this low-frequency
    // structural boundary instead of carrying token-rate repair complexity.
    hotIndex = undefined
    indexFor(next)
    return { messages: next, changed: true, topology: true, structure: true }
  }
  if (type === "message.part.updated" && props.part)
    return upsertPart(messages, props.part.messageID, props.part, mutableOuter)
  if (type === "message.part.removed") {
    return updateBundle(messages, props.messageID, (bundle) => ({
      ...bundle,
      parts: bundle.parts.filter((part) => part.id !== props.partID),
    }), true, mutableOuter)
  }
  if (type === "message.part.delta") {
    return updatePart(messages, props.messageID, props.partID, (part) => {
      const previous = `${part[props.field] ?? ""}`
      const delta = `${props.delta ?? ""}`
      return {
        ...part,
        [props.field]: `${previous}${delta}`,
        ...(props.field === "text" ? { __mobileAppendFrom: previous.length, __mobileAppendDelta: delta } : {}),
      }
    }, mutableOuter)
  }

  const messageID = props.assistantMessageID
  if (type === "session.next.step.started") {
    if (indexFor(messages).messages.has(messageID)) return { messages, changed: false }
    return {
      messages: appendBundle(messages, { info: assistant(props) as any, parts: [] }, mutableOuter),
      changed: true,
      topology: true,
      structure: true,
    }
  }
  if (type === "session.next.step.ended" || type === "session.next.step.failed") {
    return updateBundle(messages, messageID, (bundle) => ({
      ...bundle,
      info: {
        ...bundle.info,
        time: { ...bundle.info.time, completed: props.timestamp ?? Date.now() },
        ...(type.endsWith("failed") ? { finish: "error", error: props.error } : {
          finish: props.finish,
          cost: props.cost ?? 0,
          tokens: props.tokens ?? (bundle.info as any).tokens,
        }),
      } as any,
    }), false, mutableOuter)
  }

  if (type === "session.next.tool.input.started") {
    return upsertPart(messages, messageID, {
      id: props.callID,
      callID: props.callID,
      sessionID: props.sessionID,
      messageID,
      type: "tool",
      tool: props.name,
      state: { status: "pending", input: {}, raw: "" },
    }, mutableOuter)
  }
  if (type === "session.next.tool.input.ended") {
    return updatePart(messages, messageID, props.callID, (part) => ({
      ...part,
      state: { ...part.state, raw: props.text ?? "" },
    }), mutableOuter)
  }
  if (type === "session.next.tool.called") {
    return updatePart(messages, messageID, props.callID, (part) => ({
      ...part,
      tool: props.tool ?? part.tool,
      state: {
        status: "running",
        input: props.input ?? {},
        time: { start: props.timestamp ?? Date.now() },
      },
    }), mutableOuter)
  }
  if (type === "session.next.tool.progress") {
    return updatePart(messages, messageID, props.callID, (part) => {
      if (part.state?.status !== "running") return part
      return {
        ...part,
        state: {
          ...part.state,
          title: typeof props.structured?.title === "string" ? props.structured.title : part.state.title,
          metadata: props.structured ?? {},
        },
      }
    }, mutableOuter)
  }
  if (type === "session.next.tool.success") {
    return updatePart(messages, messageID, props.callID, (part) => ({
      ...part,
      state: {
        status: "completed",
        input: part.state?.input ?? {},
        output: toolOutput(props.content),
        title: typeof props.structured?.title === "string" ? props.structured.title : part.tool,
        metadata: props.structured ?? {},
        time: { start: part.state?.time?.start ?? props.timestamp ?? Date.now(), end: props.timestamp ?? Date.now() },
      },
    }), mutableOuter)
  }
  if (type === "session.next.tool.failed") {
    return updatePart(messages, messageID, props.callID, (part) => ({
      ...part,
      state: {
        status: "error",
        input: part.state?.input ?? {},
        error: props.error?.message ?? String(props.error ?? "Tool failed"),
        metadata: part.state?.metadata,
        time: { start: part.state?.time?.start ?? props.timestamp ?? Date.now(), end: props.timestamp ?? Date.now() },
      },
    }), mutableOuter)
  }

  const textID = props.textID ?? props.reasoningID
  const partType = props.reasoningID ? "reasoning" : "text"
  if (type === "session.next.text.started" || type === "session.next.reasoning.started") {
    let bundle = messages[indexFor(messages).messages.get(messageID) ?? -1]
    if (!bundle) {
      const created = {
        messages: appendBundle(messages, { info: assistant(props) as any, parts: [] }, mutableOuter),
        changed: true as const,
      }
      messages = created.messages
      bundle = messages[indexFor(messages).messages.get(messageID) ?? -1]!
    }
    if (indexFor(messages).parts.get(messageID)?.has(textID)) return { messages, changed: false }
    return upsertPart(messages, messageID, {
      id: textID,
      sessionID: props.sessionID,
      messageID,
      type: partType,
      text: "",
      time: { start: props.timestamp ?? Date.now() },
    }, mutableOuter)
  }
  if (type === "session.next.text.delta" || type === "session.next.reasoning.delta") {
    let bundle = messages[indexFor(messages).messages.get(messageID) ?? -1]
    if (!bundle) {
      const created = {
        messages: appendBundle(messages, { info: assistant(props) as any, parts: [] }, mutableOuter),
        changed: true as const,
      }
      messages = created.messages
      bundle = messages[indexFor(messages).messages.get(messageID) ?? -1]!
    }
    if (!indexFor(messages).parts.get(messageID)?.has(textID)) {
      const delta = `${props.delta ?? ""}`
      return upsertPart(messages, messageID, {
        id: textID,
        sessionID: props.sessionID,
        messageID,
        type: partType,
        text: delta,
        __mobileAppendFrom: 0,
        __mobileAppendDelta: delta,
        time: { start: props.timestamp ?? Date.now() },
      }, mutableOuter)
    }
    return updatePart(messages, messageID, textID, (part) => {
      const previous = `${part.text ?? ""}`
      const delta = `${props.delta ?? ""}`
      return {
        ...part,
        text: `${previous}${delta}`,
        __mobileAppendFrom: previous.length,
        __mobileAppendDelta: delta,
      }
    }, mutableOuter)
  }
  if (type === "session.next.text.ended" || type === "session.next.reasoning.ended") {
    const bundle = messages[indexFor(messages).messages.get(messageID) ?? -1]
    if (!bundle) {
      const created = {
        info: assistant(props) as any,
        parts: [
          {
            id: textID,
            sessionID: props.sessionID,
            messageID,
            type: partType,
            text: props.text ?? "",
            time: { start: props.timestamp ?? Date.now(), end: props.timestamp ?? Date.now() },
          },
        ],
      } as MessageBundle
      return {
        messages: appendBundle(messages, created, mutableOuter),
        changed: true,
        topology: true,
        structure: true,
      }
    }
    if (!indexFor(messages).parts.get(messageID)?.has(textID)) {
      return upsertPart(messages, messageID, {
        id: textID,
        sessionID: props.sessionID,
        messageID,
        type: partType,
        text: props.text ?? "",
        time: { start: props.timestamp ?? Date.now(), end: props.timestamp ?? Date.now() },
      }, mutableOuter)
    }
    return updatePart(messages, messageID, textID, (part) => ({
      ...part,
      text: props.text ?? "",
      __mobileAppendFrom: undefined,
      __mobileAppendDelta: undefined,
      time: { ...part.time, end: props.timestamp ?? Date.now() },
    }), mutableOuter)
  }
  return { messages, changed: false }
}

export function reduceMessageEvent(messages: MessageBundle[], type: string, props: any): Result {
  return reduceMessageEventCore(messages, type, props, false)
}

/**
 * Private mutable projection for the renderer hot path.
 *
 * The public reducer remains immutable for tests/callers. This projection owns
 * a detached shallow copy, so replacing one bundle in place cannot mutate the
 * Solid store. App code can then publish only the changed message index instead
 * of allocating/copying the entire history array for every token.
 */
export class MessageStreamProjection {
  private value: MessageBundle[] = []

  constructor(messages: MessageBundle[] = []) {
    this.reset(messages)
  }

  reset(messages: MessageBundle[]) {
    this.value = messages.slice()
    hotIndex = undefined
    indexFor(this.value)
  }

  get messages() {
    return this.value
  }

  apply(type: string, props: any) {
    return reduceMessageEventCore(this.value, type, props, true)
  }
}
