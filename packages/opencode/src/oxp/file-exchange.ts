import { createHash, randomUUID } from "node:crypto"
import { promises as fs, constants as fsConstants } from "node:fs"
import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"

const MAX_BYTES = 512 * 1024 * 1024
const UPLOAD_CHUNK_BYTES = 128 * 1024
const PURPOSES = ["assistants", "batch", "fine-tune", "vision", "user_data", "evals"] as const
const CHATGPT_HOSTS = new Set([
  "files.oaiusercontent.com",
  "oaidalleapiprodscus.blob.core.windows.net",
  "oaisdmntprcentralus.blob.core.windows.net",
])

export const ChatGptFile = Schema.Struct({
  download_url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
  file_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  // ChatGPT's fileParams contract requires all four properties to be declared,
  // with only download_url/file_id required. Optional values are omitted rather
  // than sent as null.
  mime_type: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  file_name: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
})

export const Parameters = Schema.Struct({
  action: Schema.Literals([
    "save_chatgpt_file",
    "upload_openai_file",
    "download_openai_file",
    "get_openai_file",
    "list_openai_files",
  ]),
  rootID: Schema.optional(OxpSchema.RootID),
  source_file: Schema.optional(ChatGptFile),
  source: Schema.optional(Schema.String),
  destination: Schema.optional(Schema.String),
  file_id: Schema.optional(Schema.String),
  purpose: Schema.optional(Schema.Literals(PURPOSES)),
  limit: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100))),
  after: Schema.optional(Schema.String),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export const ChatGptParameters = Schema.Struct({
  action: Schema.Literal("save_chatgpt_file"),
  rootID: Schema.optional(OxpSchema.RootID),
  source_file: ChatGptFile,
  destination: Schema.String,
})
export type ChatGptInput = Schema.Schema.Type<typeof ChatGptParameters>

const OpenAiLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
const OpenAiPath = Schema.String.check(Schema.isMinLength(1))
const OpenAiFileID = Schema.String.check(Schema.isMinLength(1))

const OpenAiList = Schema.Struct({
  action: Schema.Literal("list"),
  purpose: Schema.optional(Schema.Literals(PURPOSES)),
  limit: Schema.optional(OpenAiLimit),
  after: Schema.optional(OpenAiFileID),
})
const OpenAiGet = Schema.Struct({
  action: Schema.Literal("get"),
  fileID: OpenAiFileID,
})
const OpenAiUpload = Schema.Struct({
  action: Schema.Literal("upload"),
  rootID: OxpSchema.RootID,
  path: OpenAiPath,
  purpose: Schema.optional(Schema.Literals(PURPOSES)),
})
const OpenAiDownload = Schema.Struct({
  action: Schema.Literal("download"),
  rootID: OxpSchema.RootID,
  path: OpenAiPath,
  fileID: OpenAiFileID,
})

export const OpenAiRuntimeParameters = Schema.Union([
  OpenAiList,
  OpenAiGet,
  OpenAiUpload,
  OpenAiDownload,
])
export type OpenAiRuntimeInput = Schema.Schema.Type<typeof OpenAiRuntimeParameters>

/**
 * Flat transport-safe vocabulary for connector hosts that discard root unions.
 * OpenAiRuntimeParameters remains the execution grammar.
 */
export const OpenAiParameters = Schema.Struct({
  action: Schema.Literals(["list", "get", "upload", "download"]),
  rootID: Schema.optional(OxpSchema.RootID),
  path: Schema.optional(OpenAiPath),
  fileID: Schema.optional(OpenAiFileID),
  purpose: Schema.optional(Schema.Literals(PURPOSES)),
  limit: Schema.optional(OpenAiLimit),
  after: Schema.optional(OpenAiFileID),
})
export type OpenAiInput = Schema.Schema.Type<typeof OpenAiParameters>

