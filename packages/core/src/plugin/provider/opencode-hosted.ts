import path from "node:path"
import { Duration, Effect, Schedule, Semaphore } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { FSUtil } from "../../fs-util"
import { Global } from "../../global"
import { Flock } from "../../util/flock"

export const HOSTED_MODELS_URL = "https://opencode.ai/zen/v1/models"
const CACHE_VERSION = 1
const TTL_MS = Duration.toMillis(Duration.minutes(5))
const STALE_GRACE_MS = Duration.toMillis(Duration.hours(6))
const MAX_MODELS = 2_048
const MAX_ID_LENGTH = 256
const CACHE_FILE = path.join(Global.Path.cache, "opencode-hosted-models.json")
const LOCK_DIR = path.join(Global.Path.cache, ".locks")
const LOCK_KEY = `opencode-hosted-models:${CACHE_FILE}`

type Snapshot = {
  readonly fetchedAt: number
  readonly ids: ReadonlySet<string>
}

export type HostedCatalog =
  | { readonly state: "fresh"; readonly fetchedAt: number; readonly ids: ReadonlySet<string> }
  | { readonly state: "stale"; readonly fetchedAt: number; readonly ids: ReadonlySet<string> }
  | { readonly state: "expired"; readonly fetchedAt: number; readonly ids: ReadonlySet<string> }
  | { readonly state: "unavailable"; readonly ids: ReadonlySet<string> }

let snapshot: Snapshot | undefined
let diskLoaded = false
const refreshGate = Semaphore.makeUnsafe(1)

const emptyIDs = () => new Set<string>() as ReadonlySet<string>

function validModelID(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    !/[\s\x00-\x1f\x7f]/.test(value)
  )
}

export function decodeHostedModels(value: unknown): ReadonlySet<string> {
  if (typeof value !== "object" || value === null || !("data" in value)) throw new Error("missing hosted model data")
  const data = (value as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0 || data.length > MAX_MODELS) {
    throw new Error("invalid hosted model list")
  }

  const ids = new Set<string>()
  for (const item of data) {
    if (typeof item !== "object" || item === null || !("id" in item) || !validModelID((item as { id?: unknown }).id)) {
      throw new Error("invalid hosted model id")
    }
    ids.add((item as { id: string }).id)
  }
  if (ids.size === 0) throw new Error("empty hosted model list")
  return ids
}

function classify(value: Snapshot | undefined, now = Date.now()): HostedCatalog {
  if (!value) return { state: "unavailable", ids: emptyIDs() }
  const age = Math.max(0, now - value.fetchedAt)
  if (age <= TTL_MS) return { state: "fresh", fetchedAt: value.fetchedAt, ids: value.ids }
  if (age <= STALE_GRACE_MS) return { state: "stale", fetchedAt: value.fetchedAt, ids: value.ids }
  return { state: "expired", fetchedAt: value.fetchedAt, ids: value.ids }
}

export function currentHostedCatalog(now = Date.now()): HostedCatalog {
  return classify(snapshot, now)
}

export function isHostedPublicModel(
  input: { readonly id: string; readonly apiID: string },
  catalog = currentHostedCatalog(),
) {
  if (catalog.state !== "fresh" && catalog.state !== "stale") return false
  return catalog.ids.has(input.apiID) || catalog.ids.has(input.id)
}

function decodeStored(value: unknown): Snapshot | undefined {
  if (typeof value !== "object" || value === null) return
  const stored = value as { version?: unknown; fetchedAt?: unknown; ids?: unknown }
  if (stored.version !== CACHE_VERSION) return
  if (typeof stored.fetchedAt !== "number" || !Number.isFinite(stored.fetchedAt) || stored.fetchedAt < 0) return
  if (stored.fetchedAt > Date.now()) return
  if (!Array.isArray(stored.ids) || stored.ids.length === 0 || stored.ids.length > MAX_MODELS) return
  if (!stored.ids.every(validModelID)) return
  return { fetchedAt: stored.fetchedAt, ids: new Set(stored.ids) }
}

const readStored = (fs: FSUtil.Interface) =>
  fs.readJson(CACHE_FILE).pipe(
    Effect.map(decodeStored),
    Effect.catch(() => Effect.succeed(undefined)),
  )

const writeStored = (fs: FSUtil.Interface, value: Snapshot) =>
  Effect.gen(function* () {
    const tempfile = `${CACHE_FILE}.${process.pid}.${Date.now()}.tmp`
    yield* fs.writeWithDirs(
      tempfile,
      JSON.stringify({ version: CACHE_VERSION, fetchedAt: value.fetchedAt, ids: [...value.ids] }),
    )
    yield* fs.rename(tempfile, CACHE_FILE).pipe(
      Effect.retry({ times: 8, schedule: Schedule.spaced("20 millis") }),
      Effect.catch((cause) =>
        fs.remove(tempfile, { force: true }).pipe(Effect.ignore, Effect.andThen(Effect.fail(cause))),
      ),
    )
  })

const fetchHosted = (http: HttpClient.HttpClient) =>
  HttpClientRequest.get(HOSTED_MODELS_URL).pipe(
    HttpClientRequest.acceptJson,
    HttpClient.filterStatusOk(http).execute,
    Effect.flatMap((response) => response.text),
    Effect.timeout("3 seconds"),
    Effect.flatMap((text) =>
      Effect.try({
        try: () => decodeHostedModels(JSON.parse(text)),
        catch: (cause) => cause,
      }),
    ),
  )

function newer(value: Snapshot | undefined) {
  if (!value) return
  if (!snapshot || value.fetchedAt > snapshot.fetchedAt) snapshot = value
}

export const refreshHostedCatalog = Effect.fn("OpencodeHosted.refresh")(function* (
  http: HttpClient.HttpClient,
  fs: FSUtil.Interface,
  force = false,
) {
  return yield* refreshGate.withPermit(
    Effect.gen(function* () {
      if (!diskLoaded) {
        diskLoaded = true
        newer(yield* readStored(fs))
      }

      const before = currentHostedCatalog()
      if (!force && before.state === "fresh") return before

      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(LOCK_KEY, { dir: LOCK_DIR, timeoutMs: 5_000 })

          // Another process may have refreshed while we waited.
          newer(yield* readStored(fs))
          const locked = currentHostedCatalog()
          if (!force && locked.state === "fresh") return locked

          const ids = yield* fetchHosted(http)
          const next: Snapshot = { fetchedAt: Date.now(), ids }
          snapshot = next
          yield* writeStored(fs, next).pipe(Effect.ignore)
          return currentHostedCatalog()
        }),
      ).pipe(
        Effect.catch(() => Effect.succeed(currentHostedCatalog())),
      )
    }),
  )
})

/** Test-only process-global override. */
export function setHostedCatalogForTest(ids: readonly string[], fetchedAt = Date.now()) {
  snapshot = { fetchedAt, ids: new Set(ids) }
  diskLoaded = true
}

/** Test-only reset for Bun's shared module process. */
export function resetHostedCatalogForTest() {
  snapshot = undefined
  diskLoaded = false
}
