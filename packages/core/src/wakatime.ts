export * as WakaTime from "./wakatime"

import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { inflateRawSync } from "node:zlib"
import { Clock, Context, Effect, Exit, Fiber, Layer, Scope, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ChildProcess } from "effect/unstable/process"
import { CodingActivity } from "./coding-activity"
import { makeGlobalNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"
import { FSUtil } from "./fs-util"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { InstallationVersion } from "./installation/version"
import { AppProcess } from "./process"
import { collectBoundedResponseBody } from "./tool/http-body"
import { Flock } from "./util/flock"
import { which } from "./util/which"

const DEBOUNCE_MS = 1_500
/** Hard cap on queued observations. Exported so the eviction behavior is testable. */
export const MAX_PENDING = 512
/**
 * Hard ceiling on any managed-CLI download: the release archive, the checksum
 * manifest, and the release metadata all pass through one bounded collector, so
 * a single bound is both the archive limit and the metadata limit.
 */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const SENTINEL_TIMEOUT = "15 seconds"
const SHUTDOWN_FLUSH_TIMEOUT = "2 seconds"
const RELEASE_BASE = "https://github.com/wakatime/wakatime-cli"
const LATEST_RELEASE_URL = "https://api.github.com/repos/wakatime/wakatime-cli/releases/latest"
/**
 * How long a credential-presence probe is reused. Long enough that a burst of
 * coalescing windows costs no filesystem work, short enough that configuring
 * WakaTime while the process is running is picked up promptly.
 */
const CONFIG_PROBE_TTL_MS = 30_000
/**
 * Bounded time for a managed-update HTTP request. Size limits alone are not
 * enough: a hung request would hold the single delivery permit indefinitely and
 * stop telemetry. The update is best-effort, so a timeout is simply another
 * failed attempt that the next due check retries.
 */
export const MANAGED_HTTP_TIMEOUT = "30 seconds"

/**
 * Minimum wall-clock gap between two wakatime-cli spawns for the same project.
 * The 1.5s debounce bounds how often a burst is *coalesced*; this bounds how
 * often it is *delivered*. Both are needed: a long agent turn touching many
 * files would otherwise spawn a process per debounce window.
 */
export const MIN_DELIVERY_INTERVAL_MS = 60_000

/**
 * How many recent authoritative observations suppress replays. Replay
 * protection is a bounded recent window, not a durable log: the bound is what
 * keeps a long-lived process from growing without limit.
 */
export const REPLAY_DEDUPE_BOUND = 2_048

/**
 * Hard cap on remembered project delivery windows. The limiter is keyed by
 * project directory, so an uncapped map would let a long-lived process
 * accumulate one entry per checkout it ever saw — unbounded background state on
 * a Tier-0 service. Tied to the queue bound: more live projects than pending
 * work is not a state worth keeping.
 */
export const DELIVERY_PROJECT_BOUND = 512

/**
 * Hard cap on pending session urgency markers. Markers are best-effort
 * telemetry: evicting the oldest is acceptable because the scheduler consumes
 * them promptly, and a hard bound is what keeps N sessions from accumulating N
 * pieces of background state on a Tier-0 service.
 */
export const URGENT_SESSION_BOUND = 64

/** Longest gap between two managed-CLI freshness checks. */
export const MANAGED_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000

/**
 * The delivery-limiter bucket for observations whose project was never proven.
 * One reserved key, not a key per observation: inventing a project identity
 * would exempt those records from the limiter entirely.
 */
export const NO_PROJECT_KEY = "<no-project>"

/** CodingActivity observation kind, retained as internal routing metadata. */
export type ObservationKind = CodingActivity.Kind

/**
 * The identity WakaTime sees for a delivery.
 *
 * The client is part of the plugin identity because that is how WakaTime
 * attributes AI coding time (`openfork-cli/1.2.3`, `openfork-desktop/1.2.3`).
 * It is read from the process environment, which the host owns and sets before
 * Core initializes, and it is never derived per session: Core reports the
 * client it is actually running inside and claims nothing beyond that.
 */
export function pluginIdentifier(client = Flag.OPENCODE_CLIENT) {
  // WakaTime parses this as `name/version`, so a client value carrying a
  // separator or whitespace would corrupt that grammar and split the identity
  // into something the dashboard cannot attribute. Collapse anything outside a
  // stable token alphabet to a dash, then fall back rather than emit an empty
  // segment.
  const token = (client ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `openfork-${token || "cli"}/${InstallationVersion}`
}

export type EntityType = "file" | "app"

export interface Activity {
  readonly entity: string
  readonly entityType?: EntityType
  readonly projectFolder?: string
  readonly category?: "ai coding" | "coding" | "building" | "debugging" | "running tests" | "writing tests" | "writing docs" | "code reviewing" | "researching"
  readonly isWrite?: boolean
  readonly isUnsavedEntity?: boolean
  /**
   * Net AI line change: additions minus deletions. Signed on purpose. A rewrite
   * that removes more than it adds is a real negative delta; clamping it to
   * zero would report deletion-heavy work as "no change".
   */
  readonly aiLineChanges?: number
  /** Unix epoch milliseconds. Defaults to the observation time. */
  readonly time?: number
  /**
   * INTERNAL. Session that produced the observation, so one session's queued
   * time can be delivered on its own. wakatime-cli has no field for it and it
   * is never serialized onto the wire.
   */
  readonly aiSession?: string
  /** INTERNAL. Producer that produced the observation. Never sent to the CLI. */
  readonly source?: CodingActivity.Source
  /**
   * INTERNAL. Authoritative producer reference for this observation. Its
   * presence is what makes a record eligible for replay suppression; a record
   * without one is never deduped. Never sent to the CLI.
   */
  readonly sourceRef?: string
  /** INTERNAL. Observation kind, used to scope replay suppression. Never sent to the CLI. */
  readonly kind?: ObservationKind
}

export interface Status {
  /**
   * Effective opt-in: the explicit `OPENFORK_WAKATIME` override when it is set,
   * otherwise the persisted Core setting. Defaults to false — WakaTime never
   * records, resolves a binary, or sends anything until a caller turns it on.
   */
  readonly enabled: boolean
  /** Authentication material is present, so an enabled service could send. */
  readonly configured: boolean
  /** Present only when an already-resolved binary exists; never triggers a download. */
  readonly cli?: string
  readonly source?: "override" | "system" | "managed"
}

export interface Interface {
  /**
   * Queue one or more coding observations. Producers never wait for network I/O
   * and WakaTime failures never participate in the caller's success semantics.
   */
  readonly record: (activity: Activity | readonly Activity[]) => Effect.Effect<void>
  /**
   * Deliver everything currently queued, across every session. The caller
   * asked for it, so the per-project delivery limiter does not hold it.
   */
  readonly flush: () => Effect.Effect<void>
  /**
   * Ask for one session's queued activity to be delivered promptly, and return.
   *
   * A session with nothing queued is a true no-op: the pending-session index
   * answers in O(1), so a settled session's End call costs one map lookup and
   * cannot pull another session's work out of its debounce or delivery window.
   *
   * This is the host Idle/End adapter's call, so it is deliberately
   * non-blocking: it performs only bounded process-memory work under the queue
   * mutex — a trim, a bounded insertion-ordered urgency marker, and a re-arm of
   * the one existing scheduler. It never resolves a binary, reads the
   * filesystem, touches the network, spawns a process, scans history, or
   * creates a per-session fiber or timer. Urgency is a request, not a promise.
   */
  readonly requestFlushSession: (sessionID: string) => Effect.Effect<void>
  /**
   * Deliver exactly one session's queued activity now and only return once that
   * has been attempted, leaving every other session queued — including their
   * pending coalescing window. The delivery limiter does not hold this call
   * either. This is the completion-oriented form for tests and manual shutdown;
   * the host Idle adapter must use `requestFlushSession` instead.
   */
  readonly flushSession: (sessionID: string) => Effect.Effect<void>
  /** Bootstrap-free diagnostics for settings/CLI surfaces. Never downloads. */
  readonly status: () => Effect.Effect<Status>
  /**
   * Persist the explicit opt-in and return the resulting status. Core owns this
   * mutation: no other layer may hold enablement authority. A write failure is
   * reported rather than swallowed, and leaves the previous state in force.
   */
  readonly setEnabled: (enabled: boolean) => Effect.Effect<Status, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WakaTime") {}

type BinarySource = "override" | "system" | "managed"
type Binary = { readonly path: string; readonly source: BinarySource }

/**
 * Asset URL for one exact release.
 *
 * Never `/releases/latest/download`: that pointer is resolved per request, so a
 * release published between the metadata fetch and the asset fetch would let the
 * manifest and the archive come from different releases. The tag is
 * path-encoded so nothing in it can escape its path segment.
 */
function releaseUrl(tag: string, file: string) {
  return `${RELEASE_BASE}/releases/download/${encodeURIComponent(tag)}/${file}`
}

function envToggle(value: string | undefined) {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  return undefined
}

// Persisted opt-in ----------------------------------------------------------------

/**
 * The persisted opt-in. It carries the enablement flag and nothing else: no API
 * key, token, or other secret belongs in this document, and unknown fields are
 * dropped on the next write.
 */
export interface Settings {
  readonly enabled: boolean
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({ enabled: false })

/**
 * Managed-CLI freshness metadata. Deliberately limited to non-secret facts: a
 * version string and when it was observed. No API key, token, or other
 * credential is ever written here, because this document is a plain-state
 * cache and not a secret store.
 */
export interface ManagedState {
  /** Unix epoch millis of the last freshness check attempt, successful or not. */
  readonly checkedAt: number
  /** Latest upstream CLI version observed by that check, when one was read. */
  readonly version?: string
}

export const DEFAULT_MANAGED_STATE: ManagedState = Object.freeze({ checkedAt: 0 })

const WRITE_LOCK_TIMEOUT_MS = 5_000
/**
 * Cross-process managed-update commit lock. Generous because the critical section
 * is a state re-read plus two filesystem operations, never the download.
 */
const UPDATE_LOCK_TIMEOUT_MS = 15_000

export function settingsFile() {
  return path.join(Global.Path.state, "wakatime.json")
}

export function cliStateFile() {
  return path.join(Global.Path.state, "wakatime-cli.json")
}

export function parseManagedState(raw: unknown): ManagedState {
  if (typeof raw !== "object" || raw === null) return DEFAULT_MANAGED_STATE
  const document = raw as { checkedAt?: unknown; version?: unknown }
  const checkedAt =
    typeof document.checkedAt === "number" && Number.isFinite(document.checkedAt) && document.checkedAt >= 0
      ? document.checkedAt
      : 0
  const version = typeof document.version === "string" ? document.version.trim() : ""
  return version ? { checkedAt, version } : { checkedAt }
}

/**
 * Whether another process completed a freshness decision after the snapshot that
 * justified this check.
 *
 * This is the compare half of the managed-CLI commit. A candidate is fetched and
 * verified outside the cross-process lock, by which time a peer may have already
 * published a newer decision; committing the candidate then would downgrade both
 * the installed binary and the recorded version. The check is deliberately about
 * the *snapshot*, not about the candidate, so it cannot be satisfied by anything
 * this process observed on its own.
 */
export function supersededByPeer(observed: ManagedState, latest: ManagedState) {
  return observed.checkedAt !== latest.checkedAt || observed.version !== latest.version
}

/**
 * Whether a managed-CLI freshness check is due. A failed check consumes the
 * window too, so an unreachable network cannot turn every heartbeat into a
 * check attempt.
 */
export function managedCheckDue(state: ManagedState, now: number, intervalMs = MANAGED_CHECK_INTERVAL_MS) {
  // A recorded time of zero means "never checked", which is always due.
  if (state.checkedAt <= 0) return true
  return now - state.checkedAt >= intervalMs
}

export function parseSettings(raw: unknown): Settings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SETTINGS
  const enabled = (raw as { enabled?: unknown }).enabled
  return typeof enabled === "boolean" ? { enabled } : DEFAULT_SETTINGS
}

function configHome() {
  return process.env.WAKATIME_HOME?.trim() || Global.Path.home
}

function managedBinary() {
  return path.join(Global.Path.bin, process.platform === "win32" ? "wakatime-cli.exe" : "wakatime-cli")
}

function managedName() {
  return process.platform === "win32" ? "wakatime-cli.exe" : "wakatime-cli"
}

function platformAsset() {
  const arch =
    process.arch === "x64"
      ? "amd64"
      : process.arch === "arm64"
        ? "arm64"
        : process.arch === "ia32"
          ? "386"
          : undefined
  const platform =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "darwin"
        : process.platform === "linux"
          ? "linux"
          : undefined
  if (!arch || !platform) return undefined
  const binary = `wakatime-cli-${platform}-${arch}${platform === "windows" ? ".exe" : ""}`
  return { binary, archive: `${binary.replace(/\.exe$/, "")}.zip` }
}

function findEndOfCentralDirectory(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const minimum = Math.max(0, bytes.byteLength - 0xffff - 22)
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset
  }
  throw new Error("WakaTime archive is missing ZIP end-of-central-directory metadata")
}

/**
 * Minimal ZIP reader for official WakaTime release archives. It deliberately
 * supports only stored/deflated files and reads through the central directory
 * so data-descriptor archives remain valid.
 */
export function extractReleaseBinary(archive: Uint8Array, filename: string): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const eocd = findEndOfCentralDirectory(archive)
  const entries = view.getUint16(eocd + 10, true)
  let cursor = view.getUint32(eocd + 16, true)

  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > archive.byteLength || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error("WakaTime archive has an invalid ZIP central directory")
    }
    const compression = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const nameStart = cursor + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > archive.byteLength) throw new Error("WakaTime archive contains an invalid filename")
    const name = new TextDecoder().decode(archive.subarray(nameStart, nameEnd))

    if (name === filename || name.endsWith(`/${filename}`)) {
      if (localOffset + 30 > archive.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error("WakaTime archive contains an invalid local ZIP header")
      }
      const localNameLength = view.getUint16(localOffset + 26, true)
      const localExtraLength = view.getUint16(localOffset + 28, true)
      const start = localOffset + 30 + localNameLength + localExtraLength
      const end = start + compressedSize
      if (end > archive.byteLength) throw new Error("WakaTime archive entry exceeds archive bounds")
      const payload = archive.subarray(start, end)
      const output =
        compression === 0
          ? Uint8Array.from(payload)
          : compression === 8
            ? Uint8Array.from(inflateRawSync(payload))
            : undefined
      if (!output) throw new Error(`Unsupported WakaTime ZIP compression method: ${compression}`)
      if (output.byteLength !== uncompressedSize) {
        throw new Error("WakaTime archive entry failed its uncompressed-size check")
      }
      return output
    }

    cursor = nameEnd + extraLength + commentLength
  }
  throw new Error(`WakaTime archive did not contain ${filename}`)
}

