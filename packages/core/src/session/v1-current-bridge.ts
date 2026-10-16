export * as V1CurrentBridge from "./v1-current-bridge"

import { createHash } from "node:crypto"
import { DateTime, Schema } from "effect"
import { SessionV1 } from "../v1/session"
import { SessionMessage } from "./message"

/**
 * Versioned, READ-ONLY candidate reducer for historical V1 transcripts.
 *
 * Do not write candidates to session_message. Its schema cannot yet express
 * nine V1 part kinds, the complete V1 tool metadata contract, or user-turn
 * execution policy; writing the projection alone would silently erase data.
 *
 * The envelope deliberately retains a separately cloned, schema-validated V1
 * source. It supports exact V1 recovery and a reproducible differential
 * oracle without pretending a lossy V2 projection is already authoritative.
 */
export const VERSION = 1 as const

const readV1 = Schema.decodeUnknownSync(SessionV1.WithParts)
const readCurrent = Schema.decodeUnknownSync(SessionMessage.Message)
const known = new Set([
  "text", "reasoning", "file", "tool", "subtask", "step-start",
  "step-finish", "snapshot", "patch", "agent", "retry", "compaction",
])
const modeled = new Set(["text", "reasoning", "tool"])

type Mapping = {
  readonly partID: string
  readonly kind: string
  readonly destination: "assistant-content" | "user-text" | "user-file" | "legacy-bridge"
  readonly currentID?: string
  readonly callID?: string
}
export type Envelope = {
  readonly version: typeof VERSION
  readonly sourceHash: string
  readonly sessionID: string
  readonly messageID: string
  readonly source: SessionV1.WithParts
  readonly candidate: SessionMessage.Message | null
  readonly mappings: readonly Mapping[]
  /** Explicit reasons this envelope cannot become the canonical V2 write. */
  readonly blockers: readonly string[]
  readonly cutoverSafe: false
}

function canonical(value: unknown, seen = new Set<object>()): string {
  // Current-schema DateTime values are structured instances rather than
  // plain JSON objects. Comparing Object.entries alone would accidentally
  // equate different timestamps (DateTime's fields need not be enumerable).
  if (DateTime.isDateTime(value)) return `{"$utcMillis":${DateTime.toEpochMillis(value)}}`
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number in V1 source")
    return Object.is(value, -0) ? "-0" : JSON.stringify(value)
  }
  if (typeof value !== "object") throw new Error("Non-JSON value in V1 source")
  if (seen.has(value)) throw new Error("Cyclic V1 source")
  seen.add(value)
  const result = Array.isArray(value)
    ? "[" + value.map((item) => canonical(item, seen)).join(",") + "]"
    : "{" + Object.entries(value).filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item, seen)).join(",") + "}"
  seen.delete(value)
  return result
}

export function digest(source: SessionV1.WithParts): string {
  return createHash("sha256").update(canonical(source), "utf8").digest("hex")
}

/** Compare only an already-validated lowerer's decoded V2 candidate and
 * explicit blockers. Reuse this after an independent source-hash check rather
 * than decoding/hashing a giant source envelope a second time. */
export function assertCandidate(
  expected: Pick<Envelope, "candidate" | "blockers">,
  candidate: SessionMessage.Message,
  blockers: readonly string[],
): true {
  if (!Schema.is(SessionMessage.Message)(candidate))
    throw new Error("V1 bridge envelope candidate schema mismatch")
  if (canonical(expected.candidate) !== canonical(candidate) ||
    canonical(expected.blockers) !== canonical(blockers))
    throw new Error("V1 bridge envelope differential mismatch")
  return true
}

function timestamp(n: number) {
  // Schema.decodeUnknownSync consumes *encoded* numeric timestamps and
  // produces the canonical DateTime instances. Passing DateTime directly
  // here would be an invalid second decoding pass.
  return n
}

function metadataNeedsBridge(part: SessionV1.Part) {
  if (part.type === "text") return !!(part.synthetic || part.ignored || part.time || part.metadata)
  if (part.type === "reasoning") return !!part.metadata
  // V1 tool-part id and V2 tool-call id are different identities, and V1
  // title/timing/metadata/provider trace cannot be reconstructed from the V2
  // subset. Even the simplest successful tool needs an identity sidecar.
  if (part.type === "tool") return true
  return true
}