const openAiTransportAction = (
  action: OpenAiRuntimeInput["action"],
  fields: readonly string[],
  required: readonly string[],
) => ({
  type: "object" as const,
  properties: Object.fromEntries([
    ["action", { const: action }],
    ...fields.map((name) => [name, {}] as const),
  ]),
  required: ["action", ...required],
  additionalProperties: false as const,
})

export const OpenAiTransportConstraints = Object.freeze({
  oneOf: Object.freeze([
    openAiTransportAction("list", ["purpose", "limit", "after"], []),
    openAiTransportAction("get", ["fileID"], ["fileID"]),
    openAiTransportAction("upload", ["rootID", "path", "purpose"], ["rootID", "path"]),
    openAiTransportAction("download", ["rootID", "path", "fileID"], ["rootID", "path", "fileID"]),
  ]),
})

export function openAiInput(input: OpenAiRuntimeInput): Input {
  switch (input.action) {
    case "list":
      return {
        action: "list_openai_files",
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
        ...(input.after === undefined ? {} : { after: input.after }),
      }
    case "get":
      return { action: "get_openai_file", file_id: input.fileID }
    case "upload":
      return {
        action: "upload_openai_file",
        rootID: input.rootID,
        source: input.path,
        purpose: input.purpose,
      }
    case "download":
      return {
        action: "download_openai_file",
        rootID: input.rootID,
        destination: input.path,
        file_id: input.fileID,
      }
  }
}

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/OxpFileExchange") {}
export const use = serviceUse(Service)

type RemoteFile = {
  id: string
  filename: string
  bytes: number
  purpose: string
  created_at: number
  expires_at?: number
}

function required(value: string | undefined, field: string) {
  const result = value?.trim()
  if (!result) throw new OxpError.InvalidArgument({ detail: field + " is required" })
  return result
}

function apiKey() {
  const value = process.env.OPENCODE_OXP_OPENAI_API_KEY?.trim()
  if (!value) throw new OxpError.DependencyUnavailable({ detail: "OXP OpenAI API credential is not configured in secure storage" })
  return value
}

function parseFile(value: unknown): RemoteFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OxpError.DependencyUnavailable({ detail: "OpenAI returned malformed file metadata" })
  const row = value as Record<string, unknown>
  if (typeof row.id !== "string" || typeof row.filename !== "string" || typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || typeof row.purpose !== "string" || typeof row.created_at !== "number") {
    throw new OxpError.DependencyUnavailable({ detail: "OpenAI returned malformed file metadata" })
  }
  return {
    id: row.id,
    filename: row.filename,
    bytes: row.bytes,
    purpose: row.purpose,
    created_at: row.created_at,
    ...(typeof row.expires_at === "number" ? { expires_at: row.expires_at } : {}),
  }
}

function compact(file: RemoteFile) {
  return { ...file, expires_at: file.expires_at ?? null }
}

function fileID(value: string | undefined) {
  const id = required(value, "file_id")
  if (!/^file-[A-Za-z0-9_-]{1,240}$/.test(id)) throw new OxpError.InvalidArgument({ detail: "Invalid OpenAI file ID" })
  return id
}

async function openAi(pathname: string, init: RequestInit = {}) {
  let response: Response
  try {
    response = await fetch("https://api.openai.com/v1" + pathname, {
      ...init,
      redirect: "error",
      headers: { ...init.headers, Authorization: "Bearer " + apiKey() },
    })
  } catch {
    if (init.signal?.aborted) {
      throw new OxpError.Cancelled({ detail: "OpenAI Files request was cancelled" })
    }
    throw new OxpError.DependencyUnavailable({ detail: "OpenAI Files API could not be reached" })
  }
  return response
}

