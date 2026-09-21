import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { userTurnPresentation } from "@/utils/session-message"

export type SessionContextBreakdownKey =
  | "system"
  | "user"
  | "synthetic"
  | "shell"
  | "compaction"
  | "assistant"
  | "tool"
  | "other"

export type SessionContextBreakdownSegment = {
  key: SessionContextBreakdownKey
  tokens: number
  width: number
  percent: number
}

const estimateTokens = (chars: number) => Math.ceil(chars / 4)
const toPercent = (tokens: number, input: number) => (tokens / input) * 100
const toPercentLabel = (tokens: number, input: number) => Math.round(toPercent(tokens, input) * 10) / 10

const charsFromUserPart = (part: Part) => {
  if (part.type === "text") return part.text.length
  if (part.type === "file") return part.source?.text.value.length ?? 0
  if (part.type === "agent") return part.source?.value.length ?? 0
  return 0
}

const charsFromAssistantPart = (part: Part) => {
  if (part.type === "text") return { assistant: part.text.length, tool: 0 }
  if (part.type === "reasoning") return { assistant: part.text.length, tool: 0 }
  if (part.type !== "tool") return { assistant: 0, tool: 0 }

  const input = Object.keys(part.state.input).length * 16
  if (part.state.status === "pending") return { assistant: 0, tool: input + part.state.raw.length }
  if (part.state.status === "completed") return { assistant: 0, tool: input + part.state.output.length }
  if (part.state.status === "error") return { assistant: 0, tool: input + part.state.error.length }
  return { assistant: 0, tool: input }
}

const build = (
  tokens: {
    system: number
    user: number
    synthetic: number
    shell: number
    compaction: number
    assistant: number
    tool: number
    other: number
  },
  input: number,
) => {
  return [
    {
      key: "system",
      tokens: tokens.system,
    },
    {
      key: "user",
      tokens: tokens.user,
    },
    {
      key: "synthetic",
      tokens: tokens.synthetic,
    },
    {
      key: "shell",
      tokens: tokens.shell,
    },
    {
      key: "compaction",
      tokens: tokens.compaction,
    },
    {
      key: "assistant",
      tokens: tokens.assistant,
    },
    {
      key: "tool",
      tokens: tokens.tool,
    },
    {
      key: "other",
      tokens: tokens.other,
    },
  ]
    .filter((x) => x.tokens > 0)
    .map((x) => ({
      key: x.key,
      tokens: x.tokens,
      width: toPercent(x.tokens, input),
      percent: toPercentLabel(x.tokens, input),
    })) as SessionContextBreakdownSegment[]
}

export function estimateSessionContextBreakdown(args: {
  messages: Message[]
  parts: Record<string, Part[] | undefined>
  input: number
  systemPrompt?: string
}) {
  if (!args.input) return []

  const counts = args.messages.reduce(
    (acc, msg) => {
      const parts = args.parts[msg.id] ?? []
      if (msg.role === "user") {
        const chars = parts.reduce((sum, part) => sum + charsFromUserPart(part), 0)
        const presentation = userTurnPresentation(msg)
        if (presentation === "user") return { ...acc, user: acc.user + chars }
        if (presentation === "shell") return { ...acc, shell: acc.shell + chars }
        if (presentation === "compaction") return { ...acc, compaction: acc.compaction + chars }
        return { ...acc, synthetic: acc.synthetic + chars }
      }

      if (msg.role !== "assistant") return acc
      const assistant = parts.reduce(
        (sum, part) => {
          const next = charsFromAssistantPart(part)
          return {
            assistant: sum.assistant + next.assistant,
            tool: sum.tool + next.tool,
          }
        },
        { assistant: 0, tool: 0 },
      )
      return {
        ...acc,
        assistant: acc.assistant + assistant.assistant,
        tool: acc.tool + assistant.tool,
      }
    },
    {
      system: args.systemPrompt?.length ?? 0,
      user: 0,
      synthetic: 0,
      shell: 0,
      compaction: 0,
      assistant: 0,
      tool: 0,
    },
  )

  const tokens = {
    system: estimateTokens(counts.system),
    user: estimateTokens(counts.user),
    synthetic: estimateTokens(counts.synthetic),
    shell: estimateTokens(counts.shell),
    compaction: estimateTokens(counts.compaction),
    assistant: estimateTokens(counts.assistant),
    tool: estimateTokens(counts.tool),
  }
  const estimated =
    tokens.system +
    tokens.user +
    tokens.synthetic +
    tokens.shell +
    tokens.compaction +
    tokens.assistant +
    tokens.tool

  if (estimated <= args.input) {
    return build({ ...tokens, other: args.input - estimated }, args.input)
  }

  const scale = args.input / estimated
  const scaled = {
    system: Math.floor(tokens.system * scale),
    user: Math.floor(tokens.user * scale),
    synthetic: Math.floor(tokens.synthetic * scale),
    shell: Math.floor(tokens.shell * scale),
    compaction: Math.floor(tokens.compaction * scale),
    assistant: Math.floor(tokens.assistant * scale),
    tool: Math.floor(tokens.tool * scale),
  }
  const total =
    scaled.system +
    scaled.user +
    scaled.synthetic +
    scaled.shell +
    scaled.compaction +
    scaled.assistant +
    scaled.tool
  return build({ ...scaled, other: Math.max(0, args.input - total) }, args.input)
}