/** Reads one `<sha256>  <file>` manifest line. Shared by the download path and its tests. */
export function parseChecksum(manifest: string, filename: string) {
  for (const line of manifest.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (match?.[2] === filename) return match[1]!.toLowerCase()
  }
  throw new Error(`WakaTime checksum manifest did not contain ${filename}`)
}

/**
 * The only path from a downloaded archive to replacement bytes. The published
 * checksum is checked first and the bounded extract second, so a corrupt or
 * substituted archive cannot produce a binary, and a wrong digest throws before
 * anything is written anywhere.
 */
export function verifyReleaseArchive(
  manifest: string,
  archive: Uint8Array,
  asset: { readonly binary: string; readonly archive: string },
) {
  const expected = parseChecksum(manifest, asset.archive)
  const actual = createHash("sha256").update(archive).digest("hex")
  if (actual !== expected) throw new Error(`WakaTime archive checksum mismatch for ${asset.archive}`)
  return extractReleaseBinary(archive, asset.binary)
}

export interface LatestRelease {
  /** The exact `tag_name` the upstream payload reported. Asset URLs use only this. */
  readonly tag: string
  /** Normalized form, used for comparison and persistence. Never an asset URL. */
  readonly version: string
}

/**
 * The latest upstream release, read from the public latest-release document.
 *
 * Both fields matter and neither is derived from the other. `tag` is the exact
 * string the API reported, because it is the asset-URL path segment, and
 * normalizing it would break tags that are not `v`-prefixed. `version` is the
 * comparable, persistable form. An unreadable answer means "unknown", which the
 * caller treats as "do not replace anything".
 */
export function parseLatestRelease(payload: string): LatestRelease | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const tag = (parsed as { tag_name?: unknown }).tag_name
  if (typeof tag !== "string") return undefined
  // Surrounding whitespace is the only thing stripped: the tag itself is what the
  // upstream release is addressed by.
  const raw = tag.trim()
  if (!raw) return undefined
  return { tag: raw, version: raw.replace(/^v/, "") || raw }
}

function activityKey(activity: Activity) {
  // The session is part of the coalescing key, not a detail of it: two
  // sessions working on one file must stay separable, or a session-selective
  // flush could not tell whose time it is delivering.
  return [
    activity.entityType ?? "file",
    activity.aiSession ?? "",
    activity.entity,
    activity.projectFolder ?? "",
  ].join("\u0000")
}

/**
 * The delivery-limiter bucket for one observation. WakaTime organizes by
 * project, and a canonical project directory is the only identity a producer
 * can actually prove, so it is used verbatim when present.
 */
export function projectKey(activity: Activity) {
  const folder = activity.projectFolder?.trim()
  return folder ? folder : NO_PROJECT_KEY
}

