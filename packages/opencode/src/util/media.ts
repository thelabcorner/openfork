const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((value, index) => bytes[index] === value)

export function isPdfAttachment(mime: string) {
  return mime === "application/pdf"
}

export function isVideoAttachment(mime: string) {
  return mime === "video/mp4" || mime === "video/webm" || mime === "video/quicktime" ||
    mime === "video/x-msvideo" || mime === "video/x-ms-wmv" || mime === "video/mp2t"
}

export function isAudioAttachment(mime: string) {
  return mime === "audio/mpeg" || mime === "audio/mp3" || mime === "audio/wav" ||
    mime === "audio/x-wav" || mime === "audio/flac" || mime === "audio/ogg" ||
    mime === "audio/mp4" || mime === "audio/aac" || mime === "audio/aiff"
}

export function isMedia(mime: string) {
  return mime.startsWith("image/") || isPdfAttachment(mime) || isVideoAttachment(mime) || isAudioAttachment(mime)
}

export function isImageAttachment(mime: string) {
  return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
}

// MPEG-TS has no one-time file signature. Its packet synchronization must
// recur at a fixed cadence. These are FFmpeg's standard raw TS packet widths
// (188, 192 with a 4-byte M2TS timestamp, and 204 with FEC). Validate real
// packet headers too: a single ASCII 'G' is not evidence of video.
export function probeMpegTransportStream(bytes: Uint8Array):
  | { readonly packetSize: 188 | 192 | 204; readonly packets: number }
  | undefined {
  // A deliberately periodic UTF-8 source file can contain ASCII 'G' at all
  // synchronization positions. Valid textual source is stronger evidence for
  // text than a naked repeated byte/header pattern in a .ts collision.
  if (sourceTextSample(bytes)) return undefined
  let winner: { packetSize: 188 | 192 | 204; packets: number } | undefined
  for (const [size, start] of [[188, 0], [192, 4], [204, 0]] as const) {
    // A 192-byte Blu-ray packet needs only its 188-byte MPEG payload to
    // validate; its final 4-byte arrival timestamp is in the NEXT packet.
    const possible = Math.min(16, Math.floor((bytes.length - start - 188) / size) + 1)
    if (possible < 4) continue
    let packets = 0
    for (let index = 0; index < possible; index++) {
      const at = start + index * size
      if (bytes[at] !== 0x47) break
      // adaptation_field_control == 0 is reserved; reject malformed packet
      // structure before accepting the recurring sync-byte evidence.
      const control = (bytes[at + 3]! >> 4) & 3
      if (control === 0) break
      if (control & 2) {
        const adapt = bytes[at + 4]!
        if (adapt > 183) break
        if (control === 2 && adapt !== 183) break
      }
      packets++
    }
    if (packets >= 4 && (!winner || packets > winner.packets)) winner = { packetSize: size, packets }
  }
  return winner
}

// The .ts extension is shared by TypeScript and MPEG-TS, and .mts is shared
// by TypeScript ESM modules and MPEG-TS video. Only validated content decides.
export function isAmbiguousTsPath(filename: string) {
  return /(?:^|[/\\])[^/\\]+\.(?:ts|mts)$/i.test(filename)
}

function sourceTextSample(bytes: Uint8Array) {
  if (!bytes.length) return true // an empty .ts file is valid source
  // Require strict UTF-8; a 4096-byte sample may end in the middle of a
  // multibyte character. Never silently chop arbitrary invalid UTF-8 bytes:
  // the discarded suffix must be an actual INCOMPLETE UTF-8 sequence.
  const hasBOM = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const trailing = bytes.length === 4096 ? 3 : 0
  for (let trim = 0; trim <= Math.min(trailing, bytes.length - (hasBOM ? 3 : 0)); trim++) {
    if (trim) {
      const at = bytes.length - trim
      const lead = bytes[at]!
      const expected = lead >= 0xf0 && lead <= 0xf4 ? 4 :
        lead >= 0xe0 && lead <= 0xef ? 3 :
          lead >= 0xc2 && lead <= 0xdf ? 2 : 0
      if (expected <= trim) continue
      let valid = true
      for (let i = at + 1; i < bytes.length; i++) {
        if ((bytes[i]! & 0xc0) !== 0x80) valid = false
      }
      if (trim >= 2) {
        const second = bytes[at + 1]!
        if ((lead === 0xe0 && second < 0xa0) ||
            (lead === 0xed && second > 0x9f) ||
            (lead === 0xf0 && second < 0x90) ||
            (lead === 0xf4 && second > 0x8f)) valid = false
      }
      if (!valid) continue
    }
    let value: string
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - trim))
    } catch {
      continue
    }
    for (const char of value) {
      const n = char.codePointAt(0)!
      if ((n < 32 && n !== 9 && n !== 10 && n !== 13 && n !== 12) || (n >= 127 && n < 160)) return false
    }
    return true
  }
  return false
}

