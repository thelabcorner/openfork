import type { SessionV1 } from "@opencode-ai/core/v1/session"

const MAX_CONTEXT_CHARS = 18_000
const MAX_EXECUTION_LEDGER_CHARS = 4_500
const MAX_EXECUTION_IDENTITY_CHARS = 900
const MAX_BLOCK_CHARS = 6_000
const MAX_TEXT_CHARS = 4_500
const MAX_TOOL_OUTPUT_CHARS = 4_500
const MAX_COMMAND_CHARS = 2_000
const MAX_TOOL_INPUT_CHARS = 2_000
const SECRET_KEY =
  /(?:pass(?:word)?|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|access[_-]?key|refresh[_-]?token)/i
const EXECUTION_IDENTITY_KEY =
  /^(?:action|mode|capability|namespace|rootID|workdir|cwd|path|filePath|directory|peer|host|target|sessionID|workerID|repo|repository)$/i
const EXECUTION_COMMAND_KEY = /^(?:command|argv)$/i

function clip(value: string, maxChars: number) {
  if (maxChars <= 0) return ""
  if (value.length <= maxChars) return value
  const marker = "\n...[bounded audit context omitted]...\n"
  if (maxChars <= marker.length) return value.slice(0, maxChars)
  const available = maxChars - marker.length
  const head = Math.floor(available * 0.55)
  return value.slice(0, head) + marker + value.slice(-(available - head))
}

function escapeData(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function escapeAttribute(value: string) {
  return escapeData(value).replaceAll('"', "&quot;")
}

export function redactCommand(value: string) {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"';]+/gi, "$1[redacted]")
    .replace(
      /(^|\s)((?:--?)(?:token|api[-_]?key|password|secret)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s;]+)/gi,
      "$1$2[redacted]",
    )
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;]+)/gi,
      "$1[redacted]",
    )
    .replace(/(https?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1[redacted]@")
}

function toolCommand(part: SessionV1.ToolPart) {
  if (part.tool !== "bash" && part.tool !== "shell") return undefined
  if (part.state.status !== "completed" && part.state.status !== "error") return undefined
  const command = part.state.input.command
  if (typeof command !== "string" || !command.trim()) return undefined
  const redacted = redactCommand(command)
  return redacted.length <= MAX_COMMAND_CHARS
    ? redacted
    : redacted.slice(0, MAX_COMMAND_CHARS) + "\n[command truncated]"
}

function sanitizeToolInput(value: unknown, depth = 0): unknown {
  if (depth > 4 || !value || typeof value !== "object") return undefined
  if (Array.isArray(value)) {
    const items = value
      .slice(0, 16)
      .map((item) => sanitizeToolInput(item, depth + 1))
      .filter((item) => item !== undefined)
    return items.length > 0 ? items : undefined
  }

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    if (SECRET_KEY.test(key)) {
      out[key] = "[redacted]"
      continue
    }
    if (EXECUTION_IDENTITY_KEY.test(key)) {
      if (typeof item === "string") out[key] = clip(redactCommand(item), 1_000)
      else if (item === null || typeof item === "number" || typeof item === "boolean") out[key] = item
      continue
    }
    if (EXECUTION_COMMAND_KEY.test(key)) {
      if (typeof item === "string") out[key] = clip(redactCommand(item), 1_000)
      else if (Array.isArray(item) && item.every((arg) => typeof arg === "string")) {
        out[key] = clip(redactCommand(item.join(" ")), 1_000)
      }
      continue
    }
    const nested = sanitizeToolInput(item, depth + 1)
    if (nested !== undefined && (!Array.isArray(nested) || nested.length > 0)) out[key] = nested
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function toolInput(part: SessionV1.ToolPart) {
  if (part.tool === "bash" || part.tool === "shell") return undefined
  if (part.state.status !== "completed" && part.state.status !== "error") return undefined
  const encoded = JSON.stringify(sanitizeToolInput(part.state.input))
  if (!encoded || encoded === "{}") return undefined
  return clip(encoded, MAX_TOOL_INPUT_CHARS)
}

function textBlock(message: SessionV1.WithParts, text: string) {
  return [
    `<worker-prose role="${escapeAttribute(message.info.role)}">`,
    escapeData(clip(text, MAX_TEXT_CHARS)),
    "</worker-prose>",
  ].join("\n")
}

function toolBlock(message: SessionV1.WithParts, part: SessionV1.ToolPart) {
  if (part.state.status !== "completed" && part.state.status !== "error") return undefined

  const command = toolCommand(part)
  const input = toolInput(part)
  const status = part.state.status
  const body =
    status === "completed"
      ? clip(part.state.output, MAX_TOOL_OUTPUT_CHARS)
      : clip(part.state.error, MAX_TOOL_OUTPUT_CHARS)

  return [
    `<host-tool-record role="${escapeAttribute(message.info.role)}" tool="${escapeAttribute(part.tool)}" status="${status}">`,
    status === "completed" ? `<title>${escapeData(part.state.title)}</title>` : "",
    command ? `<command>${escapeData(command)}</command>` : "",
    input ? `<input-json>${escapeData(input)}</input-json>` : "",
    `<result-data>${escapeData(body)}</result-data>`,
    "</host-tool-record>",
  ]
    .filter(Boolean)
    .join("\n")
}

function executionIdentityBlock(part: SessionV1.ToolPart) {
  if (part.state.status !== "completed" && part.state.status !== "error") return undefined
  const command = toolCommand(part)
  const input = toolInput(part)
  if (!command && !input) return undefined
  return clip(
    [
      `<host-execution-identity tool="${escapeAttribute(part.tool)}" status="${part.state.status}">`,
      command ? `<command>${escapeData(command)}</command>` : "",
      input ? `<input-json>${escapeData(input)}</input-json>` : "",
      "</host-execution-identity>",
    ]
      .filter(Boolean)
      .join("\n"),
    MAX_EXECUTION_IDENTITY_CHARS,
  )
}

function executionLedger(messages: readonly SessionV1.WithParts[]) {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      const identity = executionIdentityBlock(part)
      if (!identity || seen.has(identity)) continue
      seen.add(identity)
      unique.push(identity)
    }
  }
  if (unique.length === 0) return ""

  // Preserve both the beginning and end of the cycle. The first external tool
  // often establishes the real remote workspace; the latest records show where
  // the worker ended. This ledger is intentionally independent of result-output
  // recency so verbose later logs cannot evict execution-surface identity.
  const boundary =
    unique.length <= 8
      ? unique
      : [...unique.slice(0, 4), ...unique.slice(-4)]
  const body = clip(boundary.join("\n"), MAX_EXECUTION_LEDGER_CHARS)
  return ["<host-execution-ledger>", body, "</host-execution-ledger>"].join("\n")
}

