import { Effect, Schema } from "effect"
import path from "path"
import fs from "node:fs/promises"
import type { Stats } from "node:fs"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Glob } from "@opencode-ai/core/util/glob"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import * as ArchiveFormat from "./archive/format"
import { ZipFile } from "./archive/zipfile"
import { TarFile } from "./archive/tarfile"
import { ArchiveDecompress } from "./archive/decompress"
import { ArchiveSystem } from "./archive/system"
import DESCRIPTION from "./archive.txt"

const MAX_LIST_ENTRIES = 200
const MAX_READ_BYTES = 50 * 1024
const MAX_READ_ENTRY = 64 * 1024 * 1024
const MAX_TAR_DECOMPRESSED = 1024 * 1024 * 1024
const MAX_SINGLE_DECOMPRESSED = 512 * 1024 * 1024
const MAX_EXTRACT_ENTRY = 512 * 1024 * 1024
const MAX_EXTRACT_ENTRIES = 100_000
const MAX_EXTRACT_TOTAL = 20 * 1024 * 1024 * 1024
const MAX_CREATE_FILE = 512 * 1024 * 1024
const MAX_CREATE_TOTAL = 4 * 1024 * 1024 * 1024
const COMPRESSION_EXTS = [".gz", ".bz2", ".xz", ".zst", ".br", ".lz4", ".lzma"]

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "extract", "read", "create"]).annotate({
    description:
      "What to do: 'list' inspects an archive without extracting, 'extract' unpacks it, 'read' shows one file inside it, 'create' builds a new archive from files/directories",
  }),
  path: Schema.String.annotate({
    description: "Absolute path to the archive file to operate on (for 'create': the archive to create)",
  }),
  destination: Schema.optional(Schema.String).annotate({
    description:
      "For 'extract': the directory to unpack into (default: a folder named after the archive, next to it). For 'create': same as path. For single-file formats (.gz/.br/.zst/...): the output file path (default: the archive name without its compression extension)",
  }),
  entries: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Filter for 'list' or 'extract'. Glob patterns ('src/**', '*.md') or exact entry paths ('src/main.ts'). Extract only includes entries matching any pattern, and 'src' also includes everything under it. Omit to list/extract everything",
  }),
  entry: Schema.optional(Schema.String).annotate({
    description: "For 'read': the exact entry path or glob pattern of the file inside the archive to read",
  }),
  source: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "For 'create': the files and directories to add to the archive",
  }),
  overwrite: Schema.optional(Schema.Boolean).annotate({
    description: "Overwrite existing files during 'extract' (default false: existing files are skipped)",
  }),
  offset: Schema.optional(NonNegativeInt).annotate({
    description: "For 'read': line number to start from (1-indexed)",
  }),
  limit: Schema.optional(NonNegativeInt).annotate({
    description: "For 'read': maximum number of lines to return",
  }),
})

type Metadata = {
  action: "list" | "extract" | "read" | "create"
  format: string
  count: number
  truncated: boolean
  preview: string
}

function meta(action: Metadata["action"], format: string, count: number, truncated: boolean, preview: string): Metadata {
  return { action, format, count, truncated, preview }
}

type DisplayEntry = {
  name: string
  dir: boolean
  unsafe: boolean
  size: number
  stored?: number
  date?: Date
  linkTo?: string
}

function isSystemFormat(format: ArchiveFormat.ArchiveFormat): boolean {
  if (format.kind === "7z" || format.kind === "rar") return true
  return format.kind === "compressed" && ArchiveFormat.SYSTEM_COMPRESSIONS.has(format.compression)
}

function formatLabel(format: ArchiveFormat.ArchiveFormat): string {
  const base = ArchiveFormat.formatName(format)
  if (format.kind === "compressed" && format.container === "tar") return `${base} (tar)`
  return base
}

async function detectArchive(filepath: string): Promise<ArchiveFormat.ArchiveFormat> {
  const handle = await fs.open(filepath, "r")
  try {
    const buf = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    return ArchiveFormat.detect(new Uint8Array(buf.subarray(0, bytesRead)), filepath)
  } finally {
    await handle.close()
  }
}

async function readWhole(filepath: string, cap: number): Promise<Uint8Array> {
  const stat = await fs.stat(filepath)
  if (stat.size > cap) {
    throw new Error(
      `Archive is too large to process in-process (${ArchiveFormat.humanSize(stat.size)}). Use the bash tool with the system 'tar'/'7z' command, or install 7-Zip to enable the archive tool's system fallback.`,
    )
  }
  return new Uint8Array(await fs.readFile(filepath))
}

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Aborted by user")
}

