import { createHash } from "node:crypto"
import type { ModelMessage, Tool } from "ai"
import type { Provider } from "@/provider/provider"
import { isMuseModel } from "@/provider/transform"
import { LLMEvent } from "@opencode-ai/llm"

const MAX_TOOL_NAME_LENGTH = 64
// Meta's function-name constraint differs from generic OpenAI Responses:
// no more than one dot, in addition to 64 characters and this alphabet.
const VALID_TOOL_NAME = /^[a-zA-Z0-9_.-]{1,64}$/
const validName = (name: string) => VALID_TOOL_NAME.test(name) && name.indexOf(".") === name.lastIndexOf(".")
const validCallID = (id: string) => id.length > 0 && id.length <= 64

/**
 * Meta rejects names longer than 64 characters, including names in prior tool
 * calls/results. Keep internal tool identities and execution closures untouched;
 * aliases exist only within the outgoing Muse request and its replayed history.
 */
export function normalizeMuseToolNames(
  model: Provider.Model,
  tools: Record<string, Tool>,
  messages: ModelMessage[],
): { tools: Record<string, Tool>; messages: ModelMessage[]; canonicalByAlias: Record<string, string> } {
  if (!isMuseModel(model)) return { tools, messages, canonicalByAlias: {} }

  const historic = messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => "toolName" in part || "toolCallId" in part)
      : [],
  )
  const names = [
    ...Object.keys(tools),
    ...historic.flatMap((part) => "toolName" in part && typeof part.toolName === "string" ? [part.toolName] : []),
  ]
  const callIDs = historic.flatMap((part) => "toolCallId" in part && typeof part.toolCallId === "string" ? [part.toolCallId] : [])
  if (names.every(validName) && callIDs.every(validCallID)) return { tools, messages, canonicalByAlias: {} }

  // Reserve valid identifiers before assigning aliases: no generated name or
  // call ID can shadow a real tool or an existing historical call.
  const reserved = new Set(names.filter(validName))
  const aliases = new Map<string, string>()
  const canonicalByAlias: Record<string, string> = Object.create(null)
  for (const name of names) {
    if (validName(name) || aliases.has(name)) continue
    let salt = 0
    let alias: string
    // Generated aliases omit dots; historical names with multiple dots must
    // never remain invalid after shortening.
    const prefix = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME_LENGTH - 17) || "tool"
    do {
      const digest = createHash("sha256").update(name).update(salt ? "#" + salt : "").digest("hex").slice(0, 16)
      alias = prefix + "_" + digest
      salt++
    } while (reserved.has(alias))
    reserved.add(alias)
    aliases.set(name, alias)
    canonicalByAlias[alias] = name
  }

  const reservedIDs = new Set(callIDs.filter(validCallID))
  const callAliases = new Map<string, string>()
  for (const id of callIDs) {
    if (validCallID(id) || callAliases.has(id)) continue
    let salt = 0
    let alias: string
    do {
      const digest = createHash("sha256").update(id).update(salt ? "#" + salt : "").digest("hex").slice(0, 24)
      alias = "call_" + digest
      salt++
    } while (reservedIDs.has(alias))
    reservedIDs.add(alias)
    callAliases.set(id, alias)
  }

  const wireTools = aliases.size
    ? Object.fromEntries(Object.entries(tools).map(([name, value]) => [aliases.get(name) ?? name, value]))
    : tools
  const wireMessages = messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((part) => {
      const name = "toolName" in part && typeof part.toolName === "string" ? aliases.get(part.toolName) : undefined
      const callID = "toolCallId" in part && typeof part.toolCallId === "string" ? callAliases.get(part.toolCallId) : undefined
      if (!name && !callID) return part
      changed = true
      return { ...part, ...(name ? { toolName: name } : {}), ...(callID ? { toolCallId: callID } : {}) }
    })
    return changed ? { ...message, content } as ModelMessage : message
  })
  return { tools: wireTools, messages: wireMessages, canonicalByAlias }
}

/**
 * Restore canonical tool identities before provider events enter the session,
 * telemetry, permission and persistence owners. Transport aliases must never
 * become internal tool IDs.
 */
export function restoreMuseToolEvent(event: LLMEvent, canonicalByAlias: Readonly<Record<string, string>>): LLMEvent {
  if (!("name" in event) || !Object.hasOwn(canonicalByAlias, event.name)) return event
  const name = canonicalByAlias[event.name]
  switch (event.type) {
    case "tool-input-start": return LLMEvent.toolInputStart({ ...event, name })
    case "tool-input-delta": return LLMEvent.toolInputDelta({ ...event, name })
    case "tool-input-end": return LLMEvent.toolInputEnd({ ...event, name })
    case "tool-call": return LLMEvent.toolCall({ ...event, name })
    case "tool-result": return LLMEvent.toolResult({ ...event, name })
    case "tool-error": return LLMEvent.toolError({ ...event, name })
    default: return event
  }
}
