export type SidecarOxpGrant = {
  read: boolean
  write: boolean
  process: boolean
  git: boolean
  integrations: boolean
  browser: boolean
  filesReceive: boolean
  filesSend: boolean
  automation: boolean
  sessionSupervision: "none" | "approved-roots"
  requestSupervision: boolean
  delegation: "disabled" | "spawn"
  nestedDelegation: boolean
}

export type SidecarLegacyImport = {
  roots: Array<{ path: string; alias?: string }>
  grant: Partial<SidecarOxpGrant>
}

export type SidecarOxpState = {
  version: 1
  enabled: boolean
  connector: { id: string; label: string }
  configRevision: number
  roots: Array<{ id: string; alias: string; path: string; available: boolean; managedByProject: boolean }>
  grant: SidecarOxpGrant
  endpoint: {
    state: "stopped" | "ready" | "error"
    generation?: number
    schemaFingerprint?: string
    /** Privileged sidecar -> Electron main only. */
    url?: string
    /** Privileged sidecar -> Electron main only. */
    metadataUrl?: string
    detail?: string
  }
  metrics: {
    lastRequestAt?: number
    lastOperationAt?: number
    calls: number
    failures: number
    augmentationCalls: number
    supervisionCalls: number
    delegationCalls: number
    parentEpochs: number
    parentEpochReminders: number
    unattributedParentCalls: number
    trackedParents: number
  }
}

export type OxpSidecarRequest =
  | { action: "get-state" }
  | { action: "start" }
  | { action: "stop" }
  | { action: "revoke" }
  | { action: "set-enabled"; enabled: boolean }
  | { action: "set-grant"; patch: Partial<SidecarOxpGrant> }
  | { action: "approve-root"; path: string; alias?: string }
  | { action: "sync-project-roots"; paths: string[] }
  | { action: "rename-root"; rootID: string; alias: string }
  | { action: "remove-root"; rootID: string }
  | { action: "set-openai-api-key"; value?: string }
  | { action: "import-legacy-config"; plan: SidecarLegacyImport }

export type SidecarCommand =
  | {
      type: "start"
      hostname: string
      port: number
      password: string
      userDataPath: string
    }
  | { type: "stop" }
  | { type: "oxp-request"; id: number; request: OxpSidecarRequest }

export type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }
  | { type: "oxp-state"; state: SidecarOxpState }
  | { type: "oxp-response"; id: number; ok: true; state: SidecarOxpState }
  | { type: "oxp-response"; id: number; ok: false; error: { message: string; code?: string } }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isBoundedString = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === "string" && value.length <= max && (allowEmpty || value.length > 0)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ROOT_ALIAS = /^[a-z0-9][a-z0-9._-]{0,31}$/
const SCHEMA_FINGERPRINT = /^[a-f0-9]{64}$/




function parsePrivilegedEndpointUrl(value: unknown, metadata = false) {
  if (!isBoundedString(value, 8192)) return
  try {
    const url = new URL(value)
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) return
    const prefix = metadata ? "/.well-known/oauth-protected-resource/mcp/" : "/mcp/"
    if (!url.pathname.startsWith(prefix)) return
    const token = url.pathname.slice(prefix.length)
    // randomBytes(32).toString("base64url") is exactly 43 URL-safe chars.
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return
    return { origin: url.origin, token }
  } catch {
    return
  }
}

const grantKeys = new Set<keyof SidecarOxpGrant>([
  "read",
  "write",
  "process",
  "git",
  "integrations",
  "browser",
  "filesReceive",
  "filesSend",
  "automation",
  "sessionSupervision",
  "requestSupervision",
  "delegation",
  "nestedDelegation",
])

function isGrantValue(key: keyof SidecarOxpGrant, value: unknown) {
  if (key === "sessionSupervision") return value === "none" || value === "approved-roots"
  if (key === "delegation") return value === "disabled" || value === "spawn"
  return typeof value === "boolean"
}

export function parseSidecarGrantPatch(value: unknown): Partial<SidecarOxpGrant> | undefined {
  if (!isRecord(value)) return
  const patch: Partial<SidecarOxpGrant> = {}
  for (const [rawKey, item] of Object.entries(value)) {
    const key = rawKey as keyof SidecarOxpGrant
    if (!grantKeys.has(key) || !isGrantValue(key, item)) return
    Object.assign(patch, { [key]: item })
  }
  return patch
}