// All pure-format listings share one shape so list/extract/read dispatch stays small.
async function resolveEntries(
  filepath: string,
  format: ArchiveFormat.ArchiveFormat,
): Promise<{ format: ArchiveFormat.ArchiveFormat; entries: DisplayEntry[] }> {
  if (format.kind === "zip") {
    const reader = await ZipFile.fileReader(filepath)
    try {
      const entries = await ZipFile.readZip(reader)
      return {
        format,
        entries: entries.map((e) => ({
          name: e.name,
          dir: e.dir,
          unsafe: e.unsafe,
          size: e.size,
          stored: e.compSize,
          date: e.date,
        })),
      }
    } finally {
      await reader.close()
    }
  }

  if (format.kind === "tar") {
    const bytes = await readWhole(filepath, MAX_TAR_DECOMPRESSED)
    const entries = TarFile.readTar(bytes)
    return { format, entries: entries.map(toDisplay) }
  }

  if (format.kind === "compressed" && ArchiveFormat.PURE_COMPRESSIONS.has(format.compression)) {
    const compressed = await readWhole(filepath, MAX_SINGLE_DECOMPRESSED)
    const decompressed = ArchiveDecompress.decompress(format.compression, compressed)
    const resolved = ArchiveFormat.withTarContainer(format, decompressed)
    if (resolved.container === "tar") {
      const entries = TarFile.readTar(decompressed)
      return { format: resolved, entries: entries.map(toDisplay) }
    }
    return {
      format: resolved,
      entries: [{ name: stripCompressionExt(filepath), dir: false, unsafe: false, size: decompressed.length }],
    }
  }

  // Unreachable for callers that check isSystemFormat first.
  throw new Error(`Format ${ArchiveFormat.formatName(format)} requires a system tool`)
}

function toDisplay(e: TarFile.TarEntry): DisplayEntry {
  return {
    name: e.name,
    dir: e.dir,
    unsafe: e.unsafe,
    size: e.size,
    date: new Date(e.mtime * 1000),
    linkTo: e.linkTo,
  }
}

function stripCompressionExt(filepath: string): string {
  const base = path.basename(filepath)
  const lower = base.toLowerCase()
  for (const ext of COMPRESSION_EXTS) {
    if (lower.endsWith(ext)) return base.slice(0, -ext.length)
  }
  return base.replace(/\.[^.]+$/, "")
}

function entryMatches(pattern: string, name: string): boolean {
  return name === pattern || name.startsWith(pattern + "/") || Glob.match(pattern, name)
}

function filterEntries(entries: DisplayEntry[], patterns: readonly string[]): DisplayEntry[] {
  if (!patterns.length) return entries
  return entries.filter((e) => patterns.some((pattern) => entryMatches(pattern, e.name)))
}