function convertTool(part: SessionV1.ToolPart, messageCreated: number) {
  const input = part.state.input
  const at = "time" in part.state ? part.state.time.start : messageCreated
  const state = (() => {
    switch (part.state.status) {
      case "pending":
        return { status: "pending", input: part.state.raw }
      case "running":
        return {
          status: "running", input, structured: part.state.metadata ?? {}, content: [],
        }
      case "completed":
        return {
          status: "completed", input, structured: part.state.metadata ?? {},
          content: [
            { type: "text", text: part.state.output },
            ...(part.state.attachments ?? []).map((file) => ({
              type: "file", uri: file.url, mime: file.mime, name: file.filename,
            })),
          ],
        }
      case "error":
        return {
          status: "error", input, structured: part.state.metadata ?? {}, content: [],
          error: { type: "unknown", message: part.state.error },
        }
    }
  })()
  return {
    type: "tool",
    id: part.callID,
    name: part.tool,
    state,
    time: {
      created: timestamp(messageCreated),
      ...(part.state.status === "pending" ? {} : { ran: timestamp(at) }),
      ...(part.state.status === "completed" || part.state.status === "error"
        ? { completed: timestamp(part.state.time.end) } : {}),
    },
  }
}

function convert(input: SessionV1.WithParts): Omit<Envelope, "sourceHash" | "source"> {
  const mappings: Mapping[] = []
  const blockers: string[] = []
  const ids = new Set<string>()
  const calls = new Set<string>()
  const currentIDs = new Set<string>()
  const { info, parts } = input
  const currentContent: unknown[] = []
  const userFiles: unknown[] = []
  const userTexts: string[] = []
  const assistantCreated = info.time.created

  for (const part of parts) {
    if (part.sessionID !== info.sessionID || part.messageID !== info.id)
      throw new Error(`Foreign V1 part ${part.id} in message ${info.id}`)
    if (ids.has(part.id)) throw new Error(`Duplicate V1 part identity ${part.id}`)
    ids.add(part.id)
    if (!known.has(part.type)) throw new Error(`Unknown V1 part kind ${part.type}`)

    if (info.role === "user") {
      if (part.type === "text") {
        userTexts.push(part.text)
        mappings.push({ partID: part.id, kind: part.type, destination: "user-text" })
        if (metadataNeedsBridge(part)) blockers.push(`v1-extra:${part.id}`)
        continue
      }
      if (part.type === "file") {
        userFiles.push({ uri: part.url, mime: part.mime, name: part.filename })
        mappings.push({ partID: part.id, kind: part.type, destination: "user-file" })
        if (part.source) blockers.push(`file-source:${part.id}`)
        continue
      }
    } else if (modeled.has(part.type)) {
      const currentID = part.type === "tool" ? part.callID : part.id
      if (currentIDs.has(currentID))
        throw new Error(`Colliding V2 content identity ${currentID}`)
      currentIDs.add(currentID)
      if (part.type === "text") {
        currentContent.push({ type: "text", id: part.id, text: part.text })
      } else if (part.type === "reasoning") {
        currentContent.push({
          type: "reasoning", id: part.id, text: part.text,
          time: {
            created: timestamp(part.time.start),
            ...(part.time.end === undefined ? {} : { completed: timestamp(part.time.end) }),
          },
        })
      } else if (part.type === "tool") {
        if (calls.has(part.callID)) throw new Error(`Duplicate V1 tool call identity ${part.callID}`)
        calls.add(part.callID)
        currentContent.push(convertTool(part, assistantCreated))
      }
      mappings.push({
        partID: part.id, kind: part.type,
        destination: "assistant-content",
        currentID,
        ...(part.type === "tool" ? { callID: part.callID } : {}),
      })
      if (metadataNeedsBridge(part)) blockers.push(`v1-extra:${part.id}`)
      continue
    }
    mappings.push({ partID: part.id, kind: part.type, destination: "legacy-bridge" })
    blockers.push(`unsupported-part:${part.type}:${part.id}`)
  }

  // The V1 user message includes agent/model/format/system/tool policy not
  // modeled on current User; roundtrip is therefore intentionally bridge-only.
  // Multiple V1 text parts must not be silently joined into one current text.
  if (info.role === "user") {
    blockers.push("v1-user-execution-policy")
    if (userTexts.length > 1) blockers.push("multiple-user-text-parts")
  } else {
    blockers.push("v1-assistant-parent-path-policy")
    if (info.error && info.error.name !== "UnknownError") blockers.push("v1-specific-error")
  }

  const candidate = readCurrent(info.role === "user"
    ? {
        id: info.id, type: "user",
        text: userTexts.length === 1 ? userTexts[0] : "",
        files: userFiles, agents: [],
        time: { created: timestamp(info.time.created) },
        ...(info.provenance === undefined ? {} : { provenance: info.provenance }),
      }
    : {
        id: info.id, type: "assistant", agent: info.agent,
        model: {
          id: info.modelID, providerID: info.providerID,
          ...(info.variant ? { variant: info.variant } : {}),
        },
        content: currentContent,
        cost: info.cost,
        tokens: info.tokens,
        ...(info.finish ? { finish: info.finish } : {}),
        time: {
          created: timestamp(info.time.created),
          ...(info.time.completed !== undefined ? { completed: timestamp(info.time.completed) } : {}),
          ...(info.time.requestSentAt !== undefined ? { requestSentAt: timestamp(info.time.requestSentAt) } : {}),
          ...(info.time.firstTokenAt !== undefined ? { firstTokenAt: timestamp(info.time.firstTokenAt) } : {}),
          ...(info.time.streamedAt !== undefined ? { streamedAt: timestamp(info.time.streamedAt) } : {}),
        },
      })

  return {
    version: VERSION,
    sessionID: info.sessionID,
    messageID: info.id,
    candidate,
    mappings,
    blockers: [...new Set(blockers)],
    cutoverSafe: false,
  }
}