export function parseSidecarLegacyImport(value: unknown): SidecarLegacyImport | undefined {
  if (!isRecord(value) || !Array.isArray(value.roots) || value.roots.length > 64) return
  const roots: SidecarLegacyImport["roots"] = []
  for (const item of value.roots) {
    if (!isRecord(item) || !isBoundedString(item.path, 4096)) return
    let alias: string | undefined
    if (item.alias !== undefined) {
      if (!isBoundedString(item.alias, 64)) return
      alias = item.alias
    }
    if (Object.keys(item).some((key) => key !== "path" && key !== "alias")) return
    roots.push({
      path: item.path,
      ...(alias === undefined ? {} : { alias }),
    })
  }
  const grant = parseSidecarGrantPatch(value.grant)
  if (!grant) return
  if (Object.keys(value).some((key) => key !== "roots" && key !== "grant")) return
  return { roots, grant }
}

export function isSidecarOxpGrant(value: unknown): value is SidecarOxpGrant {
  if (!isRecord(value) || Object.keys(value).length !== grantKeys.size) return false
  return [...grantKeys].every((key) => key in value && isGrantValue(key, value[key]))
}

export function isSidecarOxpState(value: unknown): value is SidecarOxpState {
  if (!isRecord(value) || value.version !== 1 || typeof value.enabled !== "boolean") return false
  if (
    !isRecord(value.connector) ||
    !isBoundedString(value.connector.id, 36) ||
    !UUID.test(value.connector.id) ||
    !isBoundedString(value.connector.label, 80)
  ) return false
  if (!Number.isSafeInteger(value.configRevision) || Number(value.configRevision) < 1) return false
  if (!Array.isArray(value.roots) || value.roots.length > 256) return false
  for (const root of value.roots) {
    if (!isRecord(root)) return false
    if (
      !isBoundedString(root.id, 36) ||
      !UUID.test(root.id) ||
      !isBoundedString(root.alias, 32) ||
      !ROOT_ALIAS.test(root.alias) ||
      !isBoundedString(root.path, 4096)
    ) return false
    if (typeof root.available !== "boolean" || typeof root.managedByProject !== "boolean") return false
  }
  if (!isSidecarOxpGrant(value.grant)) return false
  if (!isRecord(value.endpoint) || !["stopped", "ready", "error"].includes(String(value.endpoint.state))) return false
  if (value.endpoint.generation !== undefined && (!Number.isSafeInteger(value.endpoint.generation) || Number(value.endpoint.generation) < 1)) return false
  if (
    value.endpoint.schemaFingerprint !== undefined &&
    (!isBoundedString(value.endpoint.schemaFingerprint, 64) || !SCHEMA_FINGERPRINT.test(value.endpoint.schemaFingerprint))
  ) return false
  const endpointUrl = value.endpoint.url === undefined ? undefined : parsePrivilegedEndpointUrl(value.endpoint.url)
  const metadataUrl = value.endpoint.metadataUrl === undefined ? undefined : parsePrivilegedEndpointUrl(value.endpoint.metadataUrl, true)
  if (value.endpoint.url !== undefined && !endpointUrl) return false
  if (value.endpoint.metadataUrl !== undefined && !metadataUrl) return false
  if (value.endpoint.state === "ready") {
    if (!endpointUrl || !metadataUrl || endpointUrl.origin !== metadataUrl.origin || endpointUrl.token !== metadataUrl.token) return false
    if (value.endpoint.generation === undefined || value.endpoint.schemaFingerprint === undefined) return false
  } else if (
    value.endpoint.url !== undefined ||
    value.endpoint.metadataUrl !== undefined ||
    value.endpoint.schemaFingerprint !== undefined
  ) {
    return false
  }
  if (value.endpoint.detail !== undefined && !isBoundedString(value.endpoint.detail, 2048, true)) return false
  if (!isRecord(value.metrics)) return false
  for (const key of [
    "calls",
    "failures",
    "augmentationCalls",
    "supervisionCalls",
    "delegationCalls",
    "parentEpochs",
    "parentEpochReminders",
    "unattributedParentCalls",
    "trackedParents",
  ] as const) {
    const metric = value.metrics[key]
    if (!Number.isSafeInteger(metric) || Number(metric) < 0) return false
  }
  for (const key of ["lastRequestAt", "lastOperationAt"] as const) {
    const metric = value.metrics[key]
    if (metric !== undefined && (!Number.isFinite(metric) || Number(metric) < 0)) return false
  }
  return true
}

