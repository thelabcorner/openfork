import { describe, expect, test } from "bun:test"
import {
  classifyTsFile,
  isAmbiguousTsPath,
  isAudioAttachment,
  isMedia,
  isVideoAttachment,
  probeMpegTransportStream,
  resolveAttachmentMime,
  sniffAttachmentMime,
} from "../../src/util/media"

const ascii = (s: string) => Buffer.from(s, "ascii")

function packetizedTs(width: 188 | 192 | 204, packets = 8) {
  const prefix = width === 192 ? 4 : 0
  const buffer = Buffer.alloc(width * packets)
  for (let i = 0; i < packets; i++) {
    const at = i * width + prefix
    buffer[at] = 0x47
    buffer[at + 1] = 0x40
    buffer[at + 2] = 0
    buffer[at + 3] = 0x10 | (i & 0x0f)
    for (let j = at + 4; j < at + 188; j++) buffer[j] = (j * 19 + i * 29) & 255
  }
  return buffer
}

describe("multimodal media admission", () => {
  test.each([
    ["MP4", Buffer.concat([Buffer.from([0, 0, 0, 24]), ascii("ftypisom")]), "video/mp4"],
    ["MOV", Buffer.concat([Buffer.from([0, 0, 0, 24]), ascii("ftypqt  ")]), "video/quicktime"],
    ["AVI", Buffer.concat([ascii("RIFF"), Buffer.alloc(4), ascii("AVI ")]), "video/x-msvideo"],
    ["WMV", Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11,
      0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]), "video/x-ms-wmv"],
    ["WebM", Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), ascii("webm")]), "video/webm"],
    ["WAV", Buffer.concat([ascii("RIFF"), Buffer.alloc(4), ascii("WAVE")]), "audio/wav"],
    ["FLAC", ascii("fLaC"), "audio/flac"],
    ["OGG", ascii("OggS"), "audio/ogg"],
    ["MP3", ascii("ID3"), "audio/mpeg"],
    ["M4A", Buffer.concat([Buffer.from([0, 0, 0, 24]), ascii("ftypM4A ")]), "audio/mp4"],
    ["AIFF", Buffer.concat([ascii("FORM"), Buffer.alloc(4), ascii("AIFF")]), "audio/aiff"],
  ] as const)("%s magic overrides arbitrary binary extension", (_, bytes, expected) => {
    expect(sniffAttachmentMime(bytes, "application/octet-stream")).toBe(expected)
    expect(isMedia(expected)).toBe(true)
    expect(isVideoAttachment(expected) || isAudioAttachment(expected)).toBe(true)
  })

  test("unidentified and truncated data do not become media", () => {
    expect(sniffAttachmentMime(ascii("arbitrary text"), "application/octet-stream")).toBe("application/octet-stream")
    expect(sniffAttachmentMime(Buffer.from([0, 0, 0, 24, 0x66, 0x74]), "application/octet-stream")).toBe("application/octet-stream")
    expect(isMedia("application/octet-stream")).toBe(false)
    for (const claimed of ["video/mp4", "video/webm", "video/quicktime", "audio/wav", "audio/mpeg", "audio/mp4"]) {
      expect(sniffAttachmentMime(ascii("not a media file"), claimed)).toBe("application/octet-stream")
      expect(sniffAttachmentMime(new Uint8Array(), claimed)).toBe("application/octet-stream")
    }
  })
})

