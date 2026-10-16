import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { randomUUID } from "crypto"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OxpConfig } from "@/oxp/config"
import { OxpGrounding } from "@/oxp/grounding"
import { OxpRead } from "@/oxp/read"
import { ExchangeRead } from "@/exchange/read"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { OxpRoot } from "@/oxp/root"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-read-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const globalLayer = Global.layerWith({ config: configDir, state: stateDir })
const layer = AppNodeBuilder.build(
  LayerNode.group([OxpRead.node, OxpRoot.node, OxpConfig.node, OxpGrounding.node, FSUtil.node]),
  [[Global.node, globalLayer]],
)
const it = testEffect(layer)

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})

afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

describe("OxpRead", () => {
  it.live(
    "rejects a symbol window when its located file snapshot is stale before the read",
    Effect.gen(function* () {
      const filesystem = yield* FSUtil.Service
      const rootDir = path.join(suite, "stale-window")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const filename = path.join(rootDir, "source.ts")
      yield* Effect.promise(() => fs.writeFile(filename, "export function before() {}\n"))
      const exit = yield* ExchangeRead.execute(
        filesystem,
        { path: filename, displayPath: "/approved/source.ts", expectedFingerprint: "1970:1", action: "read" },
        { revalidate: () => Effect.die("stale symbol window must be rejected before egress") },
      ).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(JSON.stringify(exit)).toContain("Exchange.Conflict")
    }),
  )

  it.live(
    "resolves native-style around windows via the shared cached Symbols locator without edit grounding",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const grounding = yield* OxpGrounding.Service
      const rootDir = path.join(suite, "around-workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const file = path.join(rootDir, "source.ts")
      yield* Effect.promise(() =>
        fs.writeFile(
          file,
          [
            "const header = 1",
            "export function parseAlpha(value: string) {",
            "  return value.length",
            "}",
            "export function parseBeta() { return 3 }",
            "",
          ].join("\n"),
        ),
      )
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true, process: false })
      const result = yield* read.execute({ rootID: root.id, path: "source.ts", action: "around", symbol: "parseAlpha" })
      expect(result.output).toContain(`/${root.alias}/source.ts`)
      expect(result.output).toContain("parseAlpha")
      expect(result.output).not.toContain(rootDir)
      expect(result.metadata).toMatchObject({
        action: "around",
        symbol: "parseAlpha",
        grounded: false,
        fallback: false,
      })
      const current = yield* config.get()
      expect(grounding.scoped(current.connector.id).get(root.id, file)).toBeUndefined()
      const inferred = yield* read.execute({ rootID: root.id, path: "source.ts", symbol: "parseBeta", limit: 4 })
      expect(inferred.metadata).toMatchObject({ action: "around", symbol: "parseBeta" })
      const fallback = yield* read.execute({
        rootID: root.id,
        path: "source.ts",
        action: "around",
        symbol: "return value.length",
      })
      expect(fallback.metadata).toMatchObject({ action: "around", fallback: true, symbolLine: 3 })
      expect(fallback.output).toContain("3:   return value.length")
      const missing = yield* read
        .execute({ rootID: root.id, path: "source.ts", action: "around", symbol: "absentSymbol" })
        .pipe(Effect.flip)
      expect(missing._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(missing.detail).not.toContain(rootDir)
    }),
  )

  it.live(
    "reuses the shared Symbols outline without materializing a Session or edit-grounding a file",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const grounding = yield* OxpGrounding.Service
      const rootDir = path.join(suite, "outline-workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const file = path.join(rootDir, "source.ts")
      yield* Effect.promise(() =>
        fs.writeFile(
          file,
          "export function parseAlpha(value: string) { return value.length }\nexport const item = 2\n",
        ),
      )
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true, process: false })
      const result = yield* read.execute({ rootID: root.id, path: "source.ts", action: "outline" })
      expect(result.output).toContain("<symbols-outline")
      expect(result.output).toContain('name="parseAlpha"')
      expect(result.output).toContain('file="source.ts"')
      expect(result.output).not.toContain(rootDir)
      expect(result.metadata).toMatchObject({ action: "outline", file: `/${root.alias}/source.ts`, grounded: false })
      const current = yield* config.get()
      expect(grounding.scoped(current.connector.id).get(root.id, file)).toBeUndefined()
      const deniedDirectory = yield* read.execute({ rootID: root.id, path: ".", action: "outline" }).pipe(Effect.flip)
      expect(deniedDirectory._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(deniedDirectory.detail).not.toContain(rootDir)
    }),
  )

  it.live(
    "shares native per-file grep and never upgrades snippet matches to full-file edit grounding",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const grounding = yield* OxpGrounding.Service
      const rootDir = path.join(suite, "grep-workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const file = path.join(rootDir, "source.ts")
      yield* Effect.promise(() => fs.writeFile(file, "const alpha = 1\nconst beta = 2\nalpha++\n"))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* read.execute({ rootID: root.id, path: "source.ts", action: "grep", pattern: "alpha" })
      expect(result.title).toContain("grep")
      expect(result.output).toContain(`path="/${root.alias}/source.ts"`)
      expect(result.output).toContain("1: const alpha = 1")
      expect(result.output).toContain("3: alpha++")
      expect(result.output).not.toContain("2: const beta = 2")
      expect(result.output).not.toContain(rootDir)
      expect(result.metadata).toMatchObject({ action: "grep", matches: 2 })
      expect(result.metadata).not.toHaveProperty("grounded")
      const current = yield* config.get()
      expect(grounding.scoped(current.connector.id).get(root.id, file)).toBeUndefined()

      const inferred = yield* read.execute({ rootID: root.id, path: "source.ts", pattern: "beta" })
      expect(inferred.output).toContain("2: const beta = 2")
      expect(inferred.output).not.toContain("1: const alpha = 1")
      const malformed = yield* read.execute({ rootID: root.id, path: "source.ts", action: "grep", pattern: "[" })
      expect(malformed.output).toContain('count="0"')

      const missingPattern = yield* read
        .execute({ rootID: root.id, path: "source.ts", action: "grep" })
        .pipe(Effect.flip)
      expect(missingPattern._tag).toBe("OXP_INVALID_ARGUMENT")
      const badBatch = yield* read
        .execute({
          rootID: root.id,
          reads: [{ path: "source.ts" }],
          pattern: "alpha",
        })
        .pipe(Effect.flip)
      expect(badBatch._tag).toBe("OXP_INVALID_ARGUMENT")
    }),
  )

  it.live(
    "returns typed root-required for relative paths without explicit root identity",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const read = yield* OxpRead.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const error = yield* read.execute({ path: "relative.txt" }).pipe(Effect.flip)
      expect(error._tag).toBe("OXP_ROOT_REQUIRED")
      expect(error.detail).toContain("explicit approved root")
    }),
  )

  it.live(
    "reads bounded text through virtual paths and captures connector-scoped grounding",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const grounding = yield* OxpGrounding.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const file = path.join(rootDir, "a.ts")
      yield* Effect.promise(() => fs.writeFile(file, "one\ntwo\nthree\n"))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* read.execute({ rootID: root.id, path: "a.ts", offset: 2, limit: 1 })
      const current = yield* config.get()

      expect(result.output).toContain(`/${root.alias}/a.ts`)
      expect(result.output).toContain("2: two")
      expect(result.output).not.toContain(rootDir)
      expect(result.metadata).toMatchObject({
        grounded: true,
        offset: 2,
        nextOffset: 3,
        truncated: true,
      })
      expect(grounding.scoped(current.connector.id).get(root.id, file)).toBeTruthy()
    }),
  )

  it.live(
    "lists directories without grounding them as file content",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(path.join(rootDir, "src"), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "src", "a.ts"), "a"))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* read.execute({ rootID: root.id, path: "src" })
      expect(result.output).toContain("a.ts")
      expect(result.metadata?.directory).toBe(true)
      expect(result.output).not.toContain(rootDir)
    }),
  )

  it.live(
    "returns typed attachment handles for supported binary media without embedding native paths",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(rootDir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      )
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* read.execute({ rootID: root.id, path: "image.png" })
      expect(result.attachments?.[0]?.handle).toBe(`/${root.alias}/image.png`)
      expect(result.attachments?.[0]?.mediaType).toBe("image/png")
      expect(result.mediaContent?.[0]).toMatchObject({ type: "image", mimeType: "image/png" })
      expect(result.metadata).toMatchObject({ mediaDelivery: "inline-image" })
      expect(result.mediaContent?.[0]?.data).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"))
      expect(JSON.stringify(result)).not.toContain(rootDir)
    }),
  )

  it.live(
    "returns approved-root MP4 and WAV descriptors without exposing local bytes or absolute paths",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const rootDir = path.join(suite, "media")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const mp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0])
      const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
      yield* Effect.promise(() => Promise.all([
        fs.writeFile(path.join(rootDir, "video.bin"), mp4),
        fs.writeFile(path.join(rootDir, "audio.bin"), wav),
      ]))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const result = yield* read.execute({
        rootID: root.id,
        reads: [{ path: "video.bin" }, { path: "audio.bin" }],
      })
      expect(result.attachments).toMatchObject([
        { handle: `/${root.alias}/video.bin`, mediaType: "video/mp4", bytes: mp4.length },
        { handle: `/${root.alias}/audio.bin`, mediaType: "audio/wav", bytes: wav.length },
      ])
      expect(result.output).toContain("Video attachment available")
      expect(result.output).toContain("Audio attachment available")
      expect(result.output).toContain("content NOT delivered to the model")
      // Batch reads carry handles only; no unbounded 8x binary duplication.
      expect(result.mediaContent).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain(rootDir)
      expect(JSON.stringify(result)).not.toContain(mp4.toString("base64"))
    }),
  )

  it.live(
    "uses the same TypeScript / MPEG-TS discriminator for OXP reads and never leaks transport bytes into text",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const directory = path.join(suite, "ts-collision")
      yield* Effect.promise(() => fs.mkdir(directory))
      const source = "export const frames: number[] = [1, 2, 3]\n"
      const ts = Buffer.alloc(188 * 8)
      for (let index = 0; index < 8; index++) {
        const at = index * 188
        ts[at] = 0x47
        ts[at + 1] = 0x40
        ts[at + 3] = 0x10 | index
        ts.fill(0xff, at + 4, at + 188)
      }
      yield* Effect.promise(() => Promise.all([
        fs.writeFile(path.join(directory, "source.ts"), source),
        fs.writeFile(path.join(directory, "capture.ts"), ts),
        fs.writeFile(path.join(directory, "uncertain.ts"), Buffer.from([0x47, 0, 0xff, 0x10])),
      ]))
      const root = yield* roots.approve(directory)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const text = yield* read.execute({ rootID: root.id, path: "source.ts" })
      expect(text.attachments).toBeUndefined()
      expect(text.output).toContain("TypeScript source candidate")
      expect(text.output).toContain("export const frames")
      expect(text.metadata).toMatchObject({ detectedFileKind: "typescript-candidate" })

      const mixed = yield* read.execute({
        rootID: root.id,
        reads: [{ path: "source.ts" }, { path: "capture.ts" }],
      })
      expect(mixed.attachments?.[0]).toMatchObject({
        handle: `/${root.alias}/capture.ts`, mediaType: "video/mp2t",
      })
      expect(mixed.output).toContain("content NOT delivered to the model")
      expect(mixed.mediaContent).toBeUndefined()
      expect(JSON.stringify(mixed)).not.toContain(ts.toString("base64"))
      expect(JSON.stringify(mixed)).not.toContain(directory)

      const denied = yield* read.execute({ rootID: root.id, path: "uncertain.ts" }).pipe(Effect.flip)
      expect(denied.detail).toContain("Ambiguous .ts/.mts file")
    }),
  )

  it.live(
    "samples a real .ts MPEG transport stream into OXP MCP JPEG evidence rather than source text",
    Effect.gen(function* () {
      const exe = process.env.OPENFORK_FFMPEG_PATH ??
        (process.env.LOCALAPPDATA
          ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ffmpeg.exe")
          : "ffmpeg")
      if (exe !== "ffmpeg" && !existsSync(exe)) return
      const generated = spawnSync(exe, [
        "-hide_banner", "-loglevel", "error", "-f", "lavfi",
        "-i", "testsrc2=size=160x90:rate=10", "-t", "2",
        "-c:v", "libx264", "-preset", "ultrafast", "-f", "mpegts", "pipe:1",
      ], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
      if (generated.error && (generated.error as NodeJS.ErrnoException).code === "ENOENT") return
      expect(generated.status).toBe(0)
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const directory = path.join(suite, "ts-video-actual")
      yield* Effect.promise(() => fs.mkdir(directory))
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "video.ts"), generated.stdout))
      const root = yield* roots.approve(directory)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const result = yield* read.execute({ rootID: root.id, path: "video.ts" })
      expect(result.metadata).toMatchObject({
        detectedFileKind: "mpeg-transport-stream", mediaType: "video/mp2t", mediaDelivery: "sampled-video",
      })
      expect(result.mediaContent?.[0]?.type).toBe("image")
      expect(result.mediaContent?.[0]?.mimeType).toBe("image/jpeg")
      expect(result.output).toContain("Individual transient frames may be missed")
      expect(JSON.stringify(result)).not.toContain(directory)
      expect(JSON.stringify(result)).not.toContain(generated.stdout.toString("base64"))
    }),
  )

  it.live(
    "embeds a small approved WAV as native MCP audio content in single-target read",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const rootDir = path.join(suite, "audio-single")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "voice.bin"), wav))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const result = yield* read.execute({ rootID: root.id, path: "voice.bin" })
      expect(result.mediaContent).toEqual([{ type: "audio", mimeType: "audio/wav", data: wav.toString("base64") }])
      expect(result.metadata).toMatchObject({ mediaType: "audio/wav", previewType: "native-media" })
      expect(result.metadata).toMatchObject({ mediaDelivery: "inline-audio" })
      expect(JSON.stringify(result)).not.toContain(rootDir)
    }),
  )

  it.live(
    "reports descriptor-only for a malformed signature-plausible video instead of implying frames were inspected",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const rootDir = path.join(suite, "invalid-video")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "broken.mp4"),
        Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0])))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const result = yield* read.execute({ rootID: root.id, path: "broken.mp4" })
      expect(result.metadata).toMatchObject({ mediaDelivery: "descriptor-only", mediaType: "video/mp4" })
      expect(result.output).toContain("content NOT delivered to the model")
      expect(result.mediaContent).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain(rootDir)
    }),
  )

  it.live(
    "treats a spoofed .mp4 pathname as plain text without an MCP media block",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const rootDir = path.join(suite, "spoofed-video")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "spoofed.mp4"), "not a media file\n"))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const result = yield* read.execute({ rootID: root.id, path: "spoofed.mp4" })
      expect(result.output).toContain("not a media file")
      expect(result.attachments).toBeUndefined()
      expect(result.mediaContent).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain(rootDir)
    }),
  )

  it.live(
    "batches known windows with a shared root default and refuses conflicting addressing",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() =>
        Promise.all([
          fs.writeFile(path.join(rootDir, "a.txt"), "a\n"),
          fs.writeFile(path.join(rootDir, "b.txt"), "b\n"),
        ]),
      )
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* read.execute({
        rootID: root.id,
        reads: [{ path: "a.txt" }, { rootID: root.id, path: "b.txt" }],
      })
      expect(result.output).toContain(`/${root.alias}/a.txt`)
      expect(result.output).toContain(`/${root.alias}/b.txt`)
      const mixed = yield* read
        .execute({ path: `/${root.alias}/a.txt`, reads: [{ rootID: root.id, path: "b.txt" }] })
        .pipe(Effect.flip)
      expect(mixed._tag).toBe("OXP_INVALID_ARGUMENT")

      const otherDir = path.join(suite, "workspace-other")
      yield* Effect.promise(() => fs.mkdir(otherDir))
      const other = yield* roots.approve(otherDir)
      const conflicting = yield* read
        .execute({
          rootID: root.id,
          reads: [{ rootID: other.id, path: "other.txt" }],
        })
        .pipe(Effect.flip)
      expect(conflicting._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(conflicting.detail).toContain("conflicts")
    }),
  )

  it.live(
    "returns a virtual-path not-found error for a missing direct target",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const error = yield* read.execute({ rootID: root.id, path: "missing.txt" }).pipe(Effect.flip)
      expect(error._tag).toBe("OXP_NOT_FOUND")
      expect(error.detail).toContain(`/${root.alias}/missing.txt`)
      expect(error.detail).not.toContain(rootDir)
    }),
  )

  it.live(
    "preserves successful siblings when one batched read target is missing",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() =>
        Promise.all([
          fs.writeFile(path.join(rootDir, "a.txt"), "alpha\n"),
          fs.writeFile(path.join(rootDir, "c.txt"), "charlie\n"),
        ]),
      )
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* read.execute({
        rootID: root.id,
        reads: [{ path: "a.txt" }, { path: "missing.txt" }, { path: "c.txt" }],
      })

      expect(result.output).toContain(`/${root.alias}/a.txt`)
      expect(result.output).toContain(`/${root.alias}/c.txt`)
      expect(result.output).toContain('<read-error index=1 code="OXP_NOT_FOUND">')
      expect(result.output.indexOf(`/${root.alias}/a.txt`)).toBeLessThan(result.output.indexOf("<read-error index=1"))
      expect(result.output.indexOf("<read-error index=1")).toBeLessThan(result.output.indexOf(`/${root.alias}/c.txt`))
      expect(result.output).not.toContain(rootDir)
      expect(result.metadata).toMatchObject({
        action: "read",
        targets: 3,
        succeeded: 2,
        failed: 1,
        errors: [{ index: 1, code: "OXP_NOT_FOUND" }],
        items: [
          { index: 0, status: "ok" },
          { index: 1, status: "error", code: "OXP_NOT_FOUND" },
          { index: 2, status: "ok" },
        ],
      })
    }),
  )

  it.live(
    "isolates a per-item missing-root caller error while preserving explicit-root siblings",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() =>
        Promise.all([
          fs.writeFile(path.join(rootDir, "a.txt"), "alpha\n"),
          fs.writeFile(path.join(rootDir, "c.txt"), "charlie\n"),
        ]),
      )
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* read.execute({
        reads: [
          { rootID: root.id, path: "a.txt" },
          { path: "relative-without-root.txt" },
          { rootID: root.id, path: "c.txt" },
        ],
      })

      expect(result.output).toContain(`/${root.alias}/a.txt`)
      expect(result.output).toContain('<read-error index=1 code="OXP_ROOT_REQUIRED">')
      expect(result.output).toContain(`/${root.alias}/c.txt`)
      expect(result.metadata).toMatchObject({
        targets: 3,
        succeeded: 2,
        failed: 1,
        errors: [{ index: 1, code: "OXP_ROOT_REQUIRED" }],
      })
    }),
  )

  it.live(
    "fairly projects large batched siblings and returns safe per-item continuation receipts",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const large = Array.from({ length: 300 }, (_, index) => `line-${index + 1} ${"x".repeat(320)}`).join("\n") + "\n"
      yield* Effect.promise(() =>
        Promise.all([
          fs.writeFile(path.join(rootDir, "a.txt"), large),
          fs.writeFile(path.join(rootDir, "b.txt"), large.replaceAll("x", "y")),
          fs.writeFile(path.join(rootDir, "c.txt"), "charlie-visible\n"),
        ]),
      )
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* read.execute({
        rootID: root.id,
        reads: [{ path: "a.txt" }, { path: "b.txt" }, { path: "c.txt" }],
      })

      expect(result.output).toContain(`/${root.alias}/a.txt`)
      expect(result.output).toContain(`/${root.alias}/b.txt`)
      expect(result.output).toContain(`/${root.alias}/c.txt`)
      expect(result.output).toContain("charlie-visible")
      const items = result.metadata?.items as Array<Record<string, unknown>>
      expect(items[0]).toMatchObject({
        index: 0,
        status: "ok",
        path: `/${root.alias}/a.txt`,
        offset: 1,
        truncated: true,
        batchProjectionTruncated: true,
        retryOffset: 1,
      })
      expect(items[0]).not.toHaveProperty("nextOffset")
      expect(items[2]).toMatchObject({
        index: 2,
        status: "ok",
        path: `/${root.alias}/c.txt`,
        offset: 1,
        truncated: false,
      })
    }),
  )

  it.live(
    "never skips projected-away lines in single-target continuation receipts",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      const large = Array.from({ length: 1_200 }, (_, index) => `line-${index + 1} payload`).join("\n") + "\n"
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "large.txt"), large))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const first = yield* read.execute({
        rootID: root.id,
        path: "large.txt",
        offset: 1,
        limit: 1_200,
      })
      expect(first.metadata).toMatchObject({
        offset: 1,
        projectionTruncated: true,
        truncated: true,
        retryOffset: 1,
      })
      expect(first.metadata).not.toHaveProperty("nextOffset")
      const recommended = first.metadata?.recommendedLimit
      expect(typeof recommended).toBe("number")
      expect(recommended as number).toBeGreaterThan(0)
      expect(recommended as number).toBeLessThan(1_200)

      const retry = yield* read.execute({
        rootID: root.id,
        path: "large.txt",
        offset: first.metadata?.retryOffset as number,
        limit: recommended as number,
      })
      expect(retry.metadata?.projectionTruncated).toBe(false)
      expect(retry.output).toContain(`1: line-1 payload`)
      expect(retry.output).toContain(`${recommended}: line-${recommended} payload`)
      expect(retry.metadata?.nextOffset).toBe((recommended as number) + 1)

      const continued = yield* read.execute({
        rootID: root.id,
        path: "large.txt",
        offset: retry.metadata?.nextOffset as number,
        limit: 1,
      })
      expect(continued.output).toContain(`${(recommended as number) + 1}: line-${(recommended as number) + 1} payload`)
    }),
  )

  it.live(
    "does not downgrade path escape into a partial batch receipt",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.txt"), "alpha\n"))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const error = yield* read
        .execute({
          rootID: root.id,
          reads: [{ path: "a.txt" }, { path: "../escape.txt" }],
        })
        .pipe(Effect.flip)

      expect(error._tag).toBe("OXP_PATH_ESCAPE")
    }),
  )

  it.live(
    "serves 1/3/6 concurrent direct reads without widening root scope",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "fanout.txt"), "fanout\n"))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      for (const count of [1, 3, 6] as const) {
        const results = yield* Effect.all(
          Array.from({ length: count }, () => read.execute({ rootID: root.id, path: "fanout.txt" })),
          { concurrency: "unbounded" },
        )
        expect(results).toHaveLength(count)
        for (const result of results) {
          expect(result.output).toContain("fanout")
          expect(result.output).not.toContain(rootDir)
        }
      }
    }),
  )

  it.live(
    "propagates an already-cancelled invocation into the shared read executor",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "a.txt"), "hello\n"))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const controller = new AbortController()
      controller.abort()

      const cancelled = yield* read.execute({ rootID: root.id, path: "a.txt" }, controller.signal).pipe(Effect.flip)
      expect(cancelled._tag).toBe("OXP_CANCELLED")
    }),
  )
})