async function json(response: Response, signal?: AbortSignal) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 404) throw new OxpError.NotFound({ detail: "OpenAI file was not found" })
    throw new OxpError.DependencyUnavailable({ detail: "OpenAI Files API failed with HTTP " + response.status })
  }
  let text: string
  try {
    text = await response.text()
  } catch {
    if (signal?.aborted) {
      throw new OxpError.Cancelled({ detail: "OpenAI Files response read was cancelled" })
    }
    throw new OxpError.DependencyUnavailable({ detail: "OpenAI Files response could not be read" })
  }
  if (Buffer.byteLength(text) > 1024 * 1024) throw new OxpError.DependencyUnavailable({ detail: "OpenAI metadata response exceeded the safety limit" })
  try { return JSON.parse(text) as unknown }
  catch { throw new OxpError.DependencyUnavailable({ detail: "OpenAI returned invalid JSON metadata" }) }
}

function chatGptUrl(value: string) {
  let url: URL
  try { url = new URL(value) }
  catch { throw new OxpError.InvalidArgument({ detail: "ChatGPT supplied an invalid native file reference" }) }
  if (value.length > 16_384 || url.protocol !== "https:" || !CHATGPT_HOSTS.has(url.hostname.toLowerCase()) || (url.port && url.port !== "443") || url.username || url.password || url.hash) {
    throw new OxpError.InvalidArgument({ detail: "ChatGPT file reference uses an untrusted download URL" })
  }
  return url
}

async function chatGptDownload(value: Schema.Schema.Type<typeof ChatGptFile>, signal?: AbortSignal) {
  let url = chatGptUrl(value.download_url)
  for (let redirect = 0; redirect <= 3; redirect++) {
    let response: Response
    try { response = await fetch(url, { method: "GET", redirect: "manual", signal }) }
    catch {
      if (signal?.aborted) throw new OxpError.Cancelled({ detail: "File receive was cancelled" })
      throw new OxpError.DependencyUnavailable({ detail: "ChatGPT file could not be reached" })
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location")
      await response.body?.cancel().catch(() => undefined)
      if (!location || redirect === 3) throw new OxpError.DependencyUnavailable({ detail: "ChatGPT file download returned too many or invalid redirects" })
      url = chatGptUrl(new URL(location, url).toString())
      continue
    }
    if (!response.ok || !response.body) throw new OxpError.DependencyUnavailable({ detail: "ChatGPT file download failed with HTTP " + response.status })
    const raw = response.headers.get("content-length")
    return { response, expected: raw && /^\d+$/.test(raw) ? Number(raw) : undefined }
  }
  throw new OxpError.DependencyUnavailable({ detail: "ChatGPT file download failed" })
}