/**
 * Identity for replay suppression, or undefined when the record is not
 * eligible.
 *
 * Eligibility requires an authoritative producer reference. Without one there
 * is no proof that two records describe the same event, and dropping a
 * legitimate repeat would lose real coding time — so such records are always
 * kept. With one, the producer guarantees the reference identifies exactly one
 * observation, and the remaining dimensions keep distinct events apart.
 */
export function replayKey(activity: Activity) {
  const reference = activity.sourceRef?.trim()
  if (!reference) return undefined
  return [
    activity.source ?? "",
    activity.aiSession ?? "",
    reference,
    activity.entity,
    activity.kind ?? (activity.isWrite ? "write" : "read"),
  ].join("\u0000")
}

export function mergeActivities(previous: Activity | undefined, next: Activity): Activity {
  if (!previous) return { ...next, time: next.time ?? Date.now() }
  return {
    ...previous,
    ...next,
    time: Math.max(previous.time ?? 0, next.time ?? Date.now()),
    isWrite: previous.isWrite || next.isWrite || undefined,
    isUnsavedEntity: previous.isUnsavedEntity || next.isUnsavedEntity || undefined,
    // Signed net deltas merge arithmetically. Clamping either operand would
    // rewrite a deletion-heavy edit into "no change" and lose the fact that
    // real lines were removed.
    aiLineChanges:
      previous.aiLineChanges === undefined && next.aiLineChanges === undefined
        ? undefined
        : (previous.aiLineChanges ?? 0) + (next.aiLineChanges ?? 0),
  }
}

/**
 * The CodingActivity -> WakaTime projection. CodingActivity publishes epoch
 * seconds; WakaTime observations are epoch millis.
 *
 * The project folder is carried only when the producer proved one. A missing
 * folder stays missing: substituting a project display name or a working
 * directory would silently attribute time to whichever project happens to be
 * current.
 */
export function fromCodingActivity(activity: CodingActivity.Activity): Activity {
  return {
    entity: activity.entity,
    entityType: "file",
    category: "ai coding",
    isWrite: activity.kind === "write",
    ...(activity.aiLineChanges === undefined ? {} : { aiLineChanges: activity.aiLineChanges }),
    ...(activity.projectFolder === undefined ? {} : { projectFolder: activity.projectFolder }),
    // Internal routing metadata. Core needs the session, producer, authoritative
    // reference, and kind to scope selective delivery and replay suppression;
    // wakatime-cli has no field for them, so they stop here.
    aiSession: activity.aiSession,
    source: activity.source,
    sourceRef: activity.sourceRef,
    kind: activity.kind,
    // The observation's own moment, in millis. Never the send time: a coalesced
    // or delayed batch must still report when the work actually happened.
    time: activity.time * 1000,
  }
}

/**
 * The AI line-change value worth reporting, or undefined when the observation
 * has nothing to say. A net of exactly zero is indistinguishable from "no AI
 * change was observed" and is omitted, matching the official adapter. A
 * negative net is a real deletion-dominant edit and is never folded into zero.
 */
function reportableLineChanges(activity: Activity) {
  return activity.aiLineChanges === undefined || activity.aiLineChanges === 0 ? undefined : activity.aiLineChanges
}

function extraHeartbeat(activity: Activity) {
  const lineChanges = reportableLineChanges(activity)
  return {
    entity: activity.entity,
    entity_type: activity.entityType ?? "file",
    category: activity.category ?? "ai coding",
    is_write: activity.isWrite ?? false,
    is_unsaved_entity: activity.isUnsavedEntity ?? false,
    ...(lineChanges === undefined ? {} : { ai_line_changes: lineChanges }),
    // Deliberately no project field. `alternate_project` is a project-NAME
    // override in the WakaTime CLI, not a project-folder field, so emitting it
    // from an extra heartbeat would let one queued observation rename or
    // re-route WakaTime's own project detection and mapping. The invocation's
    // --project-folder and working directory are the only project identity the
    // transport puts on the wire, and both are derived from the same proven
    // folder the group was partitioned by.
    time: (activity.time ?? Date.now()) / 1000,
  }
}

function heartbeatArgs(activity: Activity, extras: boolean) {
  const lineChanges = reportableLineChanges(activity)
  const args = [
    "--entity",
    activity.entity,
    "--entity-type",
    activity.entityType ?? "file",
    "--category",
    activity.category ?? "ai coding",
    "--time",
    String((activity.time ?? Date.now()) / 1000),
    "--plugin",
    pluginIdentifier(),
    // The official CLI now scans AI transcript stores automatically. OpenFork
    // owns its own activity producer and must never ingest/duplicate OpenCode or
    // other editor transcripts as a side effect of sending one heartbeat.
    "--sync-ai-disabled",
  ]
  if (activity.projectFolder) args.push("--project-folder", activity.projectFolder)
  if (activity.isWrite) args.push("--write")
  if (activity.isUnsavedEntity) args.push("--is-unsaved-entity")
  if (lineChanges !== undefined) args.push("--ai-line-changes", String(lineChanges))
  if (extras) args.push("--extra-heartbeats")
  return args
}

/**
 * Tier-0 process-global ownership. CodingActivity's bus is itself process-global,
 * so a second WakaTime layer in a second process graph would subscribe a second
 * time and double-count every heartbeat. Exactly one runtime therefore exists per
 * process: `gate` makes creation and leasing one critical section so two graphs
 * built concurrently cannot both install one, every graph takes a lease, and the
 * last lease released finalizes the runtime. Nothing inside a runtime is
 * graph-scoped: closing one graph must leave the single subscriber, the
 * coalescing queue, and the debounce timer usable by every other graph.
 */
interface ProcessRuntime {
  readonly interface: Interface
  readonly scope: Scope.Closeable
  readonly finalize: Effect.Effect<void>
  leases: number
}

let canonical: ProcessRuntime | undefined

/** One critical section for runtime creation, lease acquisition, and teardown. */
const gate = Semaphore.makeUnsafe(1)

