import fs from "node:fs/promises"
import path from "path"
import type { ArchiveFormat } from "./format"

// System-tool backend for formats the pure parser cannot handle in-process
// (.7z, .rar, xz/lz4/lzma). Prefers 7-Zip, then bsdtar/GNU tar, then unrar.

export type ListedEntry = {
  name: string
  dir: boolean
  size: number
}

export type Backend = { kind: "7z" | "tar" | "unrar"; tool: string }

export async function findTool(name: string): Promise<string | undefined> {
  const onPath = Bun.which(name)
  if (onPath) return onPath
  if (name === "7z" && process.platform === "win32") {
    const candidates = ["C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe"]
    for (const candidate of candidates) {
      try {
        await fs.access(candidate)
        return candidate
      } catch {
        // keep looking
      }
    }
  }
  return undefined
}

export async function resolveBackend(format: ArchiveFormat): Promise<Backend> {
  const sevenZip = (await findTool("7z")) ?? (await findTool("7za")) ?? (await findTool("7zr"))
  const tar = await findTool("tar")
  if (format.kind === "7z" || format.kind === "rar") {
    if (sevenZip) return { kind: "7z", tool: sevenZip }
    if (format.kind === "rar") {
      const unrar = await findTool("unrar")
      if (unrar) return { kind: "unrar", tool: unrar }
    }
    return missingBackend(format)
  }
  // Compressed tar containers (tar.xz, tar.bz2, ...): tar lists/extracts the
  // actual entries, while 7z only sees the outer stream, so prefer tar here.
  if (format.kind === "compressed" && format.container === "tar") {
    if (tar) return { kind: "tar", tool: tar }
    if (sevenZip) return { kind: "7z", tool: sevenZip }
    return missingBackend(format)
  }
  if (sevenZip) return { kind: "7z", tool: sevenZip }
  return missingBackend(format)
}

function missingBackend(format: ArchiveFormat): never {
  const label = format.kind === "compressed" ? format.compression : format.kind
  throw new Error(
    [
      `Cannot process a ${label} archive without a system tool installed.`,
      `Install 7-Zip (the '7z' command) and retry, or run the commands yourself in the bash tool:`,
      format.kind === "rar"
        ? `  unrar l <archive>\n  unrar x <archive> <dest>/`
        : `  7z l <archive>\n  7z x <archive> -o<dest>`,
    ].join("\n"),
  )
}

export async function systemList(format: ArchiveFormat, archive: string): Promise<ListedEntry[]> {
  const backend = await resolveBackend(format)
  if (backend.kind === "7z") {
    const { code, stdout, stderr } = await run(backend.tool, ["l", "-slt", archive])
    if (code !== 0) throw new Error(`7z could not read the archive: ${stderr.trim() || new TextDecoder().decode(stdout).slice(0, 200)}`)
    return parse7zListing(stdout)
  }
  if (backend.kind === "tar") {
    const { code, stdout, stderr } = await run(backend.tool, ["-tvf", archive])
    if (code !== 0) throw new Error(`tar could not read the archive: ${stderr.trim() || new TextDecoder().decode(stdout).slice(0, 200)}`)
    return parseTarListing(stdout)
  }
  const { code, stdout, stderr } = await run(backend.tool, ["lb", archive])
  if (code !== 0) throw new Error(`unrar could not read the archive: ${stderr.trim() || new TextDecoder().decode(stdout).slice(0, 200)}`)
  return new TextDecoder()
    .decode(stdout)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => ({ name: line.trim(), dir: line.trim().endsWith("/"), size: 0 }))
}

export async function systemExtract(format: ArchiveFormat, archive: string, dest: string): Promise<string> {
  const backend = await resolveBackend(format)
  let args: string[]
  if (backend.kind === "7z") args = ["x", archive, `-o${dest}`, "-y"]
  else if (backend.kind === "tar") args = ["-xf", archive, "-C", dest]
  else args = ["x", "-y", archive, dest + path.sep]
  const { code, stdout, stderr } = await run(backend.tool, args)
  if (code !== 0) {
    throw new Error(`Extraction failed (${path.basename(backend.tool)}): ${stderr.trim() || new TextDecoder().decode(stdout).slice(0, 300)}`)
  }
  return backend.kind === "7z" ? summarize7z(stdout) : `Extracted with ${path.basename(backend.tool)}.`
}

