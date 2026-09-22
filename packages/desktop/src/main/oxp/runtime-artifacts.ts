import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const POINTER_VERSION = 1
const LOCK_FILE = ".oxp-runtime-refresh.lock"
const POINTER_FILE = "accepted.json"

type AcceptedPointer = {
  readonly version: 1
  readonly artifactFile: string
  readonly runtimeID: string
  readonly snapshot: string
}

export class RuntimeArtifactError extends Error {
  constructor(
    readonly code: "busy" | "conflict" | "unavailable",
    message: string,
  ) {
    super(message)
    this.name = "RuntimeArtifactError"
  }
}

function normalized(value: string) {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function isRefreshableArtifact(filepath: string) {
  return normalized(filepath).replaceAll("\\", "/").endsWith("/dist/node/node.js")
}

function relativeKey(value: string) {
  return value.split(path.sep).join("/")
}

function byteSort(left: string, right: string) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

async function listFiles(root: string) {
  const output: string[] = []
  const stack = [""]
  while (stack.length) {
    const relative = stack.pop()!
    const directory = path.join(root, relative)
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const child = relative ? path.join(relative, entry.name) : entry.name
      if (child === LOCK_FILE) continue
      if (entry.isDirectory()) {
        stack.push(child)
        continue
      }
      if (!entry.isFile()) {
        throw new RuntimeArtifactError(
          "unavailable",
          "The OXP runtime artifact directory contains an unsupported filesystem entry.",
        )
      }
      output.push(relativeKey(child))
    }
  }
  return output.sort(byteSort)
}

function identityFile(relative: string) {
  const name = path.posix.basename(relative)
  return name !== ".build-stamp" && !name.endsWith(".map")
}

async function hashFileInto(hash: ReturnType<typeof createHash>, filepath: string) {
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filepath)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.once("error", reject)
    stream.once("end", resolve)
  })
}

export async function fingerprintRuntimeDirectory(root: string) {
  const files = (await listFiles(root)).filter(identityFile)
  const hash = createHash("sha256")
  for (const relative of files) {
    const filepath = path.join(root, ...relative.split("/"))
    const stat = await fs.stat(filepath)
    const name = Buffer.from(relative, "utf8")
    const header = Buffer.allocUnsafe(12)
    header.writeUInt32BE(name.length, 0)
    header.writeBigUInt64BE(BigInt(stat.size), 4)
    hash.update(header)
    hash.update(name)
    await hashFileInto(hash, filepath)
  }
  return `sha256:${hash.digest("hex")}`
}

async function copyFileWithMetadata(source: string, destination: string) {
  const metadata = await fs.stat(source)
  await fs.copyFile(source, destination)
  await fs.chmod(destination, metadata.mode).catch(() => undefined)
  await fs.utimes(destination, metadata.atime, metadata.mtime)
}

async function copySnapshot(source: string, destination: string) {
  await fs.rm(destination, { recursive: true, force: true })
  await fs.mkdir(destination, { recursive: true })
  for (const relative of await listFiles(source)) {
    const parts = relative.split("/")
    const from = path.join(source, ...parts)
    const to = path.join(destination, ...parts)
    await fs.mkdir(path.dirname(to), { recursive: true })
    await copyFileWithMetadata(from, to)
  }
}

async function restoreSnapshot(source: string, destination: string) {
  const expected = new Set(await listFiles(source))
  const existing = await listFiles(destination)

  for (const relative of expected) {
    const parts = relative.split("/")
    const from = path.join(source, ...parts)
    const to = path.join(destination, ...parts)
    await fs.mkdir(path.dirname(to), { recursive: true })
    await copyFileWithMetadata(from, to)
  }

  for (const relative of existing) {
    if (expected.has(relative)) continue
    await fs.rm(path.join(destination, ...relative.split("/")), { force: true })
  }
}

async function atomicJson(filepath: string, value: unknown) {
  const temporary = `${filepath}.${process.pid}.${randomUUID()}.tmp`
  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  })
  await fs.rename(temporary, filepath)
}

async function readPointer(filepath: string): Promise<AcceptedPointer | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filepath, "utf8")) as Partial<AcceptedPointer>
    if (
      parsed.version !== POINTER_VERSION ||
      typeof parsed.artifactFile !== "string" ||
      typeof parsed.runtimeID !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(parsed.runtimeID) ||
      typeof parsed.snapshot !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.snapshot)
    ) {
      return
    }
    return parsed as AcceptedPointer
  } catch {
    return
  }
}