describe(".ts / .mts MPEG transport stream vs TypeScript", () => {
  test.each([188, 192, 204] as const)("recognizes %i-byte sync and packet headers", (width) => {
    const bytes = packetizedTs(width)
    expect(probeMpegTransportStream(bytes)).toMatchObject({ packetSize: width, packets: 8 })
    expect(classifyTsFile(bytes)).toMatchObject({ kind: "mpeg-ts", mime: "video/mp2t", packetSize: width })
    expect(resolveAttachmentMime(bytes, "recording.ts", "text/plain")).toBe("video/mp2t")
    expect(resolveAttachmentMime(bytes, "recording.MTS", "video/mp2t")).toBe("video/mp2t")
    expect(sniffAttachmentMime(bytes, "application/octet-stream")).toBe("video/mp2t")
    expect(isVideoAttachment("video/mp2t")).toBe(true)
  })

  test("rejects lone sync, truncated streams and malformed packet headers", () => {
    expect(probeMpegTransportStream(Buffer.from([0x47, 0x40, 0, 0x10]))).toBeUndefined()
    expect(classifyTsFile(packetizedTs(188, 3)).kind).toBe("unknown")
    const fake = packetizedTs(188)
    for (let p = 0; p < 8; p++) fake[p * 188 + 3] = 0
    expect(probeMpegTransportStream(fake)).toBeUndefined()
    expect(resolveAttachmentMime(fake, "fake.ts", "video/mp2t")).toBe("application/octet-stream")
    expect(probeMpegTransportStream(Buffer.alloc(2048, 0x47))).toBeUndefined()
  })

  test("does not promote entirely printable TypeScript into video even with forged sync cadence", () => {
    const source = Buffer.alloc(188 * 8, 0x20)
    for (let i = 0; i < 8; i++) {
      const at = i * 188
      source.write("GABP", at, "ascii")
    }
    source.write("export const video = false;", 8, "ascii")
    expect(probeMpegTransportStream(source)).toBeUndefined()
    expect(classifyTsFile(source).kind).toBe("typescript")
    expect(resolveAttachmentMime(source, "forged.ts", "video/mp2t")).toBe("text/plain")
    expect(resolveAttachmentMime(Buffer.from("ID3 is just a variable name"), "id.ts", "video/mp2t")).toBe("text/plain")
  })

  test("UTF-8 TypeScript remains text regardless of video MIME hints", () => {
    const sources = [
      "export interface Video { source: string }\nexport const enabled = true\n",
      "\uFEFF// TypeScript source with BOM\nexport default class Renderer {}",
      "// A comment-only TypeScript module\n",
      "export const emoji = '⚗️'\n",
      "",
    ]
    for (const source of sources) {
      const bytes = Buffer.from(source)
      expect(classifyTsFile(bytes)).toMatchObject({ kind: "typescript", mime: "text/plain" })
      expect(resolveAttachmentMime(bytes, "C:\\repo\\src\\file.TS", "video/mp2t")).toBe("text/plain")
      expect(resolveAttachmentMime(bytes, "/app/module.mts", "video/mp2t")).toBe("text/plain")
    }
    expect(isAmbiguousTsPath("src/index.ts")).toBe(true)
    expect(isAmbiguousTsPath("src/index.tsx")).toBe(false)
    expect(isAmbiguousTsPath("src/record.m2ts")).toBe(false)
  })

  test("Qt Linguist .ts XML is not misreported as TypeScript", () => {
    const bytes = Buffer.from('<?xml version="1.0"?><TS version="2.1" language="en_US"><context/></TS>')
    expect(classifyTsFile(bytes)).toMatchObject({ kind: "qt-translation", mime: "application/xml" })
    expect(resolveAttachmentMime(bytes, "translations/en.ts", "video/mp2t")).toBe("application/xml")
  })

  test("rejects opaque binary, retaining other strongly identified formats", () => {
    expect(resolveAttachmentMime(Buffer.from([0x47, 0, 0xff, 0x10]), "clip.ts", "video/mp2t")).toBe("application/octet-stream")
    expect(resolveAttachmentMime(Buffer.from([0xff, 0xff, 0]), "types.ts", "video/mp2t")).toBe("application/octet-stream")
    expect(resolveAttachmentMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "photo.ts", "video/mp2t")).toBe("image/jpeg")
    expect(sniffAttachmentMime(Buffer.from("export const x = 1"), "video/mp2t")).toBe("application/octet-stream")
  })

  test("does not accept incomplete UTF-8 except at the 4096-byte sample boundary", () => {
    expect(classifyTsFile(Buffer.from([0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0xff])).kind).toBe("unknown")
    const truncatedSample = Buffer.concat([Buffer.alloc(4095, 0x20), Buffer.from([0xe2])])
    expect(classifyTsFile(truncatedSample).kind).toBe("typescript")
    expect(classifyTsFile(Buffer.concat([Buffer.alloc(4095, 0x20), Buffer.from([0xff])])).kind).toBe("unknown")
    expect(classifyTsFile(Buffer.concat([Buffer.alloc(4094, 0x20), Buffer.from([0xe0, 0x80])])).kind).toBe("unknown")
    expect(classifyTsFile(Buffer.concat([Buffer.alloc(4094, 0x20), Buffer.from([0xe2, 0x82])])).kind).toBe("typescript")
  })
})
