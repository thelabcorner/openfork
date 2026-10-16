import { Effect, ManagedRuntime } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OxpConfig } from "./config"
import type { OxpAgentCatalog } from "./agent-catalog"
import { OxpError } from "./error"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"
import { createHostOperationQueue } from "./host-operation-queue"
import { startLeanOxpListener, type LeanEndpoint } from "./transport-listener"
import { OxpResult } from "./result"
import { OxpDiagnostics } from "./diagnostics"
import { OXP_STATIC_TRANSPORT } from "./transport-manifest"
import type { ExecutedCall } from "./transport-protocol"

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
const idleLayer = AppNodeBuilder.build(LayerNode.group([OxpConfig.node, OxpRoot.node]))

const makeIdleRuntime = () => ManagedRuntime.make(idleLayer)
type IdleRuntime = ReturnType<typeof makeIdleRuntime>
type ActiveModule = typeof import("./active-runtime")
type ActiveRuntime = ReturnType<ActiveModule["makeActiveRuntime"]>

let idleRuntime: IdleRuntime | undefined
let activeRuntime: ActiveRuntime | undefined
let activeModule: ActiveModule | undefined
let activeLoad: Promise<ActiveModule> | undefined
let executionService: import("./server").OxpServer.Interface | undefined
let leanEndpoint: LeanEndpoint | undefined
let generation = 0
let endpoint: EndpointDescriptor | undefined
let endpointError: string | undefined
const hostOperations = createHostOperationQueue<TrustedState>()

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

async function getActiveRuntime(): Promise<ActiveRuntime> {
  if (activeRuntime) return activeRuntime
  // Only one caller initializes the active module/graph. All public host
  // transitions run through enqueue(); this also coalesces accidental parallel
  // internal consumers without constructing a duplicate runtime/Config cache.
  const module = await (activeLoad ??= import("./active-runtime").catch((error) => {
    // A failed first import must not permanently pin the host to a rejected
    // promise. A later explicitly admitted activation may retry normally.
    activeLoad = undefined
    throw error
  }))
  activeModule = module
  return (activeRuntime ??= module.makeActiveRuntime())
}

function runIdle<A>(effect: Effect.Effect<A, any, any>): Promise<A> {
  return getIdleRuntime().runPromise(effect as never) as Promise<A>
}

async function runActive<A>(effect: Effect.Effect<A, any, any>): Promise<A> {
  return (await getActiveRuntime()).runPromise(effect as never) as Promise<A>
}

function runControl<A>(effect: Effect.Effect<A, any, any>): Promise<A> {
  return activeRuntime ? runActive(effect) : runIdle(effect)
}

function enqueue<A>(fn: () => Promise<A>): Promise<A> {
  return hostOperations.enqueue(fn)
}

const baseStateEffect = Effect.gen(function* () {
  const config = yield* OxpConfig.Service
  const roots = yield* OxpRoot.Service
  const current = yield* config.get()
  const projected = yield* Effect.forEach(
    current.roots,
    (root) =>
      roots.verify(root).pipe(
        Effect.as({ id: root.id, alias: root.alias, path: root.path, available: true, managedByProject: OxpRoot.isProjectManaged(root) } as const),
        Effect.catch(() =>
          Effect.succeed({ id: root.id, alias: root.alias, path: root.path, available: false, managedByProject: OxpRoot.isProjectManaged(root) } as const),
        ),
      ),
    // Independent read-only realpath/stat checks; concurrency is bounded to
    // avoid sequential slow-volume startup without filesystem I/O fan-out.
    { concurrency: 4 },
  )
  return { current, projected }
})

