import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { videoContactSheet, videoContactSheetEvidence, remuxMpegTransportStream } from "../../src/exchange/media-preview"
import { probeMpegTransportStream } from "../../src/util/media"

const winget = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ffmpeg.exe")
  : undefined
const ffmpeg = [process.env.OPENFORK_FFMPEG_PATH, winget, "ffmpeg"]
  .filter((x): x is string => !!x)
  .find((exe) => exe === "ffmpeg" || existsSync(exe))

test("MCP video preview transcodes an actual MP4 into a bounded JPEG tile without pathname ingress", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openfork-video-preview-"))
  try {
    const movie = path.join(dir, "frames.mp4")
    const result = spawnSync(ffmpeg || "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
      "-i", "testsrc2=size=160x90:rate=1", "-t", "26",
      "-vcodec", "mpeg4", "-q:v", "8", movie,
    ], { timeout: 15000, windowsHide: true })
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return
    expect(result.status).toBe(0)
    const data = readFileSync(movie)
    expect(data.byteLength).toBeGreaterThan(500)
    const jpeg = await videoContactSheet(data)
    expect(jpeg).toBeDefined()
    const output = Buffer.from(jpeg!, "base64")
    expect(output[0]).toBe(0xff)
    expect(output[1]).toBe(0xd8)
    expect(output.byteLength).toBeLessThan(1024 * 1024)
    const evidence = await videoContactSheetEvidence(data)
    expect(evidence?.maxFrames).toBe(6)
    expect(evidence?.data).toBeDefined()
    if (ffmpeg !== "ffmpeg" && ffmpeg && existsSync(ffmpeg.replace(/ffmpeg\.exe$/i, "ffprobe.exe"))) {
      expect(evidence?.durationSeconds).toBeGreaterThan(25)
      expect(evidence?.durationSeconds).toBeLessThan(27)
      expect(evidence?.intervalSeconds).toBeGreaterThan(4)
      expect(evidence?.intervalSeconds).toBeLessThan(5)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 30000)

test("MCP video preview rejects empty, oversized and cancelled input without invoking FFmpeg", async () => {
  expect(await videoContactSheet(new Uint8Array())).toBeUndefined()
  expect(await videoContactSheet(new Uint8Array(20 * 1024 * 1024 + 1))).toBeUndefined()
  const controller = new AbortController()
  controller.abort()
  expect(await videoContactSheet(new Uint8Array([0, 1, 2, 3]), controller.signal)).toBeUndefined()
})

test("A genuine MPEG-TS video is losslessly remuxed into real MP4, not relabeled TS", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openfork-mpegts-remux-"))
  try {
    const video = path.join(dir, "input.ts")
    const result = spawnSync(ffmpeg || "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
      "-i", "testsrc2=size=160x90:rate=10", "-t", "2",
      "-c:v", "libx264", "-preset", "ultrafast", "-f", "mpegts", video,
    ], { timeout: 15000, windowsHide: true })
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return
    expect(result.status).toBe(0)
    const data = readFileSync(video)
    expect(probeMpegTransportStream(data.subarray(0, 4096))).toMatchObject({ packetSize: 188 })
    const mp4 = await remuxMpegTransportStream(data)
    expect(mp4).toBeDefined()
    expect(Buffer.from(mp4!).toString("ascii", 4, 8)).toBe("ftyp")
    expect(mp4!.byteLength).toBeLessThan(20 * 1024 * 1024)
    expect(mp4!.byteLength).toBeGreaterThan(200)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 30000)

test("MPEG-TS normalization rejects empty, oversized and aborted input", async () => {
  expect(await remuxMpegTransportStream(Buffer.alloc(0))).toBeUndefined()
  expect(await remuxMpegTransportStream(Buffer.alloc(20 * 1024 * 1024 + 1))).toBeUndefined()
  const abort = new AbortController()
  abort.abort()
  expect(await remuxMpegTransportStream(Buffer.from([0x47, 0x40, 0, 0x10]), abort.signal)).toBeUndefined()
})