function sortEntries(entries: DisplayEntry[]): DisplayEntry[] {
  return entries.toSorted((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function renderList(
  filepath: string,
  format: ArchiveFormat.ArchiveFormat,
  entries: DisplayEntry[],
  filtered: boolean,
): string {
  const total = entries.reduce((sum, e) => sum + e.size, 0)
  const lines = [
    `<archive>${filepath}</archive>`,
    `<format>${formatLabel(format)}</format>`,
    `<entries>${entries.length}</entries>`,
    `<uncompressed>${ArchiveFormat.humanSize(total)}</uncompressed>`,
    "",
  ]

  const shown = entries.slice(0, MAX_LIST_ENTRIES)
  for (const entry of shown) {
    const marker = entry.unsafe ? "[!]" : entry.dir ? "[D]" : "   "
    const size = entry.stored !== undefined ? `${ArchiveFormat.humanSize(entry.size)} (${ArchiveFormat.humanSize(entry.stored)} stored)` : ArchiveFormat.humanSize(entry.size)
    lines.push(`  ${marker} ${entry.name}${entry.dir ? "/" : ""}${entry.unsafe ? " — unsafe path, will not extract" : ` — ${size}`}`)
  }
  if (entries.length > shown.length) {
    lines.push("")
    lines.push(`(Showing ${shown.length} of ${entries.length} entries. Use entries=["pattern"] to narrow, or a more specific filter.)`)
  } else if (filtered) {
    lines.push(`(Matches ${entries.length} entries. Use a broader entries filter to see more.)`)
  }
  if (entries.length > 0) {
    lines.push("")
    lines.push(`Use the read action with entry="<path>" to view a file inside without extracting.`)
  }
  return lines.join("\n")
}

async function extractPure(
  filepath: string,
  format: ArchiveFormat.ArchiveFormat,
  dest: string,
  selection: DisplayEntry[],
  overwrite: boolean,
  signal: AbortSignal,
): Promise<{ extracted: number; dirs: number; skipped: number; links: number; blocked: number; errors: string[]; totalBytes: number }> {
  const result = { extracted: 0, dirs: 0, skipped: 0, links: 0, blocked: 0, errors: [] as string[], totalBytes: 0 }

  if (selection.length > MAX_EXTRACT_ENTRIES) {
    throw new Error(`Too many entries to extract (${selection.length} > ${MAX_EXTRACT_ENTRIES}). Use the entries filter to narrow the selection.`)
  }
  const totalSize = selection.reduce((sum, e) => sum + e.size, 0)
  if (totalSize > MAX_EXTRACT_TOTAL) {
    throw new Error(`Extraction would expand to ${ArchiveFormat.humanSize(totalSize)}, over the ${ArchiveFormat.humanSize(MAX_EXTRACT_TOTAL)} safety cap. Use the entries filter or extract in parts.`)
  }

  if (format.kind === "zip") {
    const reader = await ZipFile.fileReader(filepath)
    try {
      const all = new Map((await ZipFile.readZip(reader)).map((e) => [e.name, e]))
      for (const entry of selection) {
        checkAbort(signal)
        if (entry.unsafe) {
          result.blocked++
          continue
        }
        const zipEntry = all.get(entry.name)
        if (!zipEntry) {
          result.errors.push(`entry vanished: ${entry.name}`)
          continue
        }
        if (entry.dir) {
          await mkdirSafe(dest, entry.name)
          result.dirs++
          continue
        }
        if (zipEntry.size > MAX_EXTRACT_ENTRY) {
          result.errors.push(`${entry.name}: over ${ArchiveFormat.humanSize(MAX_EXTRACT_ENTRY)} in-process limit; extract with the bash tool instead`)
          continue
        }
        if (zipEntry.flags & 0x0001) {
          result.errors.push(`${entry.name}: encrypted entries are not supported`)
          continue
        }
        const target = await safeJoin(dest, entry.name)
        if (await exists(target)) {
          if (!overwrite) {
            result.skipped++
            continue
          }
          const st = await fs.lstat(target)
          if (st.isDirectory()) {
            result.skipped++
            continue
          }
        }
        const data = await ZipFile.readZipEntry(reader, zipEntry)
        await writeOut(target, data, zipEntry.date)
        result.extracted++
        result.totalBytes += data.length
      }
    } finally {
      await reader.close()
    }
    return result
  }

  // tar containers (tar, tar.gz, tar.bz2, tar.zst, ...)
  let tarBytes: Uint8Array
  if (format.kind === "tar") {
    tarBytes = await readWhole(filepath, MAX_TAR_DECOMPRESSED)
  } else if (format.kind === "compressed") {
    const compressed = await readWhole(filepath, MAX_SINGLE_DECOMPRESSED)
    tarBytes = ArchiveDecompress.decompress(format.compression, compressed)
    if (format.container !== "tar") {
      // single-file compressed blob: write the decompressed content to `dest`.
      if (selection.length !== 1) {
        throw new Error(`Expected exactly one output file, got ${selection.length}`)
      }
      const data = tarBytes
      if (data.length > MAX_EXTRACT_ENTRY) throw new Error(`Decompressed size ${ArchiveFormat.humanSize(data.length)} exceeds the in-process limit`)
      const target = dest
      if (!(await exists(target)) || overwrite) {
        await writeOut(target, data, new Date())
        result.extracted++
        result.totalBytes += data.length
      } else {
        result.skipped++
      }
      return result
    }
  } else {
    throw new Error(`Cannot extract ${formatLabel(format)} archives in-process`)
  }
  const all = new Map(TarFile.readTar(tarBytes).map((e) => [e.name, e]))
  for (const entry of selection) {
    checkAbort(signal)
    if (entry.unsafe) {
      result.blocked++
      continue
    }
    if (entry.dir) {
      await mkdirSafe(dest, entry.name)
      result.dirs++
      continue
    }
    if (entry.linkTo !== undefined) {
      // Symlinks are skipped for safety; internal hardlinks materialize the
      // target file's content so relative links still resolve.
      const targetName = entry.linkTo.replace(/\\/g, "/")
      const src = all.get(targetName)
      if (src && src.type === "file") {
        const data = TarFile.entryData(tarBytes, src)
        const target = await safeJoin(dest, entry.name)
        if (!(await exists(target)) || overwrite) {
          await writeOut(target, data, new Date(entry.date ? entry.date.getTime() : Date.now()))
          result.extracted++
          result.totalBytes += data.length
        } else {
          result.skipped++
        }
        continue
      }
      result.links++
      continue
    }
    const tarEntry = all.get(entry.name)
    if (!tarEntry) {
      result.errors.push(`entry vanished: ${entry.name}`)
      continue
    }
    if (tarEntry.size > MAX_EXTRACT_ENTRY) {
      result.errors.push(`${entry.name}: over ${ArchiveFormat.humanSize(MAX_EXTRACT_ENTRY)} in-process limit; extract with the bash tool instead`)
      continue
    }
    const target = await safeJoin(dest, entry.name)
    if (await exists(target)) {
      if (!overwrite) {
        result.skipped++
        continue
      }
      const st = await fs.lstat(target)
      if (st.isDirectory()) {
        result.skipped++
        continue
      }
    }
    const data = TarFile.entryData(tarBytes, tarEntry)
    await writeOut(target, data, new Date(tarEntry.mtime * 1000))
    result.extracted++
    result.totalBytes += data.length
  }
  return result
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function isDirectory(p: string): Promise<boolean> {
  const stat = await fs.stat(p).catch(() => undefined)
  return stat?.isDirectory() ?? false
}

async function mkdirSafe(dest: string, name: string) {
  await fs.mkdir(path.join(dest, name), { recursive: true })
}

// Resolve an entry name under dest, refusing path traversal and writes that
// would pass through a pre-existing symlink.
async function safeJoin(dest: string, name: string): Promise<string> {
  const target = path.resolve(dest, name)
  if (target !== dest && !target.startsWith(dest + path.sep)) {
    throw new Error(`Refusing to write outside extraction root: ${name}`)
  }
  const rel = path.relative(dest, path.dirname(target))
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside extraction root: ${name}`)
  }
  let cursor = dest
  for (const part of rel === "" ? [] : rel.split(path.sep)) {
    cursor = path.join(cursor, part)
    try {
      const st = await fs.lstat(cursor)
      if (st.isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${cursor}`)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue
      throw error
    }
  }
  return target
}

async function writeOut(target: string, data: Uint8Array, date: Date) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, data)
  await fs.utimes(target, date, date).catch(() => undefined)
}

