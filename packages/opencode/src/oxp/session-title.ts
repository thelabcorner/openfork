/**
 * Human-readable session title carried by the initial OXP status handshake.
 *
 * The title is untrusted display metadata, never identity: it is normalized
 * (trim, strip control characters, bounded) and stored once on the canonical
 * parent-activity row keyed by the pseudonymized conversation correlation.
 */

export const MAX_TITLE_BYTES = 256

// C0/C1 control characters are stripped so titles cannot carry newline or
// formatting injection into telemetry rows, logs, or the sidebar.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g

export type NormalizedTitle =
  | { readonly ok: true; readonly title: string }
  | { readonly ok: false; readonly reason: "blank" | "too_long" }

export function normalizeSessionTitle(raw: unknown): NormalizedTitle {
  if (typeof raw !== "string") return { ok: false, reason: "blank" }
  const title = raw.replace(CONTROL_CHARACTERS, "").trim()
  if (title.length === 0) return { ok: false, reason: "blank" }
  if (Buffer.byteLength(title, "utf8") > MAX_TITLE_BYTES) return { ok: false, reason: "too_long" }
  return { ok: true, title }
}

export * as OxpSessionTitle from "./session-title"
