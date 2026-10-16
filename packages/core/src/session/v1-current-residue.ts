export * as V1CurrentResidue from "./v1-current-residue"

import { Schema } from "effect"
import { SessionV1 } from "../v1/session"
import { SessionMessage } from "./message"
import { V1CurrentBridge } from "./v1-current-bridge"

/**
 * Space-conscious, versioned, lossless V1 remainder over a current-model
 * candidate. Fields that can be recovered *exactly* from current content are
 * replaced by indexed references; V1-only kinds and metadata remain intact.
 *
 * The result is transport-serializable via toWire/fromWire. It is still
 * SHADOW-ONLY: no production event producer/DB writer is authorized to use it
 * as current storage until event replay, owner fencing and snapshot gates pass.
 */
export const VERSION = 1 as const

type Path = readonly (string | number)[]
type Source =
  | "user-text" | "user-file"
  | "assistant-text" | "assistant-reasoning"
  | "tool-input" | "tool-structured" | "tool-output" | "tool-attachment"
type Binding = {
  readonly path: Path
  readonly source: Source
  readonly id?: string
  readonly index?: number
}
export type Template = {
  // This is deliberately NOT a V1.Part: bound fields may be absent until
  // restore() rehydrates and schema-validates the complete source.
  readonly part: unknown
  readonly bindings: readonly Binding[]
}
export type Residue = {
  readonly version: typeof VERSION
  readonly messageID: string
  readonly sessionID: string
  readonly sourceHash: string
  readonly info: SessionV1.Info
  readonly parts: readonly Template[]
  readonly candidate: SessionMessage.Message
  readonly blockers: readonly string[]
  readonly cutoverSafe: false
}

type PlainObject = Record<string, any>
const isObject = (v: unknown): v is PlainObject =>
  !!v && typeof v === "object" && !Array.isArray(v)

function at(obj: unknown, path: Path): unknown {
  let current: any = obj
  for (const key of path) {
    if (current == null || (typeof current !== "object" && typeof current !== "function"))
      throw new Error("V1 residue source path no longer exists")
    current = current[key]
  }
  return current
}
function parent(obj: unknown, path: Path): { object: PlainObject; key: string | number } {
  if (path.length === 0) throw new Error("Cannot bind empty residue path")
  const object = at(obj, path.slice(0, -1))
  if (!isObject(object) && !Array.isArray(object)) throw new Error("Invalid V1 residue template")
  return { object: object as PlainObject, key: path[path.length - 1]! }
}
function deletePath(obj: unknown, path: Path) {
  const p = parent(obj, path)
  delete p.object[p.key]
}
function setPath(obj: unknown, path: Path, value: unknown) {
  const p = parent(obj, path)
  p.object[p.key] = structuredClone(value)
}
const equalJSON = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The bridge has already schema-validated and detached the source. A second
 * deep clone here would copy enormous tool-output strings and data-URI fields
 * only to immediately delete them from the sparse template. Clone exactly
 * the mutable ancestor nodes of fields the binding process may remove.
 * No nested source input/metadata object is mutated in this routine. */
function draftPart(original: SessionV1.Part): PlainObject {
  const draft: PlainObject = { ...original }
  if (original.type === "tool") {
    draft.state = { ...original.state }
    if (original.state.status === "completed" && original.state.attachments)
      draft.state.attachments = original.state.attachments.map((attachment) => ({ ...attachment }))
  }
  return draft
}

function findContent(candidate: SessionMessage.Message, id: string) {
  if (candidate.type !== "assistant") throw new Error("Expected current assistant content")
  const found = candidate.content.find((p) => p.id === id)
  if (!found) throw new Error(`Missing current assistant content ${id}`)
  return found
}
function resolve(candidate: SessionMessage.Message, binding: Binding) {
  if (binding.source === "user-text") {
    if (candidate.type !== "user") throw new Error("Expected current user")
    return candidate.text
  }
  if (binding.source === "user-file") {
    if (candidate.type !== "user") throw new Error("Expected current user file")
    const file = candidate.files?.[binding.index ?? -1]
    if (!file) throw new Error("Missing current user file")
    return file.uri
  }
  const content = findContent(candidate, binding.id ?? "")
  switch (binding.source) {
    case "assistant-text":
    case "assistant-reasoning":
      if (content.type !== (binding.source === "assistant-text" ? "text" : "reasoning"))
        throw new Error("Current content kind changed")
      return content.text
    case "tool-input":
      if (content.type !== "tool" || content.state.status === "pending")
        throw new Error("Current tool input unavailable")
      return content.state.input
    case "tool-structured":
      if (content.type !== "tool" || content.state.status === "pending")
        throw new Error("Current tool structured metadata unavailable")
      return content.state.structured
    case "tool-output": {
      if (content.type !== "tool" || content.state.status !== "completed")
        throw new Error("Current completed tool output unavailable")
      const result = content.state.content[0]
      if (!result || result.type !== "text") throw new Error("Missing original text output")
      return result.text
    }
    case "tool-attachment": {
      if (content.type !== "tool" || content.state.status !== "completed")
        throw new Error("Current tool attachment unavailable")
      const files = content.state.content.filter((item) => item.type === "file")
      const file = files[binding.index ?? -1]
      if (!file) throw new Error("Missing current tool attachment")
      return file.uri
    }
  }
}