function renderExtract(filepath: string, dest: string, result: Awaited<ReturnType<typeof extractPure>>): string {
  const lines = [
    `Extracted ${result.extracted} files and ${result.dirs} directories (${ArchiveFormat.humanSize(result.totalBytes)}) to ${dest}`,
  ]
  if (result.skipped) lines.push(`${result.skipped} existing entries skipped (use overwrite=true to replace them)`)
  if (result.links) lines.push(`${result.links} symlinks skipped for safety`)
  if (result.blocked) lines.push(`${result.blocked} unsafe paths (traversal/absolute) skipped`)
  if (result.errors.length) {
    lines.push(`${result.errors.length} entries could not be extracted:`)
    lines.push(...result.errors.slice(0, 5).map((e) => `  - ${e}`))
  }
  if (result.errors.length === 0 && result.extracted === 0 && result.skipped === 0 && result.blocked === 0) {
    lines.push("Nothing matched. Check the entries filter against the archive's listing.")
  }
  return lines.join("\n")
}

async function readEntryData(
  filepath: string,
  format: ArchiveFormat.ArchiveFormat,
  pattern: string,
): Promise<{ name: string; data: Uint8Array; size: number }> {
  if (format.kind === "zip") {
    const reader = await ZipFile.fileReader(filepath)
    try {
      const entry = await findZipEntry(reader, pattern)
      if (entry.dir) throw new Error(`"${pattern}" is a directory`)
      if (entry.size > MAX_READ_ENTRY) {
        throw new Error(`Entry is ${ArchiveFormat.humanSize(entry.size)}; too large to read in-process. Extract it instead.`)
      }
      if (entry.flags & 0x0001) throw new Error(`"${entry.name}" is encrypted and cannot be read`)
      const data = await ZipFile.readZipEntry(reader, entry)
      return { name: entry.name, data, size: entry.size }
    } finally {
      await reader.close()
    }
  }

  if (format.kind === "tar") {
    const tarBytes = await readWhole(filepath, MAX_TAR_DECOMPRESSED)
    return tarEntryRead(filepath, tarBytes, pattern)
  }

  if (format.kind === "compressed") {
    const compressed = await readWhole(filepath, MAX_SINGLE_DECOMPRESSED)
    const data = ArchiveDecompress.decompress(format.compression, compressed)
    if (ArchiveFormat.isTarBytes(data)) {
      return tarEntryRead(filepath, data, pattern)
    }
    if (data.length > MAX_READ_ENTRY) {
      throw new Error(`Decompressed size ${ArchiveFormat.humanSize(data.length)} is too large to read in-process. Extract it instead.`)
    }
    return { name: stripCompressionExt(filepath), data, size: data.length }
  }

  throw new Error(`Reading from ${formatLabel(format)} archives requires a system tool`)
}

