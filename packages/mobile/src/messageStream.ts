import type { MessageBundle } from "./api"

type Result = { messages: MessageBundle[]; changed: boolean; stale?: boolean }

function updateBundle(
  messages: MessageBundle[],
  messageID: string,
  update: (bundle: MessageBundle) => MessageBundle,
): Result {
  const index = messages.findIndex((bundle) => bundle.info.id === messageID)
  if (index < 0) return { messages, changed: false, stale: true }
  const updated = update(messages[index]!)
  if (updated === messages[index]) return { messages, changed: false, stale: true }
  const next = messages.slice()
  next[index] = updated
  return { messages: next, changed: true }
}

function updatePart(
  messages: MessageBundle[],
  messageID: string,
  partID: string,
  update: (part: any) => any,
): Result {
  return updateBundle(messages, messageID, (bundle) => {
    const index = bundle.parts.findIndex((part) => part.id === partID)
    if (index < 0) return bundle
    const parts = bundle.parts.slice()
    parts[index] = update(parts[index])
    return { ...bundle, parts }
  })
}

function upsertPart(messages: MessageBundle[], messageID: string, part: any): Result {
  return updateBundle(messages, messageID, (bundle) => {
    const index = bundle.parts.findIndex((item) => item.id === part.id)
    if (index < 0) return { ...bundle, parts: [...bundle.parts, part] }
    const parts = bundle.parts.slice()
    parts[index] = part
    return { ...bundle, parts }
  })
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
  return content.filter((item) => item?.type === "text").map((item) => item.text ?? "").join("\n")
}

export function reduceMessageEvent(messages: MessageBundle[], type: string, props: any): Result {
  if (type === "message.updated" && props.info) {
    const index = messages.findIndex((bundle) => bundle.info.id === props.info.id)
    if (index < 0) return { messages: [...messages, { info: props.info, parts: [] }], changed: true }
    const next = messages.slice()
    next[index] = { ...messages[index]!, info: props.info }
    return { messages: next, changed: true }
  }
  if (type === "message.removed") {
    const next = messages.filter((bundle) => bundle.info.id !== props.messageID)
    return { messages: next, changed: next.length !== messages.length }
  }
  if (type === "message.part.updated" && props.part) return upsertPart(messages, props.part.messageID, props.part)
  if (type === "message.part.removed") {
    return updateBundle(messages, props.messageID, (bundle) => ({
      ...bundle,
      parts: bundle.parts.filter((part) => part.id !== props.partID),
    }))
  }
  if (type === "message.part.delta") {
    return updatePart(messages, props.messageID, props.partID, (part) => ({
      ...part,
      [props.field]: `${part[props.field] ?? ""}${props.delta ?? ""}`,
    }))
  }

  const messageID = props.assistantMessageID
  if (type === "session.next.step.started") {
    if (messages.some((bundle) => bundle.info.id === messageID)) return { messages, changed: false }
    return { messages: [...messages, { info: assistant(props) as any, parts: [] }], changed: true }
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
    }))
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
    })
  }
  if (type === "session.next.tool.input.ended") {
    return updatePart(messages, messageID, props.callID, (part) => ({
      ...part,
      state: { ...part.state, raw: props.text ?? "" },
    }))
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
    }))
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
    })
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
    }))
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
    }))
  }

  const textID = props.textID ?? props.reasoningID
  const partType = props.reasoningID ? "reasoning" : "text"
  if (type === "session.next.text.started" || type === "session.next.reasoning.started") {
    let bundle = messages.find((item) => item.info.id === messageID)
    if (!bundle) {
      const created = {
        messages: [...messages, { info: assistant(props) as any, parts: [] }],
        changed: true as const,
      }
      messages = created.messages
      bundle = messages.find((item) => item.info.id === messageID)!
    }
    if (bundle.parts.some((part) => part.id === textID)) return { messages, changed: false }
    return upsertPart(messages, messageID, {
      id: textID,
      sessionID: props.sessionID,
      messageID,
      type: partType,
      text: "",
      time: { start: props.timestamp ?? Date.now() },
    })
  }
  if (type === "session.next.text.delta" || type === "session.next.reasoning.delta") {
    let bundle = messages.find((item) => item.info.id === messageID)
    if (!bundle) {
      const created = {
        messages: [...messages, { info: assistant(props) as any, parts: [] }],
        changed: true as const,
      }
      messages = created.messages
      bundle = messages.find((item) => item.info.id === messageID)!
    }
    if (!bundle.parts.some((part) => part.id === textID)) {
      return upsertPart(messages, messageID, {
        id: textID,
        sessionID: props.sessionID,
        messageID,
        type: partType,
        text: props.delta ?? "",
        time: { start: props.timestamp ?? Date.now() },
      })
    }
    return updatePart(messages, messageID, textID, (part) => ({ ...part, text: `${part.text ?? ""}${props.delta ?? ""}` }))
  }
  if (type === "session.next.text.ended" || type === "session.next.reasoning.ended") {
    const bundle = messages.find((item) => item.info.id === messageID)
    if (!bundle) {
      return {
        messages: [
          ...messages,
          {
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
          },
        ],
        changed: true,
      }
    }
    if (!bundle.parts.some((p) => p.id === textID)) {
      return upsertPart(messages, messageID, {
        id: textID,
        sessionID: props.sessionID,
        messageID,
        type: partType,
        text: props.text ?? "",
        time: { start: props.timestamp ?? Date.now(), end: props.timestamp ?? Date.now() },
      })
    }
    return updatePart(messages, messageID, textID, (part) => ({
      ...part,
      text: props.text ?? "",
      time: { ...part.time, end: props.timestamp ?? Date.now() },
    }))
  }
  return { messages, changed: false }
}