const buildRuntime = () =>
  Effect.gen(function* () {
    // The one scope that owns every WakaTime fiber. It is deliberately not the
    // building graph's scope, and `finalize` closes it exactly once.
    const processScope = Effect.runSync(Scope.make())

    const fs = yield* FSUtil.Service
    const app = yield* AppProcess.Service
    const coding = yield* CodingActivity.Service
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    // The queue lock. Held only for bounded in-memory queue work, never across
    // wakatime-cli, filesystem, or network I/O.
    const mutex = Semaphore.makeUnsafe(1)
    // The delivery permit. Separate from the queue lock on purpose: producers
    // must stay able to enqueue while a CLI process is running, yet only one
    // wakatime-cli pipeline may be in flight at a time so spawns stay sequential
    // and the delivery-window stamps stay coherent.
    const delivery = Semaphore.makeUnsafe(1)
    const resolveGate = Semaphore.makeUnsafe(1)
    const pending = new Map<string, Activity>()
    // Process-side delivery budget. One wakatime-cli spawn per project per
    // interval is the cost this bounds; a burst of edits must not become a
    // burst of processes.
    const lastDelivery = new Map<string, number>()
    // Bounded, insertion-ordered replay suppression. Only authoritative records
    // ever enter it, so eviction can only forget a replay window, never a
    // record that was still queued.
    const seen = new Set<string>()
    // Replay fingerprints currently owned by a still-queued entry, and the
    // reverse index that makes ownership removal O(1). One pending entry may own
    // several fingerprints, because several distinct authoritative calls can
    // coalesce onto it before delivery. Both maps are globally bounded: an owned
    // fingerprint is always also in `seen`, so the total is capped by
    // REPLAY_DEDUPE_BOUND, and the key count by MAX_PENDING.
    const pendingReplay = new Map<string, Set<string>>()
    const replayOwner = new Map<string, string>()
    // Bounded, insertion-ordered urgency markers. One shared set for every
    // session, consumed by the next scheduler run: never a per-session timer,
    // fiber, or queue.
    const urgent = new Set<string>()
    // How many queued entries each session currently owns. This is a derived
    // index of `pending`, not a new source of truth, and it introduces no new
    // scaling dimension: a session is present here only while it owns at least
    // one queued entry, and the key is removed at the moment its last entry
    // leaves the queue. Cardinality is therefore bounded by the queue's own
    // cap, so this cannot outlive MAX_PENDING entries or survive an opt-out.
    const pendingSessionCount = new Map<string, number>()
    let timer: Fiber.Fiber<void> | undefined
    let epoch = 0
    let resolved: Binary | undefined
    let freshnessRunning = false
    // The last freshness observation, so the hot path inside the four-hour
    // window is one in-memory comparison: no stat, no config read, no network.
    let lastCheck: ManagedState | undefined
    // Memoized credential presence, so a delivery window costs no filesystem
    // work. A user-invoked status refreshes it.
    let configCache: { readonly value: boolean; readonly at: number } | undefined
    // The scheduler window is delivering, not sleeping: its batch has already
    // left the queue, so nothing may interrupt it, and it still owns the single
    // scheduler slot for that whole period.
    let delivering = false
    // The earliest wake a record or a session request asked for while this
    // scheduler was delivering. One bounded scalar: a burst of sessions must not
    // become a burst of scheduler fibers, so requests are folded into O(1) state
    // and consumed by the single re-arm decision this scheduler makes when it ends.
    let wake: number | undefined

    // Explicit opt-in. An explicit env toggle wins; otherwise the Core-persisted
    // setting decides, and its default is disabled. Read once at build so a
    // heartbeat never stats the state directory.
    const loadSettings = Effect.fn("WakaTime.loadSettings")(function* () {
      const raw = yield* fs.readFileStringSafe(settingsFile()).pipe(Effect.orElseSucceed(() => undefined))
      if (raw === undefined) return DEFAULT_SETTINGS
      try {
        return parseSettings(JSON.parse(raw) as unknown)
      } catch {
        // Malformed state is indistinguishable from an absent opt-in: disabled.
        return DEFAULT_SETTINGS
      }
    })

    const saveSettings = Effect.fn("WakaTime.saveSettings")(function* (settings: Settings) {
      const normalized: Settings = { enabled: settings.enabled === true }
      const target = settingsFile()
      const content = `${JSON.stringify(normalized, null, 2)}\n`
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(`wakatime-settings:${target}`, { timeoutMs: WRITE_LOCK_TIMEOUT_MS })
          const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
          yield* fs.writeWithDirs(temporary, content, 0o600).pipe(
            Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)),
          )
          yield* fs.rename(temporary, target).pipe(Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)))
        }),
      )
      return normalized
    })

    const loadManagedState = Effect.fn("WakaTime.loadManagedState")(function* () {
      const raw = yield* fs.readFileStringSafe(cliStateFile()).pipe(Effect.orElseSucceed(() => undefined))
      if (raw === undefined) return DEFAULT_MANAGED_STATE
      try {
        return parseManagedState(JSON.parse(raw) as unknown)
      } catch {
        return DEFAULT_MANAGED_STATE
      }
    })

    /**
     * The single cross-process commit lock for everything about the managed CLI.
     *
     * There is deliberately no second lock: the binary swap and the state
     * publication must be one coherent transaction, and two independent locks
     * would permit exactly the interleaving this protocol exists to prevent. A
     * caller that nests this inside another lock is a bug, and the only other
     * lock in this module is the unrelated settings document's.
     */
    const updateLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(`wakatime-cli-update:${managedBinary()}`, { timeoutMs: UPDATE_LOCK_TIMEOUT_MS })
          return yield* effect
        }),
      )

    /**
     * Atomic state write, UNLOCKED. Only ever called while holding `updateLock`,
     * which is what makes the binary swap and this publication one transaction.
     * There is no locking wrapper because there is exactly one writer.
     */
    const writeManagedStateUnlocked = Effect.fnUntraced(function* (state: ManagedState) {
      const target = cliStateFile()
      const content = `${JSON.stringify(state, null, 2)}\n`
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
      yield* fs.writeWithDirs(temporary, content, 0o600).pipe(
        Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)),
      )
      yield* fs.rename(temporary, target).pipe(Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)))
    })

    let persisted = (yield* loadSettings()).enabled
    const optedIn = () => envToggle(process.env.OPENFORK_WAKATIME) ?? persisted

    // Authentication material only. This never implies the user asked to send.
    const configured = Effect.fn("WakaTime.configured")(function* () {
      if (process.env.WAKATIME_API_KEY?.trim()) return true
      return yield* fs.isFile(path.join(configHome(), ".wakatime.cfg")).pipe(Effect.orElseSucceed(() => false))
    })

    /**
     * Credential presence for the delivery path. It changes slowly while delivery
     * happens once per coalescing window, so probing the config file per delivery
     * group would stat ~/.wakatime.cfg on every window. This short TTL keeps a
     * delivery to O(1) in-memory work in the common case. Two escapes from the
     * cache exist on purpose: a newly provided key is pure process memory and is
     * seen immediately, and a user-invoked `status()` re-probes and writes the
     * answer back, so what a person just observed is what delivery next believes.
     */
    const configuredCached = () => {
      if (process.env.WAKATIME_API_KEY?.trim()) {
        configCache = { value: true, at: Date.now() }
        return Effect.succeed(true)
      }
      const now = Date.now()
      const cached = configCache
      if (cached !== undefined && now - cached.at < CONFIG_PROBE_TTL_MS) return Effect.succeed(cached.value)
      return configured().pipe(Effect.tap((value) => Effect.sync(() => (configCache = { value, at: now }))))
    }

    /** Delivery admission: cached credential state, never a per-record probe. */
    const deliverableCached = () =>
      Effect.gen(function* () {
        if (!optedIn()) return false
        return yield* configuredCached()
      })

    const isFile = (candidate: string) => fs.isFile(candidate).pipe(Effect.orElseSucceed(() => false))

    const fetchBytes = Effect.fn("WakaTime.fetchBytes")(function* (url: string) {
      const bytes = yield* HttpClientRequest.get(url).pipe(
        http.execute,
        // Bounded while streaming, not checked afterwards: a declared
        // Content-Length over the limit is rejected before the body is touched at
        // all, and an undeclared body fails the moment it crosses rather than
        // being buffered to the end first. The shared Core collector is reused
        // rather than reimplemented, and its result is a view over one
        // allocation, so there is no second full copy.
        Effect.flatMap((response) =>
          collectBoundedResponseBody(
            response,
            MAX_ARCHIVE_BYTES,
            () => new Error(`WakaTime download exceeded ${MAX_ARCHIVE_BYTES} bytes`),
          ),
        ),
        // Bounded around the whole request INCLUDING body consumption, so neither
        // a stalled connection nor a stalled body stream can hold the single
        // delivery permit and stop telemetry.
        Effect.timeout(MANAGED_HTTP_TIMEOUT),
        Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
      )
      if (bytes.byteLength === 0) return yield* Effect.fail(new Error(`Empty WakaTime download: ${url}`))
      return bytes
    })

    const fetchText = (url: string) => fetchBytes(url).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes)))

    /**
     * Put verified bytes in place of the managed binary.
     *
     * The write lands on a sibling temp file that is renamed over the target, so
     * a failure anywhere leaves the previously installed binary exactly as
     * usable as it was and never leaves a half-written one behind. Reporting
     * failure by return value, not by failing the effect, is what lets a failed
     * update stay invisible to the telemetry caller that triggered it.
     */
    const replaceManaged = Effect.fnUntraced(function* (binary: Uint8Array) {
      const target = managedBinary()
      const temporary = `${target}.${process.pid}.${randomUUID()}.new`
      // The caller already holds `updateLock`, which is what makes this swap and
      // the state publication one transaction against other processes. The write
      // lands on a sibling temp file and is renamed into place, so a failure
      // leaves the previously installed binary exactly as usable and never leaves
      // a half-written one.
      const result = yield* Effect.gen(function* () {
        yield* fs.writeWithDirs(temporary, binary, process.platform === "win32" ? undefined : 0o755)
        yield* fs.rename(temporary, target)
      }).pipe(Effect.exit)
      if (Exit.isSuccess(result)) return target
      yield* fs.remove(temporary).pipe(Effect.ignore)
      yield* Effect.logWarning("WakaTime managed CLI update failed; keeping the installed binary", {
        cause: result.cause,
      })
      return undefined
    })

    /**
     * Phase one, deliberately OUTSIDE every lock: read the exact release the
     * latest-release metadata names, then download and verify its assets pinned
     * to that tag. Both the checksum manifest and the archive are addressed by the
     * observed tag, so they always describe the same release even if a newer one
     * publishes mid-flight.
     *
     * Nothing is written and no lock is held, so a slow download never blocks a
     * peer process that is committing a newer release. The result is a candidate
     * that still has to win the compare-and-swap before it may be installed.
     */
    const fetchVerifiedCandidate = Effect.fn("WakaTime.fetchCandidate")(function* () {
      const release = parseLatestRelease(yield* fetchText(LATEST_RELEASE_URL))
      if (!release) return undefined
      const asset = platformAsset()
      if (!asset) return undefined
      const [manifestBytes, archive] = yield* Effect.all(
        [fetchBytes(releaseUrl(release.tag, "checksums_sha256.txt")), fetchBytes(releaseUrl(release.tag, asset.archive))],
        // Exactly two requests, issued together. The work is bounded and known;
        // an unbounded form would be a statement about nothing.
        { concurrency: 2 },
      )
      const binary = yield* Effect.try({
        try: () => verifyReleaseArchive(new TextDecoder().decode(manifestBytes), archive, asset),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      })
      return { release, binary }
    })

    /**
     * Look for a usable binary without any network access. Settings and CLI
     * surfaces call this so reading status never installs anything.
     */
    const probeBinary = Effect.fn("WakaTime.probeBinary")(function* () {
      const override = process.env.OPENFORK_WAKATIME_CLI?.trim()
      if (override) {
        const candidate = path.isAbsolute(override) ? override : which(override)
        if (candidate && (yield* isFile(candidate))) return { path: candidate, source: "override" } satisfies Binary
        return undefined
      }
      const system = which(managedName())
      if (system) return { path: system, source: "system" } satisfies Binary
      const target = managedBinary()
      if (yield* isFile(target)) return { path: target, source: "managed" } satisfies Binary
      return undefined
    })

    /**
     * Keep the managed CLI current without ever letting delivery depend on the
     * network.
     *
     * Precedence stays override > system > managed, and only the managed binary
     * is Core's to maintain: an operator's override and a system install are
     * returned untouched and never replaced. The check is bounded three times,
     * by an in-memory fast path, by persisted non-secret state that survives
     * restarts, and by an in-process in-flight guard. It runs only here, on the
     * delivery path that actually needs a binary, so inside the window a
     * delivery does no filesystem or network work at all. A failure is logged and
     * the previously resolved binary is returned, so a failed update never fails
     * the telemetry that triggered it.
     */
    /**
     * Phase two: the compare-and-swap commit.
     *
     * Everything that must be coherent across processes happens inside one
     * `updateLock` critical section: the state re-read, the binary swap, and the
     * state publication. The candidate itself was fetched and verified outside the
     * lock, so a slow download never blocks a peer — and, critically, a candidate
     * that a peer has already superseded is discarded rather than committed over
     * a newer install.
     */
    const commitCandidate = Effect.fn("WakaTime.commitCandidate")(function* (
      observed: ManagedState,
      candidate: { readonly release: LatestRelease; readonly binary: Uint8Array } | undefined,
      now: number,
      current: Binary | undefined,
    ) {
      return yield* updateLock(
        Effect.gen(function* () {
          // The compare. Re-read under the lock so a peer that committed while we
          // were downloading cannot be silently overwritten.
          const latest = yield* loadManagedState()
          if (supersededByPeer(observed, latest)) {
            // A peer's decision wins. Adopt whatever is installed now, which may
            // be a binary the peer just put in place, and do zero writes.
            lastCheck = latest
            const adopted = yield* probeBinary()
            if (adopted?.source === "managed") return { binary: adopted, superseded: true }
            return { binary: current, superseded: true }
          }
          if (!candidate) {
            // Nothing verifiable was obtained. The old binary stays, the attempt is
            // recorded, and the recorded version is left alone so a later check
            // retries.
            yield* writeManagedStateUnlocked({ checkedAt: now, version: observed.version })
            lastCheck = { checkedAt: now, version: observed.version }
            return { binary: current, superseded: false }
          }
          const version = candidate.release.version
          // An installed binary that already matches the observed release needs
          // only the recorded timestamp refreshed.
          if (current?.source === "managed" && observed.version === version) {
            yield* writeManagedStateUnlocked({ checkedAt: now, version })
            lastCheck = { checkedAt: now, version }
            return { binary: current, superseded: false }
          }
          const installed = yield* replaceManaged(candidate.binary)
          if (!installed) {
            yield* writeManagedStateUnlocked({ checkedAt: now, version: observed.version })
            lastCheck = { checkedAt: now, version: observed.version }
            return { binary: current, superseded: false }
          }
          // Swap and publication inside the same critical section: a reader can
          // never see a new binary with an old recorded version, or the reverse.
          yield* writeManagedStateUnlocked({ checkedAt: now, version })
          lastCheck = { checkedAt: now, version }
          return { binary: { path: installed, source: "managed" } satisfies Binary, superseded: false }
        }),
      )
    })

    /**
     * Record a spent attempt without clobbering a peer.
     *
     * Used when the check itself failed — an unreachable network, an unverified
     * archive, or a lock we could not take. The window is still consumed, but the
     * write happens only if the state is still the snapshot that justified the
     * check, so a process that got further is never rolled back to our failure.
     */
    const publishSpentAttempt = (observed: ManagedState, now: number) => {
      // The in-memory window is consumed FIRST and unconditionally. If the commit
      // lock is unavailable, persisting is skipped — but a process that cannot take
      // the lock must not turn every subsequent heartbeat into another GitHub
      // round trip, so the local backoff is what actually bounds the work.
      const spent: ManagedState = { checkedAt: now, version: observed.version }
      lastCheck = spent
      return updateLock(
        Effect.gen(function* () {
          const latest = yield* loadManagedState()
          if (supersededByPeer(observed, latest)) {
            lastCheck = latest
            return
          }
          yield* writeManagedStateUnlocked(spent)
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("WakaTime managed CLI freshness state was not published; backing off in memory only", {
            cause,
          }),
        ),
        Effect.ignore,
      )
    }

    const refreshManaged = Effect.fn("WakaTime.refreshManaged")(function* (current: Binary | undefined) {
      if (!platformAsset()) return current
      if (freshnessRunning) return current
      const now = yield* Clock.currentTimeMillis
      // In-memory fast path: inside the window a delivery costs one comparison and
      // touches neither the state directory nor the network. The persisted record
      // is the cross-process backstop, read only once this bound is spent.
      if (lastCheck !== undefined && !managedCheckDue(lastCheck, now)) return current
      // The snapshot that justifies this check, and the value the commit compares
      // against once the candidate is in hand.
      const observed = yield* loadManagedState()
      if (!managedCheckDue(observed, now)) {
        lastCheck = observed
        // Rare and off the hot path: a peer may have installed and published the
        // managed binary after our earlier probe found nothing. Adopt it now so
        // cross-process convergence is immediate, instead of failing this one
        // delivery for a binary that is already on disk.
        if (current === undefined) {
          const adopted = yield* probeBinary()
          if (adopted?.source === "managed") return adopted
        }
        return current
      }
      freshnessRunning = true
      const outcome = yield* Effect.gen(function* () {
        // Phase one, outside every lock: observe, download, verify.
        const fetched = yield* fetchVerifiedCandidate().pipe(Effect.exit)
        // Phase two, under the single commit lock: compare and commit.
        return yield* commitCandidate(observed, Exit.isSuccess(fetched) ? fetched.value : undefined, now, current)
      }).pipe(
        Effect.exit,
        Effect.ensuring(Effect.sync(() => (freshnessRunning = false))),
      )
      if (Exit.isFailure(outcome)) {
        yield* publishSpentAttempt(observed, now)
        yield* Effect.logWarning("WakaTime managed CLI freshness check failed; keeping the installed binary", {
          cause: outcome.cause,
        })
        return current
      }
      return outcome.value.binary
    })

    const resolveUncached = Effect.fn("WakaTime.resolveBinary")(function* () {
      const probed = yield* probeBinary()
      // Delivery is what triggers a managed freshness check, so status and
      // settings reads stay network-free.
      if (probed && probed.source !== "managed") return probed
      // This is also the initial-install path. With no binary to probe, a due
      // check installs the exact release the metadata named and records its
      // normalized version. With no readable release there is nothing to install
      // without pinning to a pointer that can move mid-flight, so resolution
      // fails here rather than guessing a release.
      const managed = yield* refreshManaged(probed)
      if (managed) return managed
      return yield* Effect.fail(
        new Error(`WakaTime managed CLI is unavailable: no installable release was observed at ${managedBinary()}`),
      )
    })

    /**
     * Only successful resolution is memoized. A failed download is a transient
     * condition, not a permanent answer, so the next heartbeat retries instead of
     * inheriting a poisoned cache entry for the life of the process.
     */
    const resolveBinary = () =>
      resolveGate.withPermit(
        Effect.suspend(() => {
          if (!resolved) {
            return resolveUncached().pipe(Effect.tap((binary) => Effect.sync(() => (resolved = binary))))
          }
          // Captured so the narrowed type survives into the branch below; the
          // memo itself stays mutable across deliveries.
          const settled = resolved
          // An override or a system install is the operator's own binary and is
          // never touched again. A managed binary stays eligible for its bounded
          // freshness check on every delivery, so a replacement is actually
          // observed instead of being memoized away for the life of the process.
          // Inside the window that check is one in-memory comparison: no state
          // read, no network.
          if (settled.source !== "managed") return Effect.succeed(settled)
          // A failed refresh hands back the same managed binary, so the memo
          // always ends up holding a usable value.
          return Effect.gen(function* () {
            const refreshed = yield* refreshManaged(settled)
            resolved = refreshed ?? settled
            return settled
          })
        }),
      )

    const send = Effect.fn("WakaTime.send")(function* (activities: readonly Activity[]) {
      // The one place credential state is consulted on the delivery path: once
      // per delivery attempt through the TTL cache, never once per observation.
      if (activities.length === 0 || !(yield* deliverableCached())) return
      const binary = yield* resolveBinary()
      const [first, ...rest] = activities
      if (!first) return
      const stdin = rest.length > 0 ? JSON.stringify(rest.map(extraHeartbeat)) + "\n" : undefined
      const command = ChildProcess.make(binary.path, heartbeatArgs(first, rest.length > 0), {
        extendEnv: true,
        ...(first.projectFolder ? { cwd: first.projectFolder } : {}),
      })
      const result = yield* app.run(command, {
        ...(stdin ? { stdin } : {}),
        timeout: SENTINEL_TIMEOUT,
        maxOutputBytes: 16 * 1024,
        maxErrorBytes: 32 * 1024,
      })
      if (result.exitCode !== 0) {
        yield* Effect.logWarning("WakaTime heartbeat command failed", {
          exitCode: result.exitCode,
          stderr: result.stderr.toString("utf8").slice(0, 2_000),
        })
      }
    })

    /**
     * Drop delivery windows that can no longer affect any decision, then enforce
     * the hard cap. An entry at least one limiter window old is indistinguishable
     * from a missing one, so pruning it changes no outcome. Walking the map only
     * once it is over the cap keeps the steady-state cost per stamp O(1).
     */
    const pruneWindows = (now: number) => {
      // Insertion order IS last-delivery order, because `openWindow` re-inserts
      // on every stamp. Only the head needs inspecting: the first fresh entry
      // ends the stale prefix, so this is an amortized O(1) walk rather than a
      // full-map scan, and expired windows are reclaimed even while the map is
      // still below the cap.
      for (;;) {
        const oldest = lastDelivery.keys().next().value as string | undefined
        if (oldest === undefined) return
        if (now - (lastDelivery.get(oldest) ?? now) < MIN_DELIVERY_INTERVAL_MS) break
        lastDelivery.delete(oldest)
      }
      while (lastDelivery.size > DELIVERY_PROJECT_BOUND) {
        const oldest = lastDelivery.keys().next().value as string | undefined
        if (oldest === undefined) return
        lastDelivery.delete(oldest)
      }
    }

    /**
     * Open (or refresh) one project's delivery window. Bounded in the dimension
     * that actually costs — the number of distinct projects this process has
     * delivered for — and never unbounded by unique folder names.
     */
    const openWindow = (scope: string) => {
      const at = Date.now()
      // Re-insert so insertion order stays least-recently-delivered first.
      lastDelivery.delete(scope)
      lastDelivery.set(scope, at)
      // Enforced AFTER insertion, so the bound is a true hard cap and the map
      // never transiently exceeds it: prune what can no longer affect a
      // decision, then evict the oldest windows until it fits.
      pruneWindows(at)
    }

    /**
     * Release the replay bookkeeping for one pending entry.
     *
     * `delivered` distinguishes two cases that otherwise look identical. A TAKEN
     * entry's work reached WakaTime, so its fingerprints must stay in the global
     * recent set to keep suppressing replays. An EVICTED entry was never
     * delivered — it was dropped only to keep the queue bounded — so every
     * authoritative reference it coalesced has to be forgotten, or a producer
     * replaying an older coalesced call could never recover that work.
     *
     * Bounded by construction: the loop is over that one entry's fingerprint set,
     * which cannot exceed the global replay bound, and no ordinary record path
     * calls this.
     */
    const releasePendingReplay = (key: string, delivered: boolean) => {
      const owned = pendingReplay.get(key)
      if (owned === undefined) return
      pendingReplay.delete(key)
      for (const fingerprint of owned) {
        replayOwner.delete(fingerprint)
        if (!delivered) seen.delete(fingerprint)
      }
      owned.clear()
    }

    /**
     * The session identity the pending index and the urgency bypass share.
     *
     * Both trim, so a request answers exactly one question — would this record
     * be accelerated for that session? — and a padded spelling cannot be a
     * second, differently-keyed copy of the same session. `takeForSession`
     * stays strict on the raw value; being narrower than the index can only
     * leave a marker set, which is the existing behavior.
     */
    const pendingSessionOf = (activity: Activity) => (activity.aiSession ?? "").trim()

    /**
     * Record that a NEW pending key was inserted for one session. Called only
     * on genuine insertion, so coalescing onto an existing key does not
     * double-count, and the totals stay equal to the queue's own size.
     */
    const claimPendingSession = (activity: Activity) => {
      const session = pendingSessionOf(activity)
      // The index exists only to answer a session-selective request, and a
      // record with no session is not attributable to one, so it occupies no
      // index state at all. Keeping those records out is what bounds the index
      // by the set of nameable sessions rather than by the whole queue.
      if (!session) return
      pendingSessionCount.set(session, (pendingSessionCount.get(session) ?? 0) + 1)
    }

    /**
     * Retire one pending key from the index. This is the single removal path,
     * so every exit from the queue decrements the owning session exactly once
     * and a session leaves the index exactly when its last entry does.
     */
    const releasePendingSession = (activity: Activity) => {
      const session = pendingSessionOf(activity)
      // Symmetric with `claimPendingSession`: a record that never claimed index
      // state has nothing to retire, and decrementing a shared blank bucket
      // would be worse than leaving it alone.
      if (!session) return
      const remaining = (pendingSessionCount.get(session) ?? 0) - 1
      if (remaining > 0) {
        pendingSessionCount.set(session, remaining)
        return
      }
      pendingSessionCount.delete(session)
    }

    /**
     * The one removal path for a queued entry.
     *
     * Deleting from `pending` has two consequences that must not be separable —
     * retiring the session the entry owned and releasing the replay
     * fingerprints it held — and a caller that did one without the other would
     * leave either a permanently-counted session or a queued entry still
     * suppressing a reference nothing can replay. So the entry's own activity is
     * read first, then both are settled from it in one place.
     */
    const dropPending = (key: string, delivered: boolean) => {
      const activity = pending.get(key)
      pending.delete(key)
      releasePendingReplay(key, delivered)
      if (activity === undefined) return
      releasePendingSession(activity)
    }

    const takeAll = Effect.sync(() => {
      const batch = [...pending.values()]
      for (const key of pending.keys()) releasePendingReplay(key, true)
      pending.clear()
      // The whole queue left at once, so the derived index is emptied with it
      // rather than walked entry by entry.
      pendingSessionCount.clear()
      // Urgency markers are consumed here too, and that is a semantic
      // requirement rather than tidiness: every marker names a session whose work
      // has just left the queue, so a marker surviving a full drain would make
      // the next legitimate immediate request for that session indistinguishable
      // from a duplicate — and that request would return without arming
      // anything, stranding the new work until the ordinary debounce. A full
      // drain therefore ends the urgency window together with the queue.
      urgent.clear()
      return batch
    })

    /**
     * Take only what the delivery limiter currently allows. A held record is
     * left in `pending` untouched, so throttling delays work instead of
     * discarding it. `heldUntil` is when the last held project becomes
     * deliverable, which is exactly when the window has to be re-armed.
     */
    const takeEligible = Effect.sync(() => {
      const now = Date.now()
      // Prune before reading: stale windows can no longer hold anything, and
      // this keeps the read itself bounded.
      pruneWindows(now)
      // Urgency markers are consumed by this run. An ordinary coding burst has
      // none, and that is the hot path, so it allocates nothing: the snapshot is
      // only taken when a session actually asked, and a session that requests
      // after this point waits for the next run rather than leaving a marker
      // accumulating behind it.
      const urgentNow = urgent.size > 0 ? new Set(urgent) : undefined
      if (urgentNow) urgent.clear()
      const ready: Activity[] = []
      let heldUntil = 0
      for (const [key, activity] of pending) {
        const last = lastDelivery.get(projectKey(activity))
        // A session that asked for prompt delivery is not held by the project
        // limiter. Everything else — including other sessions queued against
        // the same project — is still held and rescheduled, so accelerating one
        // session never costs another.
        const bypass = urgentNow !== undefined && urgentNow.has((activity.aiSession ?? "").trim())
        const remaining = last === undefined || bypass ? 0 : last + MIN_DELIVERY_INTERVAL_MS - now
        if (remaining > 0) {
          heldUntil = Math.max(heldUntil, remaining)
          continue
        }
        ready.push(activity)
        dropPending(key, true)
      }
      return { ready, heldUntil }
    })

    /** Take exactly one session's queued work; every other session stays queued. */
    const takeForSession = (sessionID: string) =>
      Effect.sync(() => {
        const session = sessionID.trim()
        // A blank selector names no session, and an observation carrying no
        // session is not attributable to one. Fail closed rather than guess.
        if (!session) return []
        const batch: Activity[] = []
        for (const [key, activity] of pending) {
          if (activity.aiSession !== session) continue
          batch.push(activity)
          dropPending(key, true)
        }
        return batch
      })

    /**
     * Deliver one batch and open the limiter window for the projects it touched.
     * The stamp lands before the spawn and applies to forced flushes too: the
     * window exists to bound how often a project can reach wakatime-cli, and a
     * forced flush is a reach.
     */
    const deliver = Effect.fnUntraced(function* (batch: readonly Activity[]) {
      if (batch.length === 0) return
      // Serialized on the delivery permit, not the queue lock. The timer, both
      // explicit flushes, and the finalizer can all reach delivery now that CLI
      // work happens outside the queue lock, and exactly one wakatime-cli
      // pipeline may be in flight at a time.
      yield* delivery.withPermit(
        Effect.gen(function* () {
          // One spawn per project. `--project-folder` and the child working
          // directory belong to the primary invocation and an extra heartbeat
          // inherits both, so a batch may never mix projects: one project's time
          // would otherwise be filed under another project's root.
          const groups = new Map<string, Activity[]>()
          for (const activity of batch) {
            const scope = projectKey(activity)
            const group = groups.get(scope)
            if (group) group.push(activity)
            else groups.set(scope, [activity])
          }
          // Strictly sequential: one CLI process at a time, so a batch spanning
          // many projects can never fan out into N concurrent spawns and the
          // foreground runtime keeps priority. A failure is contained to its own
          // group, so one project's delivery problem cannot cost the others.
          for (const [scope, group] of groups) {
            openWindow(scope)
            yield* send(group).pipe(
              Effect.catchCause((cause) => Effect.logWarning("WakaTime heartbeat delivery failed", { cause })),
            )
          }
        }),
      )
    })

    const cancelTimer = Effect.fnUntraced(function* () {
      epoch++
      const current = timer
      timer = undefined
      // A window that is still sleeping cancels freely: nothing has left the
      // queue. A window that has already begun delivering must not be cancelled:
      // its batch is out of the queue, so a later arm() may replace the window
      // but must never abandon work in flight. Interrupting it would silently
      // drop queued coding time.
      if (current && !delivering) yield* Fiber.interrupt(current)
    })

    // The window can re-arm itself when the limiter held work, so it is
    // declared before its own definition. Without the explicit return type
    // TypeScript cannot infer a self-referential initializer.
    /**
     * The single decision about when this scheduler runs again.
     *
     * Two independent reasons to wake: work the limiter is still holding, which
     * becomes deliverable at a known time, and a request that arrived while this
     * scheduler was delivering — a debounce for a new burst, or an urgent session
     * asking for prompt delivery. The earlier of the two wins, and a held deadline
     * is never pushed later merely because a record arrived: the new burst simply
     * coalesces and the held work stays held.
     */
    const decideNextDelay = (requested: number | undefined, heldUntil: number) => {
      const held = heldUntil > 0 ? heldUntil : undefined
      if (requested === undefined) return held
      if (held === undefined) return requested
      return Math.min(requested, held)
    }

    // The return type is declared because the window re-arms itself: without an
    // annotation TypeScript cannot infer a self-referential initializer.
    let armLocked!: (delayMs: number) => Effect.Effect<void, never, never>
    armLocked = Effect.fnUntraced(function* (delayMs: number) {
      const requested = Math.max(0, delayMs)
      // While this scheduler is delivering it still owns the single scheduler
      // slot. Cancelling or forking here would let a burst of sessions multiply
      // scheduler fibers, each of which could then take another batch and queue
      // behind the delivery permit. The request is therefore recorded as O(1)
      // state and folded into the one re-arm decision made when delivery ends.
      if (delivering) {
        wake = wake === undefined ? requested : Math.min(wake, requested)
        return
      }
      yield* cancelTimer()
      const ownedEpoch = epoch
      timer = yield* Effect.gen(function* () {
        yield* Effect.sleep(requested)
        const owns = yield* Effect.sync(() => ownedEpoch === epoch)
        if (!owns) return
        // The slot is deliberately NOT released here. This fiber keeps ownership
        // through its delivery, so a concurrent request cannot install a second
        // scheduler.
        const taken = yield* mutex.withPermit(
          Effect.gen(function* () {
            const slice = yield* takeEligible
            // The slice has left the queue, so from here this fiber owns work that
            // must be delivered. Marked under the same lock that removed it, so a
            // concurrent arm() observes the flag rather than a half-taken batch.
            if (slice.ready.length > 0) delivering = true
            return slice
          }),
        )
        yield* deliver(taken.ready).pipe(Effect.ensuring(Effect.sync(() => (delivering = false))))
        // Exactly one re-arm decision for everything that happened during this
        // run: the limiter's held deadline plus any request that arrived while
        // this scheduler was delivering.
        yield* mutex.withPermit(
          Effect.gen(function* () {
            if (epoch !== ownedEpoch) {
              // An explicit flush or teardown invalidated this scheduler while it
              // delivered. That already released the slot, so this fiber is done
              // and must not resurrect itself.
              return
            }
            if (timer !== undefined) timer = undefined
            delivering = false
            const requestedWake = wake
            wake = undefined
            const delay = decideNextDelay(requestedWake, taken.heldUntil)
            if (delay === undefined) return
            yield* armLocked(delay)
          }),
        )
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("WakaTime flush timer failed", { cause })),
        Effect.forkIn(processScope, { startImmediately: true }),
      )
    })

    const arm = (delayMs = DEBOUNCE_MS) => mutex.withPermit(armLocked(delayMs))

    const record: Interface["record"] = (input) =>
      Effect.gen(function* () {
        // Admission is the explicit opt-in alone, which is pure process memory.
        // The credential probe is deliberately NOT here: it stats
        // ~/.wakatime.cfg, and this runs on the producer hot path once per coding
        // observation. Delivery performs it once per coalesced batch, and a batch
        // that turns out to be unconfigured is dropped there rather than held in
        // an unbounded backlog waiting for credentials.
        if (!optedIn()) return
        const list = Array.isArray(input) ? input : [input]
        const accepted = yield* Effect.sync(() => {
          let count = 0
          for (const raw of list) {
            const entity = raw.entity.trim()
            if (!entity) continue
            // A blank folder names no directory, so it is normalized away here
            // rather than reaching the argv, the child working directory, or the
            // delivery limiter as an invented empty path.
            const folder = raw.projectFolder?.trim()
            const activity: Activity = { ...raw, entity, time: raw.time ?? Date.now(), projectFolder: folder }
            const key = activityKey(activity)

            // Replay suppression happens at enqueue, not at delivery, so a
            // producer that replays after its window already flushed is caught
            // too. Records without an authoritative reference are never
            // suppressed: there is no proof that they are the same event, and
            // dropping a legitimate repeat would lose real coding time.
            const fingerprint = replayKey(activity)
            if (fingerprint !== undefined) {
              if (seen.has(fingerprint)) continue
              seen.add(fingerprint)
              // This reference is now owned by the queued entry it coalesced
              // into, so evicting that entry can release it again. Ownership is
              // per pending key, not per merged activity, because one entry can
              // absorb several distinct authoritative calls before delivery.
              let owned = pendingReplay.get(key)
              if (owned === undefined) {
                owned = new Set<string>()
                pendingReplay.set(key, owned)
              }
              owned.add(fingerprint)
              replayOwner.set(fingerprint, key)
              // Bounded and deterministic: the oldest fingerprint leaves first, so
              // a long-running process degrades to "suppress the recent window"
              // instead of growing without limit.
              if (seen.size > REPLAY_DEDUPE_BOUND) {
                const oldest = seen.values().next().value as string | undefined
                if (oldest !== undefined) {
                  seen.delete(oldest)
                  // A fingerprint that just left the recent window must also stop
                  // claiming a queued entry, or that entry would own a
                  // reference nothing can suppress.
                  const owner = replayOwner.get(oldest)
                  if (owner !== undefined) {
                    replayOwner.delete(oldest)
                    const ownedByOwner = pendingReplay.get(owner)
                    if (ownedByOwner !== undefined) {
                      ownedByOwner.delete(oldest)
                      if (ownedByOwner.size === 0) pendingReplay.delete(owner)
                    }
                  }
                }
              }
            }

            const coalesced = pending.get(key)
            pending.set(key, mergeActivities(coalesced, activity))
            // Only a genuinely new key is a new queued entry, so only that
            // inserts into the pending-session index.
            if (coalesced === undefined) claimPendingSession(activity)
            if (pending.size <= MAX_PENDING) {
              count++
              continue
            }
            const oldest = pending.keys().next().value as string | undefined
            if (oldest !== undefined && oldest !== key) {
              // Dropped purely to keep the queue bounded, so it was never
              // delivered: every authoritative reference it coalesced is
              // forgotten and any of them can be replayed and recovered. The
              // evicted entry's session is retired with it, so a later Idle
              // request for that session cannot wake a scheduler for work that
              // no longer exists.
              dropPending(oldest, false)
            }
            count++
          }
          return count
        })
        // A batch that was entirely replayed must not restart the window.
        if (accepted > 0) yield* arm()
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("WakaTime activity enqueue failed", { cause })))

    const flush: Interface["flush"] = () =>
      Effect.gen(function* () {
        const batch = yield* mutex.withPermit(
          Effect.gen(function* () {
            yield* cancelTimer()
            return yield* takeAll
          }),
        )
        yield* deliver(batch)
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("WakaTime flush failed", { cause })))

    /**
     * The host-facing, non-blocking lifecycle call.
     *
     * Everything it does is O(1) process memory under the queue mutex: validate
     * the selector, consult the pending-session index, record a bounded urgency
     * marker, and re-arm the one existing scheduler for immediate execution. A
     * session with nothing queued returns in O(1) without mutating the marker
     * set or re-arming anything. It never resolves a binary, reads the
     * filesystem, touches the network, or spawns a process, and it never creates
     * a per-session fiber or timer — `arm` replaces the single scheduler rather
     * than adding one, so any number of concurrent session requests still cost
     * exactly one timer and one fiber.
     *
     * A repeat request for a session that is ALREADY urgent is free for the same
     * reason. The marker is recorded and the one scheduler is already armed or
     * delivering, so re-arming would only repeat a cancel and fork the first
     * request already performed — churn on the hottest lifecycle call the host
     * has, and a duplicate Idle event is exactly what produces it.
     */
    const requestFlushSession: Interface["requestFlushSession"] = (sessionID) =>
      Effect.gen(function* () {
        const session = sessionID.trim()
        // A blank selector names no session, and an observation carrying no
        // session is not attributable to one. Fail closed rather than guess.
        if (!session) return
        // One queue-mutex critical section owns both the bounded marker mutation
        // and the re-arm, so a marker can never be recorded against a window the
        // scheduler has already read past, and the two steps cannot interleave
        // with a concurrent record. `armLocked` is used directly rather than
        // `arm` so the permit is taken once, not twice.
        yield* mutex.withPermit(
          Effect.gen(function* () {
            // Nothing is queued for this exact session, so there is no marker to
            // make meaningful and no window to advance. Re-arming here would be
            // pure cost: it would pull every OTHER session's work forward out
            // of the debounce and limiter windows they were deliberately left
            // in, so an idle session's End call could accelerate an unrelated
            // session's delivery. O(1), no mutation, no scheduler work.
            if (!pendingSessionCount.has(session)) return
            // Already marked: the one scheduler is armed or delivering, so a
            // second request for the same session has nothing left to ask for.
            // Checked before any mutation or re-arm, so a duplicate is a true
            // no-op rather than a repeated cancel and fork.
            if (urgent.has(session)) return
            // Urgency is best-effort telemetry, so evicting the oldest marker is
            // an acceptable degradation and keeps the set hard-bounded.
            urgent.add(session)
            while (urgent.size > URGENT_SESSION_BOUND) {
              const oldest = urgent.values().next().value as string | undefined
              if (oldest === undefined) break
              urgent.delete(oldest)
            }
            // Re-arm the one existing scheduler, which may inspect all bounded
            // pending work. Non-urgent held projects stay held and rescheduled,
            // and no other session's work is cancelled or dropped.
            yield* armLocked(0)
          }),
        )
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("WakaTime session flush request failed", { cause })))

    /**
     * A session-selective flush deliberately leaves the shared debounce window
     * armed. Cancelling it would strand every other session's queued work with
     * nothing left to fire it.
     */
    const flushSession: Interface["flushSession"] = (sessionID) =>
      Effect.gen(function* () {
        const batch = yield* mutex.withPermit(takeForSession(sessionID))
        yield* deliver(batch)
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("WakaTime session flush failed", { cause })))

    /**
     * Drop every piece of runtime-only state once the EFFECTIVE opt-in is false.
     *
     * All of it is transient and unsent, so none of it may outlive the opt-in:
     * the single scheduler window, the queue, urgency markers, replay suppression,
     * and delivery windows. Replay suppression in particular has to be forgotten
     * together with the queue — an observation dropped because the user opted out
     * was never delivered, so after a re-enable it must be replayable rather than
     * permanently suppressed. Delivery windows go too, so a re-enabled exporter
     * does not inherit throttling from a period in which it sent nothing.
     *
     * Process memory only. The settings document was already written outside the
     * lock, and no CLI, network, or filesystem work happens here.
     */
    const clearTransientState = Effect.fnUntraced(function* () {
      yield* cancelTimer()
      yield* takeAll
      urgent.clear()
      seen.clear()
      for (const owned of pendingReplay.values()) owned.clear()
      pendingReplay.clear()
      replayOwner.clear()
      lastDelivery.clear()
    })

    const setEnabled: Interface["setEnabled"] = (next) =>
      Effect.gen(function* () {
        const saved = yield* saveSettings({ enabled: next })
        yield* mutex.withPermit(
          Effect.gen(function* () {
            persisted = saved.enabled
            // The EFFECTIVE opt-in decides, not the persisted checkbox: an
            // explicit env override outranks the persisted value, so clearing on
            // `!saved.enabled` would discard queued work while the exporter is
            // still switched on — and would keep the runtime sending while the
            // user has it switched off.
            if (!optedIn()) yield* clearTransientState()
          }),
        )
        return yield* status()
      })

    const status: Interface["status"] = () =>
      Effect.gen(function* () {
        // A status read is a person asking, so it re-probes rather than trusting
        // the delivery cache — and writes the answer back, so an explicit status
        // is immediately what the next delivery believes.
        const present = yield* configured()
        configCache = { value: present, at: Date.now() }
        if (!optedIn()) return { enabled: false, configured: present } satisfies Status
        if (!present) return { enabled: true, configured: false } satisfies Status
        // Report a binary that is already resolved, else probe the filesystem.
        // Never `resolveBinary`: a status read must not download or install.
        const binary = resolved ?? (yield* probeBinary())
        if (!binary) return { enabled: true, configured: true } satisfies Status
        return {
          enabled: true,
          configured: true,
          cli: binary.path,
          source: binary.source,
        } satisfies Status
      })

    // Build the exporter before subscribing so the consumer, the queue, and the
    // teardown finalizer all exist by the time the fork does.
    const service: Interface = { record, flush, flushSession, requestFlushSession, status, setEnabled }

    // The single CodingActivity consumer. It runs in the process scope so a
    // closed runtime graph cannot leave the bus without its only exporter, and a
    // second graph cannot fork a second subscriber. `startImmediately` is
    // required: a deferred fork would let the first heartbeats publish into a
    // bus with no established subscriber and be dropped.
    yield* coding.stream().pipe(
      Stream.runForEach((activity) => record(fromCodingActivity(activity))),
      Effect.catchCause((cause) => Effect.logWarning("WakaTime CodingActivity consumer stopped", { cause })),
      Effect.forkIn(processScope, { startImmediately: true }),
    )

    return {
      interface: service,
      scope: processScope,
      leases: 0,
      // Deliberate teardown, not a detached leak: cancel the pending window,
      // make one bounded attempt at what is already queued, then close the
      // process scope, which interrupts the consumer and any live debounce fiber.
      finalize: Effect.gen(function* () {
        // Teardown is an explicit, forced flush: the limiter must not get to
        // decide that a closing process's last queued time is not worth sending.
        // Taken under the lock, delivered outside it, bounded in time.
        const batch = yield* mutex.withPermit(
          Effect.gen(function* () {
            yield* cancelTimer()
            return yield* takeAll
          }),
        )
        yield* deliver(batch).pipe(Effect.timeout(SHUTDOWN_FLUSH_TIMEOUT), Effect.ignore)
        yield* Scope.close(processScope, Exit.void).pipe(Effect.ignore)
      }),
    } satisfies ProcessRuntime
  })