async function tarEntryRead(filepath: string, tarBytes: Uint8Array, pattern: string) {
  const entry = findTarEntry(TarFile.readTar(tarBytes), pattern)
  if (entry.dir) throw new Error(`"${pattern}" is a directory`)
  if (entry.size > MAX_READ_ENTRY) {
    throw new Error(`Entry is ${ArchiveFormat.humanSize(entry.size)}; too large to read in-process. Extract it instead.`)
  }
  return { name: entry.name, data: TarFile.entryData(tarBytes, entry), size: entry.size }
}

async function findZipEntry(reader: ZipFile.Reader, pattern: string): Promise<ZipFile.ZipEntry> {
  const entries = await ZipFile.readZip(reader)
  const exact = entries.find((e) => e.name === pattern)
  if (exact) return exact
  const matches = entries.filter((e) => Glob.match(pattern, e.name))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new Error(`"${pattern}" matches ${matches.length} entries; be more specific:\n${matches.slice(0, 10).map((e) => "  " + e.name).join("\n")}`)
  }
  return missingEntry(pattern, entries.map((e) => e.name))
}

function findTarEntry(entries: TarFile.TarEntry[], pattern: string): TarFile.TarEntry {
  const exact = entries.find((e) => e.name === pattern)
  if (exact) return exact
  const matches = entries.filter((e) => Glob.match(pattern, e.name))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new Error(`"${pattern}" matches ${matches.length} entries; be more specific:\n${matches.slice(0, 10).map((e) => "  " + e.name).join("\n")}`)
  }
  return missingEntry(pattern, entries.map((e) => e.name))
}

function missingEntry(pattern: string, names: string[]): never {
  const base = path.basename(pattern)
  const suggestions = names
    .filter((name) => name.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(name.split("/").pop()?.toLowerCase() ?? ""))
    .slice(0, 3)
  const hint = suggestions.length ? `\nDid you mean one of these?\n${suggestions.map((s) => "  " + s).join("\n")}` : ""
  throw new Error(`Entry not found: ${pattern}${hint}`)
}

function renderRead(filepath: string, name: string, data: Uint8Array, offset: number, limit?: number): { output: string; truncated: boolean } {
  if (isBinary(data)) {
    throw new Error(`Cannot read binary file entry: ${name} (${ArchiveFormat.humanSize(data.length)}). Extract it or list the archive instead.`)
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data)
  const lines = text.replace(/\n$/, "").split("\n")
  const start = Math.max(0, offset - 1)
  const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit)
  const shown = lines.slice(start, end)
  const out: string[] = []
  let bytes = 0
  const rendered: string[] = []
  for (let i = 0; i < shown.length; i++) {
    const line = shown[i]
    const size = Buffer.byteLength(line, "utf-8") + 1
    if (bytes + size > MAX_READ_BYTES) break
    rendered.push(`${i + start + 1}: ${line}`)
    bytes += size
  }
  out.push(`<path>${filepath}</path>`, `<entry>${name}</entry>`, "<type>file</type>", "<content>\n")
  out.push(rendered.join("\n"))
  const truncated = rendered.length < shown.length || start + shown.length < lines.length
  const last = start + rendered.length
  if (truncated) {
    out.push("", `\n(Output capped at ${MAX_READ_BYTES / 1024} KB. Showing lines ${start + 1}-${last}. Use offset=${last + 1} to continue.)`)
  } else {
    out.push("", `\n(End of entry - total ${lines.length} lines)`)
  }
  out.push("</content>")
  return { output: out.join("\n"), truncated }
}

