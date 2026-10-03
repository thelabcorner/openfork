import { Effect, Layer, ManagedRuntime } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { OxpConfig } from "./config"
import { OxpAgentCatalog } from "./agent-catalog"
import { OxpAgentCatalogV1 } from "./agent-catalog-v1"
import { OxpModelCatalog } from "./model-catalog"
import { OxpModelCatalogV1 } from "./model-catalog-v1"
import { OxpError } from "./error"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"
import { OxpServer } from "./server"
import { OxpRequestControl } from "./request-control"
import { OxpRequestControlV1 } from "./request-control-v1"
import { OxpSessionControl } from "./session-control"
import { OxpSessionControlV1 } from "./session-control-v1"
import { OxpWorkerControl } from "./worker-control"
import { OxpWorkerControlV1 } from "./worker-control-v1"
import { OxpMcpControl } from "./mcp-control"
import { OxpMcpControlV1 } from "./mcp-control-v1"
import { OxpSystemOneControl } from "./system-one-control"
import { OxpSystemOneControlV1 } from "./system-one-control-v1"

export interface EndpointDescriptor {
  readonly generation: number
  readonly url: string
  readonly metadataUrl: string
  readonly schemaFingerprint: string
}

export interface TrustedRootState {
  readonly id: OxpSchema.RootID
  readonly alias: OxpSchema.RootAlias
  readonly path: string
  readonly available: boolean
  readonly managedByProject: boolean
}

export interface WorkerAgentCatalog {
  readonly rootID: OxpSchema.RootID
  readonly rootAlias: OxpSchema.RootAlias
  readonly agents: readonly OxpAgentCatalog.Agent[]
  readonly nativeDefaultAgent: string
}

export interface TrustedState {
  readonly version: 1
  readonly enabled: boolean
  readonly connector: OxpSchema.Connector
  readonly configRevision: number
  readonly roots: readonly TrustedRootState[]
  readonly grant: OxpSchema.Grant
  readonly workerPolicy: OxpSchema.WorkerPolicy
  readonly endpoint: {
    readonly state: "stopped" | "ready" | "error"
    readonly generation?: number
    readonly schemaFingerprint?: string
    /** Privileged sidecar/main field. Never project this into renderer state. */
    readonly url?: string
    /** Privileged sidecar/main field. Never project this into renderer state. */
    readonly metadataUrl?: string
    readonly detail?: string
  }
  readonly metrics: import("./server").OxpServer.Metrics
}

export interface LegacyImportPlan {
  readonly roots: readonly {
    readonly path: string
    readonly alias?: string
  }[]
  readonly grant: Partial<OxpSchema.Grant>
}

// Disabled OXP must remain a cheap authority/config projection. The active
// runtime owns the MCP listener plus the read/search/project execution graph;
// the idle runtime deliberately stops at Config/Root so merely rendering
// Settings or restoring a disabled connector cannot hydrate Ripgrep/process
// services or the capability execution graph.
//
// LayerNode dependencies provision a node's implementation but are not exported
// from the compiled runtime. Host control/state paths consume Config/Root
// directly, and the active worker-agent path also consumes AgentCatalog, so each
// service used directly by this module must be an explicit group output.
const idleLayer = AppNodeBuilder.build(LayerNode.group([OxpConfig.node, OxpRoot.node]))
const activeLayer = AppNodeBuilder.build(
  LayerNode.group([
    CrossSpawnSpawner.node,
    OxpConfig.node,
    OxpRoot.node,
    OxpAgentCatalog.node,
    OxpModelCatalog.node,
    OxpServer.node,
  ]),
  [
    [OxpSessionControl.node, OxpSessionControlV1.layer],
    [OxpRequestControl.node, OxpRequestControlV1.layer],
    [OxpWorkerControl.node, OxpWorkerControlV1.layer],
    [OxpMcpControl.node, OxpMcpControlV1.layer],
    [OxpSystemOneControl.node, OxpSystemOneControlV1.layer],
    [OxpAgentCatalog.node, OxpAgentCatalogV1.layer],
    [OxpModelCatalog.node, OxpModelCatalogV1.layer],
  ],
)

