import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Filesystem } from "@/util/filesystem"

export type Policy = { autoAccept: Record<string, boolean>; revision: number }
export type PolicyRef = { current: Policy }
type Document = Record<string, Policy>
const empty = (): Policy => ({ autoAccept: {}, revision: 0 })
const cache = new Map<string, PolicyRef>()
const reads = new Map<string, number>()
let fileReads = 0
let fileLocks = 0
const MAX_LOCATIONS = 2048
const MAX_POLICY_KEYS = 4096
const MAX_DOCUMENT_BYTES = 512 * 1024
const file = () => path.join(Global.Path.state, "permission-auto-accept.json")
const lock = () => `permission-auto-accept:${file()}`
async function read(): Promise<Document> {
  // The owner-level cache should make reads scale with active locations, not
  // with permission asks. Counts are kept per location for regression probes.
  fileReads++
  return Filesystem.readJson<Document>(file()).catch(() => ({}))
}

function cacheSet(directory: string, reference: PolicyRef) {
  if (!cache.has(directory) && cache.size >= MAX_LOCATIONS) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
  cache.set(directory, reference)
}

/** A location-scoped durable policy. Replacing one location is serialized with other clients. */
export async function get(directory: string): Promise<PolicyRef> {
  const key = FSUtil.resolve(directory)
  const existing = cache.get(key)
  if (existing) return existing
  return Flock.withLock(lock(), async () => {
    fileLocks++
    const concurrent = cache.get(key)
    if (concurrent) return concurrent
    reads.set(key, (reads.get(key) ?? 0) + 1)
    const policy = { current: (await read())[key] ?? empty() }
    cacheSet(key, policy)
    return policy
  })
}

export function readCount(directory: string) {
  return reads.get(FSUtil.resolve(directory)) ?? 0
}

export function ioCount() {
  return { reads: fileReads, locks: fileLocks }
}

export async function remove(directory: string): Promise<void> {
  const key = FSUtil.resolve(directory)
  await Flock.withLock(lock(), async () => {
    fileLocks++
    const document = await read()
    delete document[key]
    await Filesystem.writeJson(file(), document)
    cache.delete(key)
  })
}

export async function update(directory: string, updates: Record<string, boolean>, mode: "hydrate" | "patch"): Promise<Policy> {
  const key = FSUtil.resolve(directory)
  if (Object.keys(updates).length > MAX_POLICY_KEYS) throw new Error("auto-accept policy exceeds key limit")
  let result = empty()
  await Flock.withLock(lock(), async () => {
    fileLocks++
    const document = await read()
    const current = document[key] ?? empty()
    if (!document[key] && Object.keys(document).length >= MAX_LOCATIONS) throw new Error("too many auto-accept locations")
    const autoAccept = { ...current.autoAccept }
    for (const [policyKey, value] of Object.entries(updates)) {
      if (mode === "patch" || autoAccept[policyKey] === undefined) autoAccept[policyKey] = value
    }
    if (Object.keys(autoAccept).length > MAX_POLICY_KEYS) throw new Error("auto-accept policy exceeds key limit")
    result = { autoAccept, revision: current.revision + 1 }
    document[key] = result
    if (Buffer.byteLength(JSON.stringify(document), "utf8") > MAX_DOCUMENT_BYTES) throw new Error("auto-accept policy exceeds size limit")
    await Filesystem.writeJson(file(), document)
    const live = cache.get(key)
    if (live) live.current = result
    else cacheSet(key, { current: result })
  })
  return result
}

export function acceptsLineage(reference: PolicyRef, lineage: readonly string[], directoryKey: string) {
  const policy = reference.current
  for (const sessionID of lineage) {
    const value = policy.autoAccept[sessionID]
    if (value !== undefined) return value
  }
  return policy.autoAccept[directoryKey] === true
}
