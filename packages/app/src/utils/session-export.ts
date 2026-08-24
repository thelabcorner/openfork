import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"

// Matches the exact `{ info, messages: [{ info, parts }] }` structure produced by `opencode export` CLI
export type SessionExportData = {
  info: Session
  messages: {
    info: Message
    parts: Part[]
  }[]
}

export type SessionExportClient = {
  session: {
    get: (input: { sessionID: string }) => Promise<{ data?: Session | null }>
    messages: (input: { sessionID: string }) => Promise<{ data?: SessionExportData["messages"] | null }>
  }
}

export async function fetchSessionExport(input: {
  sessionID: string
  client: SessionExportClient
}): Promise<SessionExportData> {
  const [sessionRes, messagesRes] = await Promise.all([
    input.client.session.get({ sessionID: input.sessionID }),
    input.client.session.messages({ sessionID: input.sessionID }),
  ])

  if (!sessionRes?.data) {
    throw new Error(`Session not found: ${input.sessionID}`)
  }
  if (!messagesRes?.data) {
    throw new Error(`Failed to load messages for session: ${input.sessionID}`)
  }

  return {
    info: sessionRes.data,
    messages: messagesRes.data,
  }
}

export function sessionExportFilename(session: { id: string; title?: string; slug?: string }) {
  const name = session.title || session.slug || session.id
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
  return `${clean || session.id}.json`
}

/**
 * Serializes compactly (pretty-printing doubles serialize time and peak memory
 * on large transcripts) and hands the JSON string to `compress` when the
 * platform can brotli-compress it off the UI thread. Returns the saved
 * filename — `.br` is appended when compression succeeded.
 */
export async function downloadSessionExport(
  filename: string,
  data: unknown,
  compress?: (json: string) => Promise<Uint8Array<ArrayBuffer> | null>,
): Promise<string> {
  const json = JSON.stringify(data)
  const compressed = compress ? await compress(json).catch(() => null) : null
  if (compressed && compressed.byteLength > 0) {
    const name = `${filename}.br`
    downloadBlob(name, new Blob([compressed], { type: "application/octet-stream" }))
    return name
  }
  downloadBlob(filename, new Blob([json], { type: "application/json" }))
  return filename
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