export function parseSidecarCommand(value: unknown): SidecarCommand | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return
  if (value.type === "stop") return { type: "stop" }
  if (value.type === "start") {
    if (!isBoundedString(value.hostname, 255) || !Number.isSafeInteger(value.port) || Number(value.port) < 0 || Number(value.port) > 65535) return
    if (!isBoundedString(value.password, 16 * 1024, true) || !isBoundedString(value.userDataPath, 4096)) return
    return {
      type: "start",
      hostname: value.hostname,
      port: Number(value.port),
      password: value.password,
      userDataPath: value.userDataPath,
    }
  }
  if (value.type !== "oxp-request" || !Number.isSafeInteger(value.id) || Number(value.id) < 1 || !isRecord(value.request)) return
  const request = value.request
  switch (request.action) {
    case "get-state":
    case "start":
    case "stop":
    case "revoke":
      return { type: "oxp-request", id: value.id as number, request: { action: request.action } }
    case "set-enabled":
      if (typeof request.enabled !== "boolean") return
      return { type: "oxp-request", id: value.id as number, request: { action: request.action, enabled: request.enabled } }
    case "set-grant":
      {
        const patch = parseSidecarGrantPatch(request.patch)
        if (!patch) return
        return { type: "oxp-request", id: value.id as number, request: { action: request.action, patch } }
      }
    case "approve-root":
      {
        if (!isBoundedString(request.path, 4096)) return
        let alias: string | undefined
        if (request.alias !== undefined) {
          if (!isBoundedString(request.alias, 64)) return
          alias = request.alias
        }
        return {
          type: "oxp-request",
          id: value.id as number,
          request: { action: request.action, path: request.path, ...(alias ? { alias } : {}) },
        }
      }
    case "sync-project-roots":
      if (
        !Array.isArray(request.paths) ||
        request.paths.length > 256 ||
        !request.paths.every((item) => isBoundedString(item, 4096))
      ) return
      return {
        type: "oxp-request",
        id: value.id as number,
        request: { action: request.action, paths: [...request.paths] },
      }
    case "rename-root":
      if (!isBoundedString(request.rootID, 128) || !isBoundedString(request.alias, 64)) return
      return { type: "oxp-request", id: value.id as number, request: { action: request.action, rootID: request.rootID, alias: request.alias } }
    case "remove-root":
      if (!isBoundedString(request.rootID, 128)) return
      return { type: "oxp-request", id: value.id as number, request: { action: request.action, rootID: request.rootID } }
    case "set-openai-api-key":
      {
        let apiKey: string | undefined
        if (request.value !== undefined) {
          if (!isBoundedString(request.value, 16 * 1024)) return
          apiKey = request.value
        }
        return {
          type: "oxp-request",
          id: value.id as number,
          request: {
            action: request.action,
            ...(apiKey === undefined ? {} : { value: apiKey }),
          },
        }
      }
    case "import-legacy-config":
      {
        const plan = parseSidecarLegacyImport(request.plan)
        if (!plan) return
        return { type: "oxp-request", id: value.id as number, request: { action: request.action, plan } }
      }
    default:
      return
  }
}

export function isSidecarMessage(value: unknown): value is SidecarMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false
  if (value.type === "ready" || value.type === "stopped") return true
  if (value.type === "error") {
    return isRecord(value.error) && isBoundedString(value.error.message, 4096, true) && (value.error.stack === undefined || isBoundedString(value.error.stack, 64 * 1024, true))
  }
  if (value.type === "oxp-state") return isSidecarOxpState(value.state)
  if (value.type !== "oxp-response" || !Number.isSafeInteger(value.id) || Number(value.id) < 1 || typeof value.ok !== "boolean") return false
  if (value.ok) return isSidecarOxpState(value.state)
  return isRecord(value.error) && isBoundedString(value.error.message, 4096, true) && (value.error.code === undefined || isBoundedString(value.error.code, 128, true))
}