const makeIdleRuntime = () => ManagedRuntime.make(idleLayer)
const makeActiveRuntime = () => ManagedRuntime.make(activeLayer)
type IdleRuntime = ReturnType<typeof makeIdleRuntime>
type ActiveRuntime = ReturnType<typeof makeActiveRuntime>

let idleRuntime: IdleRuntime | undefined
let activeRuntime: ActiveRuntime | undefined
let generation = 0
let endpoint: EndpointDescriptor | undefined
let endpointError: string | undefined
let operation: Promise<void> = Promise.resolve()

const EMPTY_METRICS: import("./server").OxpServer.Metrics = Object.freeze({
  calls: 0,
  failures: 0,
  augmentationCalls: 0,
  supervisionCalls: 0,
  delegationCalls: 0,
  parentEpochs: 0,
  parentEpochReminders: 0,
  conversationCorrelatedCalls: 0,
  unattributedParentCalls: 0,
  trackedParents: 0,
})

function getIdleRuntime(): IdleRuntime {
  return (idleRuntime ??= makeIdleRuntime())
}

function getActiveRuntime(): ActiveRuntime {
  return (activeRuntime ??= makeActiveRuntime())
}

function runIdle<A>(effect: Effect.Effect<A, any, any>): Promise<A> {
  return getIdleRuntime().runPromise(effect as never) as Promise<A>
}

function runActive<A>(effect: Effect.Effect<A, any, any>): Promise<A> {
  return getActiveRuntime().runPromise(effect as never) as Promise<A>
}

function runControl<A>(effect: Effect.Effect<A, any, any>): Promise<A> {
  return activeRuntime ? runActive(effect) : runIdle(effect)
}