export class RuntimeArtifactStore {
  readonly artifactFile: string
  readonly artifactDir: string
  readonly checkpointRoot: string
  readonly lockFile: string
  private readonly pointerFile: string
  private readonly snapshotsDir: string

  private constructor(
    artifactFile: string,
    checkpointRoot: string,
  ) {
    this.artifactFile = artifactFile
    this.artifactDir = path.dirname(artifactFile)
    this.checkpointRoot = checkpointRoot
    this.lockFile = path.join(this.artifactDir, LOCK_FILE)
    this.pointerFile = path.join(checkpointRoot, POINTER_FILE)
    this.snapshotsDir = path.join(checkpointRoot, "snapshots")
  }

  static async create(artifactUrl: string, checkpointRoot: string) {
    const url = new URL(artifactUrl)
    if (url.protocol !== "file:") {
      throw new RuntimeArtifactError("unavailable", "The OXP runtime artifact is not file-backed.")
    }
    url.search = ""
    url.hash = ""
    const artifactFile = await fs.realpath(fileURLToPath(url))
    if (!isRefreshableArtifact(artifactFile)) {
      throw new RuntimeArtifactError("unavailable", "The OXP runtime artifact is not a mutable Node sidecar build.")
    }
    return new RuntimeArtifactStore(artifactFile, checkpointRoot)
  }

  async currentID() {
    return fingerprintRuntimeDirectory(this.artifactDir)
  }

  private snapshotPath(runtimeID: string) {
    return path.join(this.snapshotsDir, runtimeID.slice("sha256:".length))
  }

  async snapshotCurrent() {
    const before = await this.currentID()
    const temporary = path.join(
      this.checkpointRoot,
      `snapshot.${process.pid}.${randomUUID()}.tmp`,
    )
    await copySnapshot(this.artifactDir, temporary)
    const [after, copied] = await Promise.all([
      this.currentID(),
      fingerprintRuntimeDirectory(temporary),
    ])
    if (before !== after || copied !== before) {
      await fs.rm(temporary, { recursive: true, force: true })
      throw new RuntimeArtifactError(
        "conflict",
        "The OXP runtime artifact changed while it was being snapshotted.",
      )
    }

    const destination = this.snapshotPath(before)
    try {
      await fs.access(destination)
      const existing = await fingerprintRuntimeDirectory(destination)
      if (existing !== before) {
        throw new RuntimeArtifactError(
          "unavailable",
          "An existing OXP runtime checkpoint failed integrity validation.",
        )
      }
      await fs.rm(temporary, { recursive: true, force: true })
    } catch (error) {
      if (error instanceof RuntimeArtifactError) {
        await fs.rm(temporary, { recursive: true, force: true })
        throw error
      }
      await fs.mkdir(this.snapshotsDir, { recursive: true })
      await fs.rename(temporary, destination)
    }
    return { runtimeID: before, snapshot: destination }
  }

  async accepted() {
    const pointer = await readPointer(this.pointerFile)
    if (!pointer) return
    if (normalized(pointer.artifactFile) !== normalized(this.artifactFile)) return
    const snapshot = this.snapshotPath(pointer.runtimeID)
    if (path.basename(snapshot) !== pointer.snapshot) return
    try {
      const fingerprint = await fingerprintRuntimeDirectory(snapshot)
      if (fingerprint !== pointer.runtimeID) return
    } catch {
      return
    }
    return { ...pointer, snapshotPath: snapshot }
  }

  async initializeAccepted() {
    const current = await this.snapshotCurrent()
    const pointer: AcceptedPointer = {
      version: POINTER_VERSION,
      artifactFile: this.artifactFile,
      runtimeID: current.runtimeID,
      snapshot: path.basename(current.snapshot),
    }
    await atomicJson(this.pointerFile, pointer)
    return { ...pointer, snapshotPath: current.snapshot }
  }

  private processAlive(pid: number) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private lockPid(owner: string) {
    const match = /^(?:build|trial|startup):(\d+)(?::|$)/.exec(owner)
    return match ? Number(match[1]) : undefined
  }

  private async acquireOwner(owner: string) {
    try {
      await fs.writeFile(this.lockFile, `${owner}\n`, {
        encoding: "utf8",
        flag: "wx",
      })
      return true
    } catch {
      return false
    }
  }