const activeStateEffect = Effect.gen(function* () {
  const base = yield* baseStateEffect
  const server = yield* activeModule!.OxpServer.Service
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
  return hostOperations.read(stateNow)
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
  executionService = undefined
  activeRuntime = undefined
  await active.dispose()
}

async function ensureActiveForWorkerCatalog() {
  const config = await runControl(OxpConfig.Service.use((service) => service.get()))
  if (!config.enabled) {
    throw new OxpError.AuthDenied({ detail: "Enable OXP before loading delegated-worker agents" })
  }
  if (activeRuntime) return
  // Workspace agent settings are Tier-2 requests even without an MCP call.
  // Reuse the same privileged runtime, never a separately initialized catalog.
  await retireIdleRuntime()
  await getActiveRuntime()
}

function admissionError(cause: unknown): ExecutedCall {
  if (!OxpError.isError(cause)) throw cause
  const error = OxpResult.projectError(cause)
  const output = `${error.code}: ${error.message}`
  return {
    result: {
      isError: true,
      content: [{ type: "text", text: output }],
      structuredContent: { output, error },
    },
  }
}

async function lazyExecute(
  epoch: number,
  name: string,
  args: unknown,
  metadata: Readonly<Record<string, unknown>> | undefined,
  signal: AbortSignal,
): Promise<ExecutedCall> {
  try {
    if (signal.aborted) throw new OxpError.Cancelled({ detail: "OXP request cancelled before admission" })
    // Cold activation is an OXP host mutation. Coalesce the first 100
    // concurrent calls with configuration updates and stop operations so a
    // retired listener cannot resurrect the privileged Effect owner.
    const service = executionService ?? await enqueue(async () => {
      if (signal.aborted) throw new OxpError.Cancelled({ detail: "OXP request cancelled during admission" })
      if (!endpoint || endpoint.generation !== epoch) {
        throw new OxpError.AuthRevoked({ detail: "OXP endpoint changed during execution admission" })
      }
      const state = await runControl(OxpConfig.Service.use((config) => config.get()))
      if (!state.enabled) throw new OxpError.AuthRevoked({ detail: "OXP was disabled before execution admission" })
      if (executionService) return executionService
      // Retire the idle Config/Root cache before creating active equivalents:
      // never let a cheap and privileged service graph claim independent
      // authority over the same config revision.
      await retireIdleRuntime()
      // Service tags belong to the dynamically imported graph. Resolve it
      // before evaluating any tag, not as an argument to runActive().
      await getActiveRuntime()
      const ready = await runActive(activeModule!.OxpServer.Service.use((server) => Effect.succeed(server)))
      if (!ready.validateManifest()) {
        throw new OxpError.DependencyUnavailable({
          detail: "OXP static transport manifest no longer matches the executable schema; refresh the host before retrying",
        })
      }
      executionService = ready
      return ready
    })
    if (!endpoint || endpoint.generation !== epoch || signal.aborted) {
      throw new OxpError.AuthRevoked({ detail: "OXP endpoint retired before execution dispatch" })
    }
    // Every leaf still runs its own authority and egress revalidation. This
    // reference caches service identity, NEVER permission or root decisions.
    return await service.execute(name, args, metadata, signal)
  } catch (cause) {
    return admissionError(cause)
  }
}

async function startNow(): Promise<TrustedState> {
  if (endpoint) return stateNow()
  try {
    const current = await runControl(OxpConfig.Service.use((config) => config.get()))
    if (!current.enabled) throw new OxpError.AuthDenied({ detail: "Enable OXP before starting its endpoint" })

    // Bind the real secret loopback MCP endpoint with only static protocol and
    // idle Config/Root authority. The heavyweight execution runtime is loaded
    // at the first actual tools/call, not on Connect/initialize/tools/list.
    const nextGeneration = generation + 1
    const result = await startLeanOxpListener({
      execute: (name, args, meta, signal) => lazyExecute(nextGeneration, name, args, meta, signal),
      onTransportError: (cause, phase) => OxpDiagnostics.record({
        cause,
        phase,
        surfaceFingerprint: OXP_STATIC_TRANSPORT.fingerprint,
      }).id,
    })
    leanEndpoint = result
    generation = nextGeneration
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
  const listener = leanEndpoint
  leanEndpoint = undefined
  // Disallow new execution admissions before waiting on HTTP drain.
  endpoint = undefined
  if (listener) await listener.stop({ forceAfterMs: 1_000 })
  if (activeRuntime) {
    await runActive(activeModule!.OxpServer.Service.use((server) => server.stop()))
  }
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
    await ensureActiveForWorkerCatalog()
    return runActive(
      Effect.gen(function* () {
        const roots = yield* OxpRoot.Service
        const catalog = yield* activeModule!.OxpAgentCatalog.Service
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
      await ensureActiveForWorkerCatalog()
      await runActive(
        Effect.gen(function* () {
          const roots = yield* OxpRoot.Service
          const catalog = yield* activeModule!.OxpAgentCatalog.Service
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
    const listener = leanEndpoint
    leanEndpoint = undefined
    endpoint = undefined
    if (!active && !idle && !listener) return
    try {
      if (listener) await listener.stop({ forceAfterMs: 1_000 })
      if (active) await active.runPromise(activeModule!.OxpServer.Service.use((server) => server.stop()) as never)
    } finally {
      endpointError = undefined
      executionService = undefined
      activeRuntime = undefined
      idleRuntime = undefined
      await Promise.all([active?.dispose(), idle?.dispose()])
    }
  })
}

export * as OxpHost from "./host"