async function stableSource(file: string) {
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    const named = await fs.lstat(file)
    if (before.size > MAX_BYTES) {
      throw new OxpError.InvalidArgument({ detail: "Local upload source exceeds the 512 MiB transfer limit" })
    }
    if (!before.isFile() || !named.isFile() || named.isSymbolicLink() || before.dev !== named.dev || before.ino !== named.ino) throw new Error("unstable")
    return { handle, before }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

function multipartUpload(
  handle: Awaited<ReturnType<typeof fs.open>>,
  size: number,
  filename: string,
  purpose: string,
  signal?: AbortSignal,
) {
  const boundary = "----openfork-oxp-" + randomUUID().replaceAll("-", "")
  const safeFilename = filename.replace(/[\r\n"]/g, "_")
  const header = Buffer.from(
    "--" + boundary + "\r\n" +
      'Content-Disposition: form-data; name="purpose"\r\n\r\n' +
      purpose + "\r\n" +
      "--" + boundary + "\r\n" +
      'Content-Disposition: form-data; name="file"; filename="' + safeFilename + '"\r\n' +
      "Content-Type: application/octet-stream\r\n\r\n",
    "utf8",
  )
  const footer = Buffer.from("\r\n--" + boundary + "--\r\n", "utf8")
  const hash = createHash("sha256")
  let phase: "header" | "file" | "footer" | "done" = "header"
  let position = 0
  let digested = false

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (signal?.aborted) {
          throw new OxpError.Cancelled({ detail: "OpenAI file upload was cancelled" })
        }
        if (phase === "header") {
          phase = "file"
          controller.enqueue(header)
          return
        }
        if (phase === "file" && position < size) {
          const wanted = Math.min(UPLOAD_CHUNK_BYTES, size - position)
          const buffer = Buffer.allocUnsafe(wanted)
          const result = await handle.read(buffer, 0, wanted, position)
          if (result.bytesRead <= 0) {
            throw new OxpError.DependencyUnavailable({
              detail: "Stable upload source ended before its verified size",
            })
          }
          const chunk = buffer.subarray(0, result.bytesRead)
          position += result.bytesRead
          hash.update(chunk)
          controller.enqueue(chunk)
          return
        }
        if (phase === "file") phase = "footer"
        if (phase === "footer") {
          phase = "done"
          controller.enqueue(footer)
          controller.close()
        }
      } catch (error) {
        controller.error(error)
      }
    },
  })

  return {
    body,
    contentType: "multipart/form-data; boundary=" + boundary,
    contentLength: header.byteLength + size + footer.byteLength,
    sha256() {
      if (position !== size || phase !== "done") {
        throw new OxpError.DependencyUnavailable({
          detail: "Stable upload source was not completely streamed",
        })
      }
      if (digested) {
        throw new OxpError.DependencyUnavailable({
          detail: "Stable upload source digest was already consumed",
        })
      }
      digested = true
      return hash.digest("hex")
    },
  }
}

async function assertNoSymlinkComponents(directory: string) {
  const resolved = path.resolve(directory)
  const parsed = path.parse(resolved)
  let current = parsed.root
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)
  for (const part of parts) {
    current = path.join(current, part)
    const info = await fs.lstat(current)
    if (info.isSymbolicLink()) {
      throw new OxpError.PathEscape({ detail: "Destination parent may not contain symlink components" })
    }
  }
}

