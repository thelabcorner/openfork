import { spawn } from "node:child_process"
import * as path from "node:path"
import { probeMpegTransportStream } from "@/util/media"

const MAX_INPUT = 20 * 1024 * 1024
const MAX_OUTPUT = 1024 * 1024
let workingExecutable: string | undefined
const FALLBACK_SAMPLE_SECONDS = 4
const TILES = 6

function candidates() {
  const winGet = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ffmpeg.exe")
    : undefined
  return [...new Set([workingExecutable, process.env.OPENFORK_FFMPEG_PATH, "ffmpeg", winGet].filter((x): x is string => !!x))]
}

/** Probe only container duration. Never expose filenames, media streams, or metadata from untrusted input. */
async function probeDuration(executable: string, input: Uint8Array, signal?: AbortSignal): Promise<number | undefined> {
  const ffprobe = executable.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1")
  if (ffprobe === executable) return undefined
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(ffprobe, [
        "-v", "error", "-protocol_whitelist", "pipe", "-i", "pipe:0",
        "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1",
      ], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
    } catch { resolve(undefined); return }
    let done = false
    let output = ""
    const finish = (value?: number) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      resolve(value)
    }
    const abort = () => { child.kill(); finish() }
    const timer = setTimeout(abort, 2000)
    timer.unref?.()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) return abort()
    child.once("error", () => finish())
    child.stdout?.on("data", (part: Buffer) => {
      if (output.length + part.byteLength > 128) return abort()
      output += part.toString("utf8")
    })
    child.once("close", (code) => {
      if (code !== 0) return finish()
      const duration = Number(output.trim())
      finish(Number.isFinite(duration) && duration > 0 && duration <= 86_400 ? duration : undefined)
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end(Buffer.from(input))
  })
}

function extract(executable: string, input: Uint8Array, intervalSeconds: number, signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      // Input arrives only over stdin: no local-path interpolation or network
      // protocol access. Only a sampled six-tile JPEG can escape stdout.
      child = spawn(executable, [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-protocol_whitelist", "pipe", "-i", "pipe:0",
        "-vf", `fps=1/${intervalSeconds.toFixed(3)},scale=320:-2,tile=3x2`,
        "-frames:v", "1", "-q:v", "6", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
      ], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
    } catch {
      resolve(undefined)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const cleanup = () => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
    }
    const finish = (value?: string) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const abort = () => {
      child.kill()
      finish()
    }
    const timeout = setTimeout(abort, 6000)
    timeout.unref?.()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) return abort()
    child.once("error", () => finish())
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > MAX_OUTPUT) return abort()
      chunks.push(chunk)
    })
    child.once("close", (code) => {
      if (code !== 0 || settled || size < 4) return finish()
      const bytes = Buffer.concat(chunks)
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return finish()
      finish(bytes.toString("base64"))
    })
    child.stdin!.on("error", () => {
      // Invalid media can close the input pipe before all bytes are consumed.
    })
    child.stdin!.end(Buffer.from(input))
  })
}

export interface VideoContactSheetEvidence {
  readonly data: string
  readonly intervalSeconds: number
  /** Probe success means samples span the clip approximately, NOT that every frame was inspected. */
  readonly durationSeconds?: number
  readonly maxFrames: number
}

/** Bounded temporal sampling; whole-file coverage when duration probing succeeds. */
export async function videoContactSheetEvidence(input: Uint8Array, signal?: AbortSignal): Promise<VideoContactSheetEvidence | undefined> {
  if (signal?.aborted || input.byteLength === 0 || input.byteLength > MAX_INPUT) return undefined
  for (const executable of candidates()) {
    if (signal?.aborted) return undefined
    const duration = await probeDuration(executable, input, signal)
    // Six timeline positions across the clip, or a conservative first-24s
    // sample if the duration is unknown. Avoid duplicating 6 frames on tiny clips.
    const intervalSeconds = duration === undefined ? FALLBACK_SAMPLE_SECONDS :
      Math.max(0.5, Math.min(86_400, duration / TILES))
    const output = await extract(executable, input, intervalSeconds, signal)
    if (output) {
      workingExecutable = executable
      return {
        data: output,
        intervalSeconds,
        ...(duration === undefined ? {} : { durationSeconds: duration }),
        maxFrames: TILES,
      }
    }
  }
  return undefined
}

/** Compatibility surface for existing callers that only need the JPEG bytes. */
export async function videoContactSheet(input: Uint8Array, signal?: AbortSignal): Promise<string | undefined> {
  return (await videoContactSheetEvidence(input, signal))?.data
}

/**
 * Lossless container remux for structurally verified MPEG transport streams.
 * Never call this on user text: the caller must have positively detected
 * MPEG-TS packet structure before invoking a decoder.
 *
 * Unlike merely relabeling a .ts as .mp4, this repackages elementary video/
 * audio streams into genuine fragmented ISO-BMFF. Unsupported codecs fail
 * closed instead of silently substituting a lossy transcode.
 */
export async function remuxMpegTransportStream(input: Uint8Array, signal?: AbortSignal): Promise<Uint8Array | undefined> {
  if (signal?.aborted || input.byteLength === 0 || input.byteLength > MAX_INPUT) return undefined
  if (!probeMpegTransportStream(input.subarray(0, 4096))) return undefined
  for (const executable of candidates()) {
    if (signal?.aborted) return undefined
    const output = await new Promise<Uint8Array | undefined>((resolve) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(executable, [
          "-hide_banner", "-loglevel", "error", "-nostdin",
          "-protocol_whitelist", "pipe", "-f", "mpegts", "-i", "pipe:0",
          "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
          "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1",
        ], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
      } catch { resolve(undefined); return }
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const cleanup = () => {
        clearTimeout(timeout)
        signal?.removeEventListener("abort", abort)
      }
      const finish = (result?: Uint8Array) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      const abort = () => { child.kill(); finish() }
      const timeout = setTimeout(abort, 8_000)
      timeout.unref?.()
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) return abort()
      child.once("error", () => finish())
      child.stdout?.on("data", (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > MAX_INPUT) return abort()
        chunks.push(chunk)
      })
      child.once("close", (code) => {
        if (code !== 0 || settled || size < 16) return finish()
        const bytes = Buffer.concat(chunks)
        // The output must be an actual ISO base-media file (ftyp box), not a
        // raw TS stream in a string labeled image/video/mp4.
        if (bytes.toString("ascii", 4, 8) !== "ftyp") return finish()
        finish(bytes)
      })
      child.stdin?.on("error", () => { /* Early decoder rejection is expected. */ })
      child.stdin?.end(Buffer.from(input))
    })
    if (output) {
      workingExecutable = executable
      return output
    }
  }
  return undefined
}