/**
 * Build the bounded evidence delta shown to the Goal auditor.
 *
 * Provenance is encoded structurally from durable part types, never inferred from
 * model-authored text. Only assistant text is projected as worker prose; user/host
 * prompt text is not mislabeled as worker output. Worker prose and tool-returned
 * data are XML-escaped so they cannot synthesize host wrappers. Tool invocation inputs are bounded/redacted so
 * an auditor can identify the actual execution surface (SSH/remote shell/OFXP/etc.)
 * without leaking common credential shapes.
 *
 * When sourceMessageID is available, evidence is scoped to that causal worker
 * cycle instead of an arbitrary "last N messages" window. Tool-heavy cycles can
 * otherwise lose the early remote-execution record that explains where the work
 * actually happened while retaining only the final prose summary.
 */
export function latestWork(
  messages: readonly SessionV1.WithParts[],
  sourceMessageID?: string,
) {
  const sourceIndex = sourceMessageID
    ? messages.findIndex((message) => message.info.id === sourceMessageID)
    : -1
  const cycle = sourceIndex >= 0 ? messages.slice(sourceIndex) : messages
  const ledger = executionLedger(cycle)
  const blocks = cycle.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type === "text" && !part.ignored && message.info.role === "assistant") {
        return [textBlock(message, part.text)]
      }
      if (part.type === "tool") {
        const block = toolBlock(message, part)
        return block ? [block] : []
      }
      return []
    }),
  )

  // Reserve space for the host execution ledger first, then pack complete recent
  // provenance blocks newest-to-oldest. Never tail-slice the final aggregate:
  // doing so can remove the host wrapper/command while leaving untrusted result
  // bytes behind.
  const selected: string[] = []
  let used = ledger ? ledger.length + 2 : 0
  for (let index = blocks.length - 1; index >= 0; index--) {
    const separator = selected.length > 0 ? 2 : 0
    const remaining = MAX_CONTEXT_CHARS - used - separator
    if (remaining <= 0) break
    const block = clip(blocks[index]!, Math.min(MAX_BLOCK_CHARS, remaining))
    selected.push(block)
    used += block.length + separator
  }
  return [ledger, selected.reverse().join("\n\n")].filter(Boolean).join("\n\n")
}