export async function publish(
  response: Response,
  destination: string,
  expected: number | undefined,
  beforeCommit: () => Promise<void>,
  signal?: AbortSignal,
) {
  if (!response.body) throw new OxpError.DependencyUnavailable({ detail: "Remote file response had no body" })
  if (expected !== undefined && expected > MAX_BYTES) throw new OxpError.InvalidArgument({ detail: "Remote file exceeds the 512 MiB transfer limit" })
  if (signal?.aborted) throw new OxpError.Cancelled({ detail: "File transfer was cancelled" })
  const parent = path.dirname(destination)
  await assertNoSymlinkComponents(parent)
  try { await fs.lstat(destination); throw new OxpError.Conflict({ detail: "Destination already exists; file exchange never overwrites files" }) }
  catch (error) { if (OxpError.isError(error)) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  const partial = path.join(parent, ".openfork-oxp-transfer-" + randomUUID() + ".partial")
  const handle = await fs.open(partial, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
  let bytes = 0
  const hash = createHash("sha256")
  try {
    const reader = response.body.getReader()
    try {
      while (true) {
        if (signal?.aborted) throw new OxpError.Cancelled({ detail: "File transfer was cancelled" })
        const next = await reader.read().catch((error) => {
          if (signal?.aborted) throw new OxpError.Cancelled({ detail: "File transfer was cancelled" })
          throw error
        })
        if (next.done) break
        if (bytes + next.value.byteLength > MAX_BYTES) throw new OxpError.InvalidArgument({ detail: "Remote file exceeds the 512 MiB transfer limit" })
        await handle.write(Buffer.from(next.value), 0, next.value.byteLength, bytes)
        bytes += next.value.byteLength
        hash.update(next.value)
      }
    } finally { reader.releaseLock() }
    if (expected !== undefined && bytes !== expected) throw new OxpError.DependencyUnavailable({ detail: "Remote file size did not match metadata" })
    await handle.sync()
    const staged = await handle.stat()
    if (signal?.aborted) throw new OxpError.Cancelled({ detail: "File transfer was cancelled" })
    await beforeCommit()
    if (signal?.aborted) throw new OxpError.Cancelled({ detail: "File transfer was cancelled" })
    await fs.link(partial, destination)
    let published: Awaited<ReturnType<typeof fs.lstat>>
    try {
      published = await fs.lstat(destination)
    } catch {
      throw new OxpError.AmbiguousExternalResult({
        detail: "File publication may have committed but the destination could not be verified; inspect the destination before retrying",
        metadata: { committed: true, bytes },
      })
    }
    if (
      !published.isFile() ||
      published.isSymbolicLink() ||
      published.size !== bytes ||
      published.dev !== staged.dev ||
      published.ino !== staged.ino
    ) {
      throw new OxpError.AmbiguousExternalResult({
        detail: "File publication completed but the destination identity did not match the staged file; inspect the destination before retrying",
        metadata: { committed: true, bytes },
      })
    }
    return { bytes, sha256: hash.digest("hex"), verified: true as const }
  } finally {
    await handle.close().catch(() => undefined)
    await fs.unlink(partial).catch(() => undefined)
  }
}

const layer = Layer.effect(Service, Effect.gen(function* () {
  const authority = yield* OxpAuthority.Service

  const execute = Effect.fn("OxpFileExchange.execute")(function* (input: Input, signal?: AbortSignal) {
    if (input.action === "save_chatgpt_file") {
      if (!input.source_file) return yield* new OxpError.InvalidArgument({ detail: "source_file must be supplied by ChatGPT; never invent it" })
      const destination = required(input.destination, "destination")
      const admission = yield* authority.authorize({ plane: "augmentation", operation: "file.receive", phase: "mutate", rootID: input.rootID, path: destination, allowMissing: true })
      if (!admission.root) return yield* new OxpError.RootRequired({ detail: "File receive requires an approved root" })
      if (!("path" in admission.root)) return yield* new OxpError.InvalidArgument({ detail: "File receive destination was not path-resolved" })
      const target = admission.root
      const opened = yield* Effect.tryPromise({ try: () => chatGptDownload(input.source_file!, signal), catch: (e) => OxpError.isError(e) ? e : new OxpError.DependencyUnavailable({ detail: "ChatGPT file could not be opened" }) })
      const saved = yield* Effect.tryPromise({ try: () => publish(opened.response, target.path, opened.expected, () => Effect.runPromise(authority.revalidate(admission, "commit").pipe(Effect.asVoid)), signal), catch: (e) => OxpError.isError(e) ? e : new OxpError.DependencyUnavailable({ detail: "Local file publication failed" }) })
      return { output: "Saved " + target.virtualPath + ".", structured: { action: input.action, path: target.virtualPath, bytes: saved.bytes, sha256: saved.sha256, verified: saved.verified, source_file_id: input.source_file.file_id }, mutation: { attempted: true, committed: true } } satisfies OxpResult.CapabilityResult
    }

    if (input.action === "download_openai_file") {
      const destination = required(input.destination, "destination")
      const id = fileID(input.file_id)
      const admission = yield* authority.authorize({ plane: "augmentation", operation: "file.receive", phase: "mutate", rootID: input.rootID, path: destination, allowMissing: true })
      if (!admission.root) return yield* new OxpError.RootRequired({ detail: "File receive requires an approved root" })
      if (!("path" in admission.root)) return yield* new OxpError.InvalidArgument({ detail: "File receive destination was not path-resolved" })
      const target = admission.root
      const metadata = parseFile(yield* Effect.tryPromise({ try: async () => json(await openAi("/files/" + encodeURIComponent(id), { signal }), signal), catch: (e) => OxpError.isError(e) ? e : new OxpError.DependencyUnavailable({ detail: "Unable to read OpenAI file metadata" }) }))
      if (metadata.bytes > MAX_BYTES) return yield* new OxpError.InvalidArgument({ detail: "OpenAI file exceeds the 512 MiB transfer limit" })
      yield* authority.revalidate(admission, "network")
      const response = yield* Effect.tryPromise({ try: () => openAi("/files/" + encodeURIComponent(id) + "/content", { signal }), catch: (e) => OxpError.isError(e) ? e : new OxpError.DependencyUnavailable({ detail: "Unable to download OpenAI file" }) })
      if (!response.ok) return yield* new OxpError.DependencyUnavailable({ detail: "OpenAI file download failed with HTTP " + response.status })
      const saved = yield* Effect.tryPromise({ try: () => publish(response, target.path, metadata.bytes, () => Effect.runPromise(authority.revalidate(admission, "commit").pipe(Effect.asVoid)), signal), catch: (e) => OxpError.isError(e) ? e : new OxpError.DependencyUnavailable({ detail: "Local file publication failed" }) })
      return { output: "Downloaded " + id + " to " + target.virtualPath + ".", structured: { action: input.action, file: compact(metadata), path: target.virtualPath, bytes: saved.bytes, sha256: saved.sha256, verified: saved.verified }, mutation: { attempted: true, committed: true } } satisfies OxpResult.CapabilityResult
    }

    if (input.action === "upload_openai_file") {
      const source = required(input.source, "source")
      const admission = yield* authority.authorize({ plane: "augmentation", operation: "file.send", phase: "read", rootID: input.rootID, path: source })
      if (!admission.root) return yield* new OxpError.RootRequired({ detail: "File send requires an approved root" })
      if (!("path" in admission.root)) return yield* new OxpError.InvalidArgument({ detail: "File send source was not path-resolved" })
      const sourceTarget = admission.root
      const opened = yield* Effect.tryPromise({ try: () => stableSource(sourceTarget.path), catch: (e) => OxpError.isError(e) ? e : new OxpError.NotFound({ detail: "Local upload source is unavailable, linked, or unstable" }) })
      try {
        yield* authority.revalidate(admission, "network")
        const upload = multipartUpload(
          opened.handle,
          opened.before.size,
          path.basename(sourceTarget.path),
          input.purpose ?? "user_data",
          signal,
        )
        const response = yield* Effect.tryPromise({
          try: async () => {
            if (signal?.aborted) {
              throw new OxpError.Cancelled({ detail: "OpenAI file upload was cancelled" })
            }
            let result: Response
            try {
              result = await fetch("https://api.openai.com/v1/files", {
                method: "POST",
                redirect: "error",
                signal,
                headers: {
                  Authorization: "Bearer " + apiKey(),
                  "Content-Type": upload.contentType,
                  "Content-Length": String(upload.contentLength),
                },
                body: upload.body,
                duplex: "half",
              } as RequestInit & { duplex: "half" })
            } catch {
              if (signal?.aborted) {
                throw new OxpError.Cancelled({
                  detail: "OpenAI file upload was cancelled; remote outcome may be ambiguous",
                  metadata: { ambiguous: true },
                })
              }
              throw new OxpError.AmbiguousExternalResult({ detail: "OpenAI upload result is ambiguous; inspect recent files before retrying" })
            }
            return result
          },
          catch: (e) => OxpError.isError(e) ? e : new OxpError.AmbiguousExternalResult({ detail: "OpenAI upload result is ambiguous; inspect recent files before retrying" }),
        })
        const uploaded = parseFile(yield* Effect.tryPromise({
          try: () => json(response, signal),
          catch: (e) =>
            OxpError.isError(e) && e._tag === "OXP_CANCELLED"
              ? new OxpError.Cancelled({
                  detail: "OpenAI file upload response was cancelled; remote outcome may be ambiguous",
                  metadata: { ambiguous: true },
                })
              : new OxpError.AmbiguousExternalResult({ detail: "OpenAI upload result is ambiguous; inspect recent files before retrying" }),
        }))
        const sourceSha256 = yield* Effect.try({
          try: () => upload.sha256(),
          catch: (e) => OxpError.isError(e)
            ? e
            : new OxpError.DependencyUnavailable({ detail: "Unable to finalize stable upload source digest" }),
        })
        const after = yield* Effect.tryPromise({ try: () => opened.handle.stat(), catch: () => new OxpError.AmbiguousExternalResult({ detail: "Local source changed while uploading; inspect the returned OpenAI file before retrying", metadata: { fileID: uploaded.id } }) })
        const named = yield* Effect.tryPromise({ try: () => fs.lstat(sourceTarget.path), catch: () => new OxpError.AmbiguousExternalResult({ detail: "Local source changed while uploading; inspect the returned OpenAI file before retrying", metadata: { fileID: uploaded.id } }) })
        if (opened.before.dev !== after.dev || opened.before.ino !== after.ino || opened.before.size !== after.size || opened.before.mtimeMs !== after.mtimeMs || named.isSymbolicLink() || opened.before.dev !== named.dev || opened.before.ino !== named.ino) {
          return yield* new OxpError.AmbiguousExternalResult({ detail: "Local source changed while uploading; inspect the returned OpenAI file before retrying", metadata: { fileID: uploaded.id } })
        }
        return { output: "Uploaded " + sourceTarget.virtualPath + " to OpenAI as " + uploaded.id + ".", structured: { action: input.action, source: sourceTarget.virtualPath, source_bytes: opened.before.size, source_sha256: sourceSha256, file: compact(uploaded) }, mutation: { attempted: true, committed: true } } satisfies OxpResult.CapabilityResult
      } finally { yield* Effect.promise(() => opened.handle.close().catch(() => undefined)) }
    }

    const canReceive = yield* authority.discover({ plane: "augmentation", operation: "file.receive.metadata" })
    const canSend = yield* authority.discover({ plane: "augmentation", operation: "file.send.metadata" })
    if (!canReceive && !canSend) return yield* new OxpError.AuthDenied({ detail: "OpenAI file metadata requires receive or send authority" })
    if (input.action === "get_openai_file") {
      const id = fileID(input.file_id)
      const file = parseFile(yield* Effect.tryPromise({ try: async () => json(await openAi("/files/" + encodeURIComponent(id), { signal }), signal), catch: (e) => OxpError.isError(e) ? e : new OxpError.DependencyUnavailable({ detail: "Unable to read OpenAI file metadata" }) }))
      return { output: "OpenAI file " + file.id + ": " + file.filename + ".", structured: { action: input.action, file: compact(file) } } satisfies OxpResult.CapabilityResult
    }
    const query = new URLSearchParams({ limit: String(input.limit ?? 20), order: "desc" })
    if (input.after) query.set("after", fileID(input.after))
    if (input.purpose) query.set("purpose", input.purpose)
    const raw = yield* Effect.tryPromise({ try: async () => json(await openAi("/files?" + query.toString(), { signal }), signal), catch: (e) => OxpError.isError(e) ? e : new OxpError.DependencyUnavailable({ detail: "Unable to list OpenAI files" }) })
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as any).data) || typeof (raw as any).has_more !== "boolean") return yield* new OxpError.DependencyUnavailable({ detail: "OpenAI returned a malformed file list" })
    const files = (raw as any).data.slice(0, input.limit ?? 20).map(parseFile)
    return { output: "Found " + files.length + " OpenAI files.", structured: { action: input.action, files: files.map(compact), has_more: (raw as any).has_more } } satisfies OxpResult.CapabilityResult
  })
  return Service.of({ execute })
}))

export const node = makeGlobalNode({ service: Service, layer, deps: [OxpAuthority.node] })
export * as OxpFileExchange from "./file-exchange"