/**
 * One lease per graph build. Creation, reuse, and teardown share the same
 * critical section, so two graphs built concurrently cannot both install a
 * runtime and cannot both observe a half-built one. A build that fails never
 * publishes `canonical`, so the next graph retries instead of inheriting a
 * poisoned placeholder.
 */
const acquire = gate.withPermit(
  Effect.gen(function* () {
    const existing = canonical
    if (existing) {
      existing.leases++
      return existing
    }
    const runtime = yield* buildRuntime()
    runtime.leases = 1
    canonical = runtime
    return runtime
  }),
)

const release = (runtime: ProcessRuntime) =>
  gate
    .withPermit(
      Effect.gen(function* () {
        if (runtime.leases > 0) runtime.leases--
        // A newer runtime may already own `canonical`; never tear that one down.
        if (runtime.leases > 0 || canonical !== runtime) return
        canonical = undefined
        yield* runtime.finalize
      }),
    )
    .pipe(Effect.catchCause((cause) => Effect.logWarning("WakaTime runtime release failed", { cause })))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // A graph takes a lease on the process runtime; it never owns it.
    const runtime = yield* acquire
    yield* Effect.addFinalizer(() => release(runtime))
    return Service.of(runtime.interface)
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, AppProcess.node, CodingActivity.node, httpClient],
})