function isBinary(data: Uint8Array): boolean {
  if (data.length === 0) return false
  const sample = Math.min(data.length, 4096)
  let nonPrintable = 0
  for (let i = 0; i < sample; i++) {
    const b = data[i]
    if (b === 0) return true
    if (b < 9 || (b > 13 && b < 32)) nonPrintable++
  }
  return nonPrintable / sample > 0.3
}

type SourceEntry = { name: string; data: Uint8Array; date: Date; dir?: boolean }

async function collectSources(sources: string[]): Promise<SourceEntry[]> {
  const out: SourceEntry[] = []
  const acc = { total: 0 }
  for (const source of sources) {
    const stat = await fs.stat(source)
    if (stat.isFile()) {
      await addFile(out, acc, path.basename(source), source, stat)
      continue
    }
    if (stat.isDirectory()) {
      out.push({ name: path.basename(source), data: new Uint8Array(0), date: stat.mtime, dir: true })
      await walkDir(source, path.basename(source), out, acc)
      continue
    }
    throw new Error(`Source is neither a file nor a directory: ${source}`)
  }
  return out
}

async function addFile(collected: SourceEntry[], acc: { total: number }, name: string, file: string, stat: Stats) {
  if (stat.size > MAX_CREATE_FILE) {
    throw new Error(`${file} is ${ArchiveFormat.humanSize(stat.size)}; the create action caps files at ${ArchiveFormat.humanSize(MAX_CREATE_FILE)}`)
  }
  acc.total += stat.size
  if (acc.total > MAX_CREATE_TOTAL) throw new Error(`Sources exceed the ${ArchiveFormat.humanSize(MAX_CREATE_TOTAL)} create cap`)
  collected.push({ name, data: new Uint8Array(await fs.readFile(file)), date: stat.mtime })
}

async function walkDir(dir: string, prefix: string, collected: SourceEntry[], acc: { total: number }) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      const stat = await fs.stat(full)
      collected.push({ name: `${prefix}/${entry.name}`, data: new Uint8Array(0), date: stat.mtime, dir: true })
      await walkDir(full, `${prefix}/${entry.name}`, collected, acc)
      continue
    }
    const st = await fs.stat(full)
    await addFile(collected, acc, `${prefix}/${entry.name}`, full, st)
  }
}

async function createPure(dest: string, format: ArchiveFormat.ArchiveFormat, sources: string[]): Promise<string> {
  const files = await collectSources(sources)
  const fileCount = files.filter((f) => !f.dir).length

  if (format.kind === "zip") {
    const result = await ZipFile.writeZip(dest, files.map((f) => ({ name: f.name, data: f.data, date: f.date, dir: f.dir })))
    return `Created ${dest} (ZIP, ${fileCount} files, ${ArchiveFormat.humanSize(result.bytes)}).`
  }

  if (format.kind === "tar") {
    const tar = TarFile.createTar(toTarSource(files))
    await fs.writeFile(dest, tar)
    return `Created ${dest} (tar, ${fileCount} files, ${ArchiveFormat.humanSize(tar.length)}).`
  }

  if (format.kind === "compressed" && format.container === "tar") {
    const tar = TarFile.createTar(toTarSource(files))
    const payload = ArchiveDecompress.compress(format.compression, tar)
    await fs.writeFile(dest, payload)
    return `Created ${dest} (${format.compression} tar, ${fileCount} files, ${ArchiveFormat.humanSize(payload.length)}).`
  }

  if (format.kind === "compressed" && format.container === "single") {
    if (files.length !== 1 || files[0].dir) {
      throw new Error(`Single-file ${format.compression} archives need exactly one source file. Use a zip/tar archive for directories or multiple files.`)
    }
    const payload = ArchiveDecompress.compress(format.compression, files[0].data)
    await fs.writeFile(dest, payload)
    return `Created ${dest} (${format.compression}, ${ArchiveFormat.humanSize(payload.length)}).`
  }

  throw new Error(`Cannot create ${formatLabel(format)} archives in-process`)
}

function toTarSource(files: SourceEntry[]) {
  return files.map((f) => ({
    name: f.name,
    data: f.data,
    mtime: Math.floor(f.date.getTime() / 1000),
    type: f.dir ? ("dir" as const) : ("file" as const),
  }))
}

function renderAsk(ctx: Tool.Context, permission: string, pattern: string, always: string, metadata: Record<string, unknown>) {
  return ctx.ask({
    permission,
    patterns: [pattern],
    always: [always],
    metadata,
  })
}

