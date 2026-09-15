export interface SnapshotLocator {
  type: "css" | "text" | "role" | "testid" | "xpath" | "placeholder" | "label" | "name"
  value: string
  exact?: boolean
}

export interface SnapshotRefRecord {
  x: number
  y: number
  selector: string
  locator?: SnapshotLocator
}

export interface SnapshotRefState {
  version: number
  refs: Record<string, SnapshotRefRecord>
}

export interface SnapshotElementLike {
  ref?: unknown
  center?: { x?: unknown; y?: unknown }
  selector?: { value?: unknown }
  locator?: unknown
}

export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove?(key: string): Promise<void>
}

const KEY_PREFIX = "opencode:snapshot-refs:"

/**
 * Versioned, session-lifetime snapshot bindings for the Chrome lane.
 *
 * `chrome.storage.session` survives MV3 service-worker suspension but is
 * cleared with the browser session. That is exactly the desired lifetime for
 * snapshot refs: a worker restart must not silently invalidate valid refs, but
 * a browser restart must force a fresh snapshot.
 */
export class SnapshotRefRegistry {
  private readonly cache = new Map<number, SnapshotRefState>()
  private sequence = 0

  constructor(
    private readonly storage?: StorageAreaLike,
    private readonly now: () => number = Date.now,
  ) {}

  async replace(tabId: number, elements: readonly SnapshotElementLike[]): Promise<SnapshotRefState> {
    const previous = await this.get(tabId)
    const candidate = this.now() * 1_000 + (this.sequence++ % 1_000)
    const version = Math.max(candidate, (previous?.version ?? 0) + 1)
    const refs: Record<string, SnapshotRefRecord> = {}

    for (const element of elements) {
      if (typeof element.ref !== "string" || !element.ref) continue
      const x = Number(element.center?.x)
      const y = Number(element.center?.y)
      const selector = element.selector?.value
      if (!Number.isFinite(x) || !Number.isFinite(y) || typeof selector !== "string" || !selector) continue
      refs[element.ref] = {
        x: Math.round(x),
        y: Math.round(y),
        selector,
        ...(isLocator(element.locator) ? { locator: element.locator } : {}),
      }
    }

    const state = { version, refs }
    this.cache.set(tabId, state)
    await this.storage?.set({ [key(tabId)]: state })
    return state
  }

  async get(tabId: number): Promise<SnapshotRefState | undefined> {
    const cached = this.cache.get(tabId)
    if (cached) return cached
    if (!this.storage) return undefined
    const stored = (await this.storage.get(key(tabId)))[key(tabId)]
    if (!isState(stored)) return undefined
    this.cache.set(tabId, stored)
    return stored
  }

  async clear(tabId: number): Promise<void> {
    this.cache.delete(tabId)
    await this.storage?.remove?.(key(tabId))
  }
}

const key = (tabId: number) => `${KEY_PREFIX}${tabId}`

const isLocator = (value: unknown): value is SnapshotLocator => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.value === "string" &&
    ["css", "text", "role", "testid", "xpath", "placeholder", "label", "name"].includes(String(candidate.type)) &&
    (candidate.exact === undefined || typeof candidate.exact === "boolean")
}

const isState = (value: unknown): value is SnapshotRefState => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (!Number.isSafeInteger(candidate.version) || Number(candidate.version) < 1) return false
  if (!candidate.refs || typeof candidate.refs !== "object" || Array.isArray(candidate.refs)) return false
  for (const ref of Object.values(candidate.refs as Record<string, unknown>)) {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) return false
    const record = ref as Record<string, unknown>
    if (!Number.isFinite(record.x) || !Number.isFinite(record.y) || typeof record.selector !== "string" || !record.selector) return false
    if (record.locator !== undefined && !isLocator(record.locator)) return false
  }
  return true
}