const decodeCurrent = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeCurrent = Schema.encodeSync(SessionMessage.Message)
const isCurrent = Schema.is(SessionMessage.Message)

export function lower(source: SessionV1.WithParts): Residue {
  const envelope = V1CurrentBridge.lower(source)
  const candidate = envelope.candidate
  if (!candidate) throw new Error("Missing current shadow candidate")
  const templateParts: Template[] = []
  let fileIndex = 0
  const userTextCount = source.parts.filter((p) => p.type === "text").length

  for (const original of envelope.source.parts) {
    const part = draftPart(original)
    const bindings: Binding[] = []
    const bind = (path: Path, source: Source, id?: string, index?: number) => {
      const spec: Binding = { path, source, ...(id === undefined ? {} : { id }), ...(index === undefined ? {} : { index }) }
      // Only replace fields that round-trip byte/JSON equivalent; optional
      // metadata and asymmetric provider fields must never be guessed.
      try {
        const expected = resolve(candidate, spec)
        const originalValue = at(part, path)
        if (originalValue === undefined || !equalJSON(expected, originalValue)) return
        deletePath(part, path)
        bindings.push(spec)
      } catch {
        // No binding means the original field remains in the residue.
      }
    }

    if (candidate.type === "user") {
      if (original.type === "text" && userTextCount === 1) bind(["text"], "user-text")
      if (original.type === "file") bind(["url"], "user-file", undefined, fileIndex++)
    } else if (candidate.type === "assistant") {
      if (original.type === "text") bind(["text"], "assistant-text", original.id)
      if (original.type === "reasoning") bind(["text"], "assistant-reasoning", original.id)
      if (original.type === "tool") {
        if (original.state.status !== "pending") {
          bind(["state", "input"], "tool-input", original.callID)
          bind(["state", "metadata"], "tool-structured", original.callID)
        }
        if (original.state.status === "completed") {
          bind(["state", "output"], "tool-output", original.callID)
          for (const [index] of (original.state.attachments ?? []).entries())
            bind(["state", "attachments", index, "url"], "tool-attachment", original.callID, index)
        }
      }
    }
    templateParts.push({ part, bindings })
  }

  return {
    version: VERSION, sessionID: envelope.sessionID,
    messageID: envelope.messageID, sourceHash: envelope.sourceHash,
    info: structuredClone(envelope.source.info),
    parts: templateParts,
    candidate, blockers: envelope.blockers,
    cutoverSafe: false,
  }
}

/**
 * Fully reconstruct V1 without reading part/message tables or event history.
 * Missing/wrong current-model fields, altered metadata, or detached ownership
 * abort the reconstruction; this remains a consistency proof, not a MAC.
 */
export function restore(residue: Residue): SessionV1.WithParts {
  if (residue.version !== VERSION || residue.cutoverSafe !== false)
    throw new Error("Unsupported V1 residue authority")
  if (!isCurrent(residue.candidate))
    throw new Error("Invalid current candidate in V1 residue")
  const parts = residue.parts.map((entry) => {
    const part = structuredClone(entry.part)
    for (const binding of entry.bindings)
      setPath(part, binding.path, resolve(residue.candidate, binding))
    return part as SessionV1.Part
  })
  const original: SessionV1.WithParts = {
    info: structuredClone(residue.info),
    parts,
  }
  const expected = V1CurrentBridge.lower(original)
  if (expected.sourceHash !== residue.sourceHash ||
    expected.messageID !== residue.messageID ||
    expected.sessionID !== residue.sessionID)
    throw new Error("V1 compact residue source integrity mismatch")
  // Re-run the differential with the supplied V2 candidate, not just the
  // reconstituted source; this also catches altered current-only fields.
  V1CurrentBridge.assertCandidate(expected, residue.candidate, residue.blockers)
  return original
}

/** Stable JSON-compatible wire shape. Encode DateTime into schema-owned
 * milliseconds rather than serializing an opaque DateTime JS instance. */
export function toWire(residue: Residue) {
  // restore() has already validated full source hash, owner identities and
  // candidate differential. Do not hash the multi-MiB source a third time.
  restore(residue)
  return {
    ...residue,
    candidate: encodeCurrent(residue.candidate),
  }
}

export function fromWire(raw: ReturnType<typeof toWire>): Residue {
  if (raw.version !== VERSION) throw new Error("Unknown V1 residue version")
  const result: Residue = { ...raw, candidate: decodeCurrent(raw.candidate) }
  restore(result)
  return result
}