export const ArchiveTool = Tool.define<typeof Parameters, Metadata, never>(
  "archive",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const archivePath = path.isAbsolute(params.path) ? params.path : path.join(instance.directory, params.path)
          const normalized = process.platform === "win32" ? FSUtil.normalizePath(archivePath) : archivePath
          const archiveRel = path.relative(instance.worktree, normalized)

          if (params.action !== "create") {
            yield* renderAsk(ctx, "read", archiveRel, archiveRel, { archive: normalized })
            yield* assertExternalDirectoryEffect(ctx, normalized, { kind: "file" })
          }

          if (params.action === "list") {
            const format = yield* Effect.promise(() => detectArchive(normalized))
            if (format.kind === "unknown") {
              throw new Error("Unrecognized file format. Expected a zip, tar, gzip/brotli/zstd/bzip2 stream, 7z, or rar archive.")
            }
            if (isSystemFormat(format)) {
              const entries = yield* Effect.promise(() => ArchiveSystem.systemList(format, normalized))
              const filtered = filterEntries(
                entries.map((e) => ({ name: e.name, dir: e.dir, unsafe: false, size: e.size })),
                params.entries ?? [],
              )
              const sorted = sortEntries(filtered)
              const output = renderList(normalized, format, sorted, Boolean(params.entries?.length))
              return {
                title: archiveRel,
                metadata: meta("list", formatLabel(format), sorted.length, sorted.length > MAX_LIST_ENTRIES, output.slice(0, 500)),
                output,
              }
            }
            const resolved = yield* Effect.promise(() => resolveEntries(normalized, format))
            if (resolved.format.kind === "unknown") {
              throw new Error(
                `Unrecognized file format. Expected a zip, tar, gzip/brotli/zstd/bzip2 stream, 7z, or rar archive.`,
              )
            }
            const filtered = filterEntries(resolved.entries, params.entries ?? [])
            const sorted = sortEntries(filtered)
            const output = renderList(normalized, resolved.format, sorted, Boolean(params.entries?.length))
            return {
              title: archiveRel,
              metadata: meta("list", formatLabel(resolved.format), sorted.length, sorted.length > MAX_LIST_ENTRIES, output.slice(0, 500)),
              output,
            }
          }

          if (params.action === "read") {
            const format = yield* Effect.promise(() => detectArchive(normalized))
            if (format.kind === "unknown") {
              throw new Error("Unrecognized file format. Expected a zip, tar, gzip/brotli/zstd/bzip2 stream, 7z, or rar archive.")
            }
            const entry = params.entry
            if (!entry && !(format.kind === "compressed" && format.container === "single")) {
              throw new Error("The read action requires an 'entry' path or glob pattern (except for single-file compressed archives).")
            }
            if (isSystemFormat(format)) {
              const data = yield* Effect.promise(() => ArchiveSystem.systemRead(format, normalized, format.kind === "compressed" ? "" : entry!))
              const rendered = renderRead(normalized, entry ?? stripCompressionExt(normalized), data, params.offset ?? 1, params.limit)
              return {
                title: `${archiveRel}:${entry ?? stripCompressionExt(normalized)}`,
                metadata: meta("read", formatLabel(format), data.length, rendered.truncated, rendered.output.slice(0, 500)),
                output: rendered.output,
              }
            }
            const resolved = yield* Effect.promise(() => readEntryData(normalized, format, entry!))
            const rendered = renderRead(normalized, resolved.name, resolved.data, params.offset ?? 1, params.limit)
            return {
              title: `${archiveRel}:${resolved.name}`,
              metadata: meta("read", formatLabel(format), resolved.size, rendered.truncated, rendered.output.slice(0, 500)),
              output: rendered.output,
            }
          }

          if (params.action === "extract") {
            const format = yield* Effect.promise(() => detectArchive(normalized))
            if (format.kind === "unknown") {
              throw new Error("Unrecognized file format. Expected a zip, tar, gzip/brotli/zstd/bzip2 stream, 7z, or rar archive.")
            }
            const singleByExt = format.kind === "compressed" && format.container === "single"
            const pureSingle = singleByExt && ArchiveFormat.PURE_COMPRESSIONS.has(format.compression)
            let dest: string
            if (params.destination) {
              dest = path.isAbsolute(params.destination) ? params.destination : path.join(instance.directory, params.destination)
              if (pureSingle && (yield* Effect.promise(() => isDirectory(dest)))) {
                dest = path.join(dest, stripCompressionExt(normalized))
              }
            } else if (singleByExt) {
              dest = pureSingle
                ? path.join(path.dirname(normalized), stripCompressionExt(normalized))
                : ArchiveFormat.defaultDestination(normalized)
            } else {
              dest = ArchiveFormat.defaultDestination(normalized)
            }
            dest = process.platform === "win32" ? FSUtil.normalizePath(dest) : dest
            const destRel = path.relative(instance.worktree, dest)
            yield* renderAsk(ctx, "edit", destRel, destRel, { archive: normalized, destination: dest })
            yield* assertExternalDirectoryEffect(ctx, dest, { kind: pureSingle ? "file" : "directory" })

            if (isSystemFormat(format)) {
              if (format.kind === "compressed" && format.container === "single") {
                const data = yield* Effect.promise(() => ArchiveSystem.systemRead(format, normalized, ""))
                yield* Effect.promise(() => writeOut(dest, data, new Date()))
                const summary = `Decompressed ${normalized} to ${dest} (${ArchiveFormat.humanSize(data.length)}).`
                return {
                  title: archiveRel,
                  metadata: meta("extract", formatLabel(format), 1, false, summary),
                  output: summary,
                }
              }
              yield* Effect.promise(() => fs.mkdir(dest, { recursive: true }))
              const summary = yield* Effect.promise(() => ArchiveSystem.systemExtract(format, normalized, dest))
              return {
                title: archiveRel,
                metadata: meta("extract", formatLabel(format), 0, false, summary.slice(0, 500)),
                output: `Extracted to ${dest}\n${summary}`,
              }
            }

            const resolved = yield* Effect.promise(() => resolveEntries(normalized, format))
            const isSingleFile = resolved.format.kind === "compressed" && resolved.format.container === "single"
            const selection = isSingleFile
              ? resolved.entries
              : filterEntries(resolved.entries, params.entries ?? [])
            const result = yield* Effect.promise(() => extractPure(normalized, resolved.format, dest, selection, params.overwrite ?? false, ctx.abort))
            const output = renderExtract(normalized, dest, result)
            return {
              title: archiveRel,
              metadata: meta("extract", formatLabel(resolved.format), result.extracted, false, output.slice(0, 500)),
              output,
            }
          }

          // create
          if (!params.source?.length) throw new Error("The create action requires 'source' paths.")
          const sources = params.source.map((s) => (path.isAbsolute(s) ? s : path.join(instance.directory, s)))
          const destPath = path.isAbsolute(params.path) ? params.path : path.join(instance.directory, params.path)
          const destNorm = process.platform === "win32" ? FSUtil.normalizePath(destPath) : destPath
          yield* renderAsk(ctx, "edit", path.relative(instance.worktree, destNorm), path.relative(instance.worktree, destNorm), { destination: destNorm })
          yield* assertExternalDirectoryEffect(ctx, destNorm, { kind: "file" })
          for (const source of sources) {
            const sourceKind = (yield* Effect.promise(() => isDirectory(source))) ? "directory" : "file"
            yield* renderAsk(ctx, "read", path.relative(instance.worktree, source), path.relative(instance.worktree, source), { source })
            yield* assertExternalDirectoryEffect(ctx, source, { kind: sourceKind })
          }
          if (yield* Effect.promise(() => isDirectory(destNorm))) {
            throw new Error(`Destination looks like a directory; give the create action a full archive path: ${destNorm}`)
          }
          const format = ArchiveFormat.createFormatForExt(destNorm)
          if (!format) {
            throw new Error(
              `Cannot infer archive format from "${destNorm}". Supported: .zip, .tar, .tar.gz/.tgz, .gz, .br, .zst, .tar.zst, .7z.`,
            )
          }
          if (format.kind === "7z") {
            const summary = yield* Effect.promise(() => ArchiveSystem.systemCreate(destNorm, sources))
            return { title: destNorm, metadata: meta("create", "7z", sources.length, false, summary.slice(0, 500)), output: summary }
          }
          if (format.kind === "compressed" && !ArchiveFormat.PURE_COMPRESSIONS.has(format.compression)) {
            throw new Error(
              `Creating ${format.compression} archives in-process is not supported. Use the bash tool instead, e.g.:\n  tar -caf ${destNorm} ${sources.join(" ")}`,
            )
          }
          const summary = yield* Effect.promise(() => createPure(destNorm, format, sources))
          return { title: destNorm, metadata: meta("create", formatLabel(format), sources.length, false, summary.slice(0, 500)), output: summary }
        }).pipe(Effect.orDie),
    }
  }),
)