export async function systemRead(format: ArchiveFormat, archive: string, entry: string): Promise<Uint8Array> {
  const backend = await resolveBackend(format)
  if (backend.kind === "7z") {
    const args = entry ? ["e", archive, entry, "-so"] : ["e", archive, "-so"]
    const { code, stdout, stderr } = await run(backend.tool, args)
    if (code !== 0 || stdout.length === 0) {
      throw new Error(`Could not read "${entry}" from the archive: ${stderr.trim() || "entry not found"}`)
    }
    return stdout
  }
  const { code, stdout, stderr } = await run(backend.tool, ["-xOf", archive, entry])
  if (code !== 0) {
    throw new Error(`Could not read "${entry}" from the archive: ${stderr.trim() || "entry not found"}`)
  }
  return stdout
}

export async function systemCreate(dest: string, sources: string[]): Promise<string> {
  const sevenZip = (await findTool("7z")) ?? (await findTool("7za")) ?? (await findTool("7zr"))
  if (!sevenZip) {
    throw new Error(
      "Creating 7-Zip archives requires the '7z' command. Install 7-Zip or use the bash tool: 7z a <dest> <sources>",
    )
  }
  const { code, stdout, stderr } = await run(sevenZip, ["a", "-y", dest, ...sources])
  if (code !== 0) throw new Error(`7z could not create the archive: ${stderr.trim() || new TextDecoder().decode(stdout).slice(0, 300)}`)
  return `Created ${path.basename(dest)} with 7-Zip.`
}

async function run(tool: string, args: string[]): Promise<{ code: number; stdout: Uint8Array; stderr: string }> {
  const proc = Bun.spawn([tool, ...args], { stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { code, stdout: new Uint8Array(out), stderr: err }
}

function parse7zListing(stdout: Uint8Array): ListedEntry[] {
  const text = new TextDecoder().decode(stdout).replace(/\r/g, "")
  const entries: ListedEntry[] = []
  let started = false
  let current: ListedEntry | undefined
  for (const line of text.split("\n")) {
    if (line.startsWith("----------")) {
      started = true
      continue
    }
    if (!started) continue
    if (line.startsWith("Path = ")) {
      current = { name: line.slice(7), dir: false, size: 0 }
      entries.push(current)
    } else if (current && line.startsWith("Size = ")) {
      current.size = Number(line.slice(7)) || 0
    } else if (current && line.startsWith("Attributes = ")) {
      current.dir = line.slice(13).startsWith("D")
    }
  }
  return entries
}

function parseTarListing(stdout: Uint8Array): ListedEntry[] {
  const text = new TextDecoder().decode(stdout).replace(/\r/g, "")
  const entries: ListedEntry[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    const gnu = line.match(/^(\S+)\s+(\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(\S.*)$/)
    if (gnu) {
      const name = gnu[6]
      entries.push({ name, dir: name.endsWith("/"), size: Number(gnu[3]) })
      continue
    }
    const bsdtar = line.match(/^(\S+)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}\s+(\S.*)$/)
    if (bsdtar) {
      const name = bsdtar[3]
      entries.push({ name, dir: name.endsWith("/"), size: Number(bsdtar[2]) })
      continue
    }
    const name = line.trim()
    entries.push({ name, dir: name.endsWith("/"), size: 0 })
  }
  return entries
}

function summarize7z(stdout: Uint8Array): string {
  const tail = new TextDecoder().decode(stdout).split("\n").filter((line) => line.trim()).slice(-6).join("\n")
  return `Extracted with 7-Zip.\n${tail}`
}


export * as ArchiveSystem from "./system"