function enqueue<A>(fn: () => Promise<A>): Promise<A> {
  const next = operation.then(fn, fn)
  operation = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

const baseStateEffect = Effect.gen(function* () {
  const config = yield* OxpConfig.Service
  const roots = yield* OxpRoot.Service
  const current = yield* config.get()
  const projected = yield* Effect.forEach(current.roots, (root) =>
    roots.verify(root).pipe(
      Effect.as({ id: root.id, alias: root.alias, path: root.path, available: true, managedByProject: OxpRoot.isProjectManaged(root) } as const),
      Effect.catch(() =>
        Effect.succeed({ id: root.id, alias: root.alias, path: root.path, available: false, managedByProject: OxpRoot.isProjectManaged(root) } as const),
      ),
    ),
  )
  return { current, projected }
})

const activeStateEffect = Effect.gen(function* () {
  const base = yield* baseStateEffect
  const server = yield* OxpServer.Service
  return { ...base, metrics: server.metrics() }
})

async function stateNow(): Promise<TrustedState> {
  const { current, projected, metrics } = activeRuntime
    ? await runActive(activeStateEffect)
    : { ...(await runIdle(baseStateEffect)), metrics: EMPTY_METRICS }
  return Object.freeze({
    version: 1 as const,
    enabled: current.enabled,
    connector: current.connector,
    configRevision: current.revision,
    roots: Object.freeze(projected),
    grant: current.grant,
    workerPolicy: current.workerPolicy ?? {
      models: [],
      agents: [],
      agentRoots: [],
    },
    endpoint: Object.freeze(
      endpoint
        ? {
            state: "ready" as const,
            generation: endpoint.generation,
            schemaFingerprint: endpoint.schemaFingerprint,
            url: endpoint.url,
            metadataUrl: endpoint.metadataUrl,
          }
        : endpointError
          ? {
              state: "error" as const,
              ...(generation > 0 ? { generation } : {}),
              detail: endpointError,
            }
          : {
              state: "stopped" as const,
              ...(generation > 0 ? { generation } : {}),
            },
    ),
    metrics,
  })
}

export function getState(): Promise<TrustedState> {
  return enqueue(stateNow)
}

async function retireIdleRuntime() {
  const idle = idleRuntime
  if (!idle) return
  idleRuntime = undefined
  await idle.dispose()
}

async function retireActiveRuntime() {
  const active = activeRuntime
  if (!active) return
  activeRuntime = undefined
  await active.dispose()
}

async function startNow(): Promise<TrustedState> {
  if (endpoint) return stateNow()
  try {
    const current = await runControl(OxpConfig.Service.use((config) => config.get()))
    if (!current.enabled) throw new OxpError.AuthDenied({ detail: "Enable OXP before starting its endpoint" })

    // There must never be two live OxpConfig caches. Commit/control work while
    // idle uses the small runtime; activation disposes it before constructing
    // the server runtime, whose Config instance reloads the committed disk truth.
    if (!activeRuntime) await retireIdleRuntime()
    const result = await runActive(
      Effect.gen(function* () {
        const config = yield* OxpConfig.Service
        const server = yield* OxpServer.Service
        const refreshed = yield* config.get()
        if (!refreshed.enabled) return yield* new OxpError.AuthDenied({ detail: "Enable OXP before starting its endpoint" })
        return yield* server.start()
      }),
    )
    generation += 1
    endpoint = Object.freeze({
      generation,
      url: result.url,
      metadataUrl: result.metadataUrl,
      schemaFingerprint: result.surfaceFingerprint,
    })
    endpointError = undefined
  } catch (error) {
    endpointError = error instanceof Error ? error.message : String(error)
    throw error
  }
  return stateNow()
}

async function stopNow(): Promise<TrustedState> {
  if (activeRuntime) {
    await runActive(OxpServer.Service.use((server) => server.stop()))
  }
  endpoint = undefined
  endpointError = undefined
  if (activeRuntime) {
    const current = await runActive(OxpConfig.Service.use((config) => config.get()))
    if (!current.enabled) await retireActiveRuntime()
  }
  return stateNow()
}

export function start(): Promise<TrustedState> {
  return enqueue(startNow)
}

export function setEnabled(enabled: boolean): Promise<TrustedState> {
  return enqueue(async () => {
    await runControl(OxpConfig.Service.use((config) => config.setEnabled(enabled)))
    // Config revocation is the first phase of desktop disable: it immediately
    // denies new calls while the privileged main owner drains/stops the remote
    // tunnel. Main then issues stop/revoke to retire the listener. Keeping these
    // phases distinct avoids pointing a still-live tunnel at a vanished listener.
    if (!enabled) return stateNow()
    // Enabled-but-disconnected is still an active local OXP connector: keep the
    // dedicated secret loopback endpoint ready independently of tunnel state.
    // This preserves the process-boundary contract and makes Connect a pure
    // transport operation rather than a hidden authority transition.
    return startNow()
  })
}

export function setGrant(patch: Partial<OxpSchema.Grant>): Promise<TrustedState> {
  return enqueue(async () => {
    await runControl(OxpConfig.Service.use((config) => config.setGrant(patch)))
    return stateNow()
  })
}

export function setWorkerDefaultModel(
  model: OxpSchema.ModelSelection | undefined,
): Promise<TrustedState> {
  return enqueue(async () => {
    await runControl(
      OxpConfig.Service.use((config) => config.setWorkerDefaultModel(model)),
    )
    return stateNow()
  })
}

export function listWorkerAgents(id: string): Promise<WorkerAgentCatalog> {
  return enqueue(async () => {
    if (!activeRuntime) {
      throw new OxpError.AuthDenied({
        detail:
          "Enable OXP before loading the workspace delegated-worker agent catalog",
      })
    }
    return runActive(
      Effect.gen(function* () {
        const roots = yield* OxpRoot.Service
        const catalog = yield* OxpAgentCatalog.Service
        const resolved = yield* roots.resolveRoot(OxpSchema.RootID.make(id))
        const snapshot = yield* catalog.list({
          directory: resolved.canonicalPath,
        })
        return {
          rootID: resolved.root.id,
          rootAlias: resolved.root.alias,
          agents: snapshot.agents,
          nativeDefaultAgent: snapshot.nativeDefaultAgent,
        } satisfies WorkerAgentCatalog
      }),
    )
  })
}

export function setWorkerDefaultAgent(
  id: string,
  agent: string | undefined,
): Promise<TrustedState> {
  return enqueue(async () => {
    const rootID = OxpSchema.RootID.make(id)
    if (agent) {
      if (!activeRuntime) {
        throw new OxpError.AuthDenied({
          detail:
            "Enable OXP before selecting a workspace delegated-worker agent",
        })
      }
      await runActive(
        Effect.gen(function* () {
          const roots = yield* OxpRoot.Service
          const catalog = yield* OxpAgentCatalog.Service
          const config = yield* OxpConfig.Service
          const resolved = yield* roots.resolveRoot(rootID)
          const snapshot = yield* catalog.list({
            directory: resolved.canonicalPath,
          })
          if (!snapshot.agents.some((candidate) => candidate.id === agent)) {
            return yield* new OxpError.InvalidArgument({
              detail:
                "Requested delegated-worker agent is unavailable in the approved root",
            })
          }
          yield* config.setWorkerDefaultAgent(rootID, agent)
        }),
      )
    } else {
      await runControl(
        OxpConfig.Service.use((config) =>
          config.setWorkerDefaultAgent(rootID, undefined),
        ),
      )
    }
    return stateNow()
  })
}


/**
 * One-way compatibility intake for the standalone localMCP config. The desktop
 * owner parses/whitelists the legacy document first; this sidecar owner then
 * commits only approved-root and grant semantics through their canonical owners.
 * Credentials are intentionally absent from this contract.
 */
export function importLegacyConfig(plan: LegacyImportPlan): Promise<TrustedState> {
  return enqueue(async () => {
    await runControl(
      Effect.gen(function* () {
        const roots = yield* OxpRoot.Service
        const config = yield* OxpConfig.Service
        yield* roots.importMany(plan.roots)
        yield* config.setGrant(plan.grant)
      }),
    )
    return stateNow()
  })
}

/**
 * Privileged desktop-main -> sidecar bridge for OXP's single OpenAI API
 * credential. The sidecar receives only a process-memory projection; the
 * durable source remains Electron main's OS-protected credential store. This
 * key is shared by OXP-owned OpenAI services such as Files, but remains
 * intentionally separate from model-provider credentials.
 */
export function setOpenAiApiKey(value: string | undefined): Promise<void> {
  return enqueue(async () => {
    const normalized = value?.trim() || undefined
    if (normalized && (normalized.length > 16 * 1024 || /[\r\n\0]/.test(normalized))) {
      throw new OxpError.InvalidArgument({
        detail: "Invalid OXP OpenAI API credential",
      })
    }
    if (normalized) process.env.OPENCODE_OXP_OPENAI_API_KEY = normalized
    else delete process.env.OPENCODE_OXP_OPENAI_API_KEY
  })
}

export function approveRoot(candidate: string, alias?: string): Promise<TrustedState> {
  return enqueue(async () => {
    await runControl(OxpRoot.Service.use((roots) => roots.approve(candidate, alias)))
    return stateNow()
  })
}

export function syncProjectRoots(candidates: readonly string[]): Promise<TrustedState> {
  return enqueue(async () => {
    await runControl(OxpRoot.Service.use((roots) => roots.syncProjectRoots(candidates)))
    return stateNow()
  })
}

export function renameRoot(id: string, alias: string): Promise<TrustedState> {
  return enqueue(async () => {
    await runControl(OxpRoot.Service.use((roots) => roots.rename(OxpSchema.RootID.make(id), alias)))
    return stateNow()
  })
}

export function removeRoot(id: string): Promise<TrustedState> {
  return enqueue(async () => {
    await runControl(OxpRoot.Service.use((roots) => roots.remove(OxpSchema.RootID.make(id))))
    return stateNow()
  })
}

export function stop(): Promise<TrustedState> {
  return enqueue(stopNow)
}

export function revoke(): Promise<TrustedState> {
  return enqueue(async () => {
    await runControl(OxpConfig.Service.use((config) => config.setEnabled(false)))
    return stopNow()
  })
}

export function restore(): Promise<TrustedState> {
  return enqueue(async () => {
    const current = await runControl(OxpConfig.Service.use((config) => config.get()))
    if (!current.enabled) return stateNow()
    return startNow()
  })
}

export function dispose() {
  return enqueue(async () => {
    const active = activeRuntime
    const idle = idleRuntime
    if (!active && !idle) return
    try {
      if (active) await active.runPromise(OxpServer.Service.use((server) => server.stop()) as never)
    } finally {
      endpoint = undefined
      endpointError = undefined
      activeRuntime = undefined
      idleRuntime = undefined
      await Promise.all([active?.dispose(), idle?.dispose()])
    }
  })
}

export * as OxpHost from "./host"