  private async releaseOwner(owner: string) {
    try {
      const current = (await fs.readFile(this.lockFile, "utf8")).trim()
      if (current !== owner) return
      await fs.rm(this.lockFile, { force: true })
    } catch {}
  }

  private async acquireStartupLock() {
    const owner = `startup:${process.pid}`
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (await this.acquireOwner(owner)) return owner
      let current = ""
      try {
        current = (await fs.readFile(this.lockFile, "utf8")).trim()
      } catch {
        continue
      }
      const pid = this.lockPid(current)
      if (pid === undefined || !this.processAlive(pid)) {
        await fs.rm(this.lockFile, { force: true }).catch(() => undefined)
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new RuntimeArtifactError(
      "busy",
      "A live OXP runtime artifact build did not release its lock before startup recovery timed out.",
    )
  }

  async recoverAccepted() {
    const owner = await this.acquireStartupLock()
    try {
      const accepted = await this.accepted()
      if (!accepted) {
        let checkpointEntries: string[] = []
        try {
          checkpointEntries = await fs.readdir(this.checkpointRoot)
        } catch {}
        const hasPriorCheckpointState = checkpointEntries.some(
          (entry) => entry === POINTER_FILE || entry === "snapshots",
        )
        if (hasPriorCheckpointState) {
          throw new RuntimeArtifactError(
            "unavailable",
            "The durable accepted OXP runtime checkpoint is missing or invalid.",
          )
        }
        return await this.initializeAccepted()
      }
      await this.restore(accepted.snapshotPath, accepted.runtimeID)
      return accepted
    } finally {
      await this.releaseOwner(owner)
    }
  }

  async acquire(trialID: string) {
    const owner = `trial:${process.pid}:${trialID}`
    if (await this.acquireOwner(owner)) return
    throw new RuntimeArtifactError(
      "busy",
      "The OXP runtime artifact is already locked by another refresh transaction.",
    )
  }

  async release(trialID?: string) {
    if (!trialID) {
      await fs.rm(this.lockFile, { force: true })
      return
    }
    const expected = `trial:${process.pid}:${trialID}`
    await this.releaseOwner(expected)
  }

  async restore(snapshot: string, expectedRuntimeID: string) {
    const snapshotRoot = path.resolve(snapshot)
    const allowedRoot = path.resolve(this.snapshotsDir)
    const relative = path.relative(allowedRoot, snapshotRoot)
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      relative === ""
    ) {
      throw new RuntimeArtifactError(
        "unavailable",
        "The OXP runtime checkpoint location is invalid.",
      )
    }
    const fingerprint = await fingerprintRuntimeDirectory(snapshotRoot)
    if (fingerprint !== expectedRuntimeID) {
      throw new RuntimeArtifactError(
        "conflict",
        "The OXP runtime checkpoint no longer matches its expected identity.",
      )
    }
    await restoreSnapshot(snapshotRoot, this.artifactDir)
    const restored = await this.currentID()
    if (restored !== expectedRuntimeID) {
      throw new RuntimeArtifactError(
        "unavailable",
        "The OXP runtime checkpoint could not be restored exactly.",
      )
    }
  }

  async accept(snapshot: string, runtimeID: string) {
    const fingerprint = await fingerprintRuntimeDirectory(snapshot)
    if (fingerprint !== runtimeID) {
      throw new RuntimeArtifactError(
        "conflict",
        "The candidate OXP runtime checkpoint changed before acceptance.",
      )
    }
    const pointer: AcceptedPointer = {
      version: POINTER_VERSION,
      artifactFile: this.artifactFile,
      runtimeID,
      snapshot: path.basename(snapshot),
    }
    await atomicJson(this.pointerFile, pointer)
  }

  async cleanup(keepRuntimeIDs: readonly string[]) {
    const keep = new Set(keepRuntimeIDs.map((id) => id.slice("sha256:".length)))
    let entries: string[]
    try {
      entries = await fs.readdir(this.snapshotsDir)
    } catch {
      return
    }
    await Promise.all(
      entries.map((entry) =>
        keep.has(entry)
          ? Promise.resolve()
          : fs.rm(path.join(this.snapshotsDir, entry), {
              recursive: true,
              force: true,
            }),
      ),
    )
  }
}

export async function recoverAcceptedRuntime(
  artifactUrl: string,
  checkpointRoot: string,
) {
  const store = await RuntimeArtifactStore.create(artifactUrl, checkpointRoot)
  return store.recoverAccepted()
}