/** Build a deterministic, self-contained differential envelope from validated
 * V1 source; no DB write or current event publication. */
export function lower(source: SessionV1.WithParts): Envelope {
  // Validation must precede mapping. Keep the full original JSON shape,
  // including historical extension properties, as the reversible source.
  readV1(source)
  const copy = structuredClone(source)
  const result = convert(copy)
  return { ...result, sourceHash: digest(copy), source: copy }
}

/** Verify the in-memory differential envelope without cloning its (potentially
 * multi-MiB) retained V1 source. This is a hash consistency check, NOT a
 * signature and NOT an event-log snapshot/ownership fence. */
export function verify(envelope: Envelope): true {
  if (envelope.version !== VERSION || envelope.cutoverSafe !== false)
    throw new Error("Unsupported V1 bridge envelope version or authority")
  const source = envelope.source
  readV1(source)
  if (digest(source) !== envelope.sourceHash)
    throw new Error("V1 bridge envelope source integrity mismatch")
  if (source.info.id !== envelope.messageID || source.info.sessionID !== envelope.sessionID)
    throw new Error("V1 bridge envelope owner identity mismatch")
  // Encoded DateTime millisecond values are not valid domain values here.
  // Recheck the actual decoded current union rather than trusting a forged
  // plain object that happens to stringify like a real DateTime.
  if (!envelope.candidate || !Schema.is(SessionMessage.Message)(envelope.candidate))
    throw new Error("V1 bridge envelope candidate schema mismatch")
  const expected = convert(source)
  if (canonical(expected) !== canonical({
    version: envelope.version,
    sessionID: envelope.sessionID,
    messageID: envelope.messageID,
    candidate: envelope.candidate,
    mappings: envelope.mappings,
    blockers: envelope.blockers,
    cutoverSafe: envelope.cutoverSafe,
  })) throw new Error("V1 bridge envelope differential mismatch")
  return true
}

/** Return a detached exact archived V1 shape only after checking the complete
 * source and candidate. A real native V2 write must preserve the bridge before
 * it could ever be used as a replacement for V1's canonical storage. */
export function restore(envelope: Envelope): SessionV1.WithParts {
  verify(envelope)
  return structuredClone(envelope.source)
}
