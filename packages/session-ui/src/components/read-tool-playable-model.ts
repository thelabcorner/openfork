/** The persisted Read attachment owns these bytes; projection does not copy them. */
export type ReadPlayableMedia = {
  readonly kind: "video" | "audio"
  readonly mime: string
  readonly url: string
  readonly name?: string
}

const allowedVideo = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-msvideo", "video/x-ms-wmv"])
const allowedAudio = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/aiff", "audio/aac", "audio/ogg", "audio/flac"])

export function readToolPlayableMedia(input: Record<string, unknown>, attachments: unknown): ReadPlayableMedia | undefined {
  if (!Array.isArray(attachments)) return undefined
  const requested = typeof input.filePath === "string" ? input.filePath :
    typeof input.file_path === "string" ? input.file_path : undefined
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object" || attachment.type !== "file") continue
    const { mime, url } = attachment as { mime?: unknown; url?: unknown }
    if (typeof mime !== "string" || typeof url !== "string") continue
    const kind = allowedVideo.has(mime) ? "video" : allowedAudio.has(mime) ? "audio" : undefined
    if (!kind) continue
    const prefix = `data:${mime};base64,`
    if (!url.startsWith(prefix) || url.length <= prefix.length) continue
    if (url.length > 28 * 1024 * 1024) continue
    return { kind, mime, url, name: requested?.split(/[\\/]/).at(-1) }
  }
  return undefined
}