export type TsFileClassification =
  | { readonly kind: "typescript"; readonly mime: "text/plain" }
  | { readonly kind: "qt-translation"; readonly mime: "application/xml" }
  | { readonly kind: "mpeg-ts"; readonly mime: "video/mp2t"; readonly packetSize: 188 | 192 | 204; readonly packets: number }
  | { readonly kind: "unknown"; readonly mime: "application/octet-stream" }

/** Shared admission for V1 Read, OXP/OFXP Exchange and attachment ingress. */
export function classifyTsFile(bytes: Uint8Array): TsFileClassification {
  if (sourceTextSample(bytes)) {
    // Qt Linguist also uses .ts for XML translations. Never tell the agent
    // these are TypeScript simply because the bytes are readable.
    const prefix = new TextDecoder().decode(bytes.subarray(0, 2048))
    if (/^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<TS(?:\s|>)/i.test(prefix)) {
      return { kind: "qt-translation", mime: "application/xml" }
    }
    return { kind: "typescript", mime: "text/plain" }
  }
  const probe = probeMpegTransportStream(bytes)
  if (probe) return { kind: "mpeg-ts", mime: "video/mp2t", ...probe }
  return { kind: "unknown", mime: "application/octet-stream" }
}

export function resolveAttachmentMime(bytes: Uint8Array, filename: string, fallback: string) {
  if (isAmbiguousTsPath(filename)) {
    const classified = classifyTsFile(bytes)
    if (classified.kind !== "unknown") return classified.mime
    // Recognize other strongly signed formats even when misnamed *.ts.
    const magic = sniffAttachmentMime(bytes, "application/octet-stream")
    if (magic !== "application/octet-stream") return magic
    return classified.mime
  }
  return sniffAttachmentMime(bytes, fallback)
}

export function sniffAttachmentMime(bytes: Uint8Array, fallback: string) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp"
  }
  // ISO BMFF: the file-type box is at offset 4. A file extension is not
  // reliable here (e.g. screen recordings renamed to .bin).
  if (startsWith(bytes.subarray(4), [0x66, 0x74, 0x79, 0x70])) {
    if (startsWith(bytes.subarray(8), [0x4d, 0x34, 0x41, 0x20]) ||
        startsWith(bytes.subarray(8), [0x4d, 0x34, 0x42, 0x20])) return "audio/mp4"
    return startsWith(bytes.subarray(8), [0x71, 0x74, 0x20, 0x20]) ? "video/quicktime" : "video/mp4"
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      startsWith(bytes.subarray(8), [0x57, 0x41, 0x56, 0x45])) return "audio/wav"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      startsWith(bytes.subarray(8), [0x41, 0x56, 0x49, 0x20])) return "video/x-msvideo"
  if (startsWith(bytes, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11,
                          0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c])) return "video/x-ms-wmv"
  if (startsWith(bytes, [0x46, 0x4f, 0x52, 0x4d]) &&
      (startsWith(bytes.subarray(8), [0x41, 0x49, 0x46, 0x46]) ||
       startsWith(bytes.subarray(8), [0x41, 0x49, 0x46, 0x43]))) return "audio/aiff"
  if (startsWith(bytes, [0x66, 0x4c, 0x61, 0x43])) return "audio/flac"
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg"
  // ADTS AAC sync word; avoid misclassifying it as an MPEG Layer audio frame.
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) return "audio/aac"
  // An MP3 frame has a 32-bit header, not merely a 0xff 0xe0 prefix. Reject
  // reserved versions/layers, absent bitrate and sample-rate indices.
  const mp3Frame = bytes.length >= 4 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 &&
    ((bytes[1]! >> 3) & 3) !== 1 && ((bytes[1]! >> 1) & 3) !== 0 &&
    ((bytes[2]! >> 4) & 15) > 0 && ((bytes[2]! >> 4) & 15) < 15 &&
    ((bytes[2]! >> 2) & 3) !== 3
  if (startsWith(bytes, [0x49, 0x44, 0x33]) || mp3Frame) return "audio/mpeg"
  // WebM uses EBML; do not classify arbitrary Matroska files as WebM.
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]) && Buffer.from(bytes.subarray(0, 128)).includes(Buffer.from("webm"))) {
    return "video/webm"
  }
  if (probeMpegTransportStream(bytes)) return "video/mp2t"

  // Extension-derived MIME is merely a hint. When a claimed audio/video file
  // has no recognized signature, do not hand arbitrary binary bytes to the
  // provider or to an external decoder under the asserted media type.
  if (isAudioAttachment(fallback) || isVideoAttachment(fallback)) return "application/octet-stream"
  return fallback
}
