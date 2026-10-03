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

const toPercent = (tokens: number, input: number) => (tokens / input) * 100
const toPercentLabel = (tokens: number, input: number) => Math.round(toPercent(tokens, input) * 10) / 10

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

export function projectSessionContextBreakdown(
  tokens: Record<SessionContextBreakdownKey, number>,
  input: number,
) {
  if (!input) return []
  const estimated = Object.entries(tokens)
    .filter(([key]) => key !== "other")
    .reduce((sum, [, value]) => sum + value, 0)

  if (estimated <= input) return build({ ...tokens, other: Math.max(tokens.other, input - estimated) }, input)

  const scale = input / estimated
  const scaled = {
    system: Math.floor(tokens.system * scale),
    user: Math.floor(tokens.user * scale),
    synthetic: Math.floor(tokens.synthetic * scale),
    shell: Math.floor(tokens.shell * scale),
    compaction: Math.floor(tokens.compaction * scale),
    assistant: Math.floor(tokens.assistant * scale),
    tool: Math.floor(tokens.tool * scale),
  }
  const total = Object.values(scaled).reduce((sum, value) => sum + value, 0)
  return build({ ...scaled, other: Math.max(0, input - total) }, input)
}
