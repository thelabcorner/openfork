import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type {
  SidecarOxpAgentCatalog,
  SidecarLegacyImport,
  SidecarOxpGrant,
  SidecarOxpModelSelection,
  SidecarOxpState,
} from "../sidecar-protocol"
import {
  RuntimeArtifactError,
  RuntimeArtifactStore,
} from "./runtime-artifacts"

const DEFAULT_ACTIVATION_DELAY_MS = 750
const DEFAULT_ARM_WITHIN_MS = 30_000
const LEGACY_RESPONSE_EGRESS_DELAY_MS = 5_000
const RESPONSE_ARM_PROTOCOL_VERSION = 2
const ORPHAN_RECOVERY_MAX_MS = 30_000

export interface RuntimeStatus {
  readonly refreshable: boolean
  readonly state: "stable" | "scheduled" | "trial" | "degraded" | "disposed"
  readonly runtimeID?: string
  readonly activationGeneration?: number
  readonly activatedAt?: number
  readonly trial?: {
    readonly id: string
    readonly previousRuntimeID: string
    readonly candidateRuntimeID: string
    readonly phase: "scheduled" | "active"
    readonly activationAt?: number
    readonly acceptBy?: number
  }
  readonly lastTransition?: {
    readonly trialID: string
    readonly outcome: "accepted" | "reverted" | "failed" | "unchanged"
    readonly at: number
    readonly detail?: string
  }
  readonly detail?: string
}

export interface RuntimeMutationResult {
  readonly action: "refresh" | "accept" | "rollback"
  readonly changed: boolean
  readonly status: RuntimeStatus
}

export interface RuntimeRefreshControl {
  readonly status: () => Promise<RuntimeStatus>
  readonly refresh: (input: {
    readonly expectedRuntimeID: string
    readonly acceptWithinMs: number
  }) => Promise<RuntimeMutationResult>
  /** Host-only response-egress barrier: scheduled candidates never self-activate. */
  readonly arm: (trialID: string) => Promise<void>
  readonly accept: (trialID: string) => Promise<RuntimeMutationResult>
  readonly rollback: (trialID: string) => Promise<RuntimeMutationResult>
}

export interface RuntimeBackendModule {
  readonly runtimeModuleUrl: string
  readonly OxpHost: {
    readonly getState: () => Promise<SidecarOxpState>
    readonly restore: () => Promise<SidecarOxpState>
    readonly dispose: () => Promise<void>
    readonly start: () => Promise<SidecarOxpState>
    readonly stop: () => Promise<SidecarOxpState>
    readonly revoke: () => Promise<SidecarOxpState>
    readonly setEnabled: (enabled: boolean) => Promise<SidecarOxpState>
    readonly setGrant: (
      patch: Partial<SidecarOxpGrant>,
    ) => Promise<SidecarOxpState>
    readonly setWorkerDefaultModel: (
      model: SidecarOxpModelSelection | undefined,
    ) => Promise<SidecarOxpState>
    readonly listWorkerAgents: (
      rootID: string,
    ) => Promise<SidecarOxpAgentCatalog>
    readonly setWorkerDefaultAgent: (
      rootID: string,
      agent: string | undefined,
    ) => Promise<SidecarOxpState>
    readonly approveRoot: (
      path: string,
      alias?: string,
    ) => Promise<SidecarOxpState>
    readonly syncProjectRoots: (
      paths: readonly string[],
    ) => Promise<SidecarOxpState>
    readonly renameRoot: (
      rootID: string,
      alias: string,
    ) => Promise<SidecarOxpState>
    readonly removeRoot: (rootID: string) => Promise<SidecarOxpState>
    readonly setOpenAiApiKey: (value: string | undefined) => Promise<void>
    readonly importLegacyConfig: (
      plan: SidecarLegacyImport,
    ) => Promise<SidecarOxpState>
  }
  readonly OxpRuntimeRefresh: {
    /** Absent/1 is the legacy timer-based refresh bridge; v2 arms after HTTP finish. */
    readonly PROTOCOL_VERSION?: number
    readonly install: (control: RuntimeRefreshControl | undefined) => void
  }
}

interface RuntimeRecord {
  readonly module: RuntimeBackendModule
  readonly artifactPath: string
  readonly runtimeID: string
  activationGeneration: number
  activatedAt: number
}

interface Trial {
  readonly id: string
  readonly previous: RuntimeRecord
  readonly candidate: RuntimeRecord
  readonly acceptWithinMs: number
  readonly connectorID: string
  readonly candidateSnapshot: string
  phase: "scheduled" | "active"
  activationAt?: number
  acceptBy?: number
  orphaned?: boolean
  armTimer?: NodeJS.Timeout
  activationTimer?: NodeJS.Timeout
  acceptTimer?: NodeJS.Timeout
}

export interface RuntimeBackendTransition {
  /** Backend module whose ordinary HTTP listener is proven serving. */
  readonly current: () => RuntimeBackendModule | undefined
  /**
   * Atomically move the ordinary HTTP listener from one backend module to
   * another. On rejection, implementations restore `from` or report no
   * current backend so the coordinator cannot claim false availability.
   */
  readonly transition: (from: RuntimeBackendModule, to: RuntimeBackendModule) => Promise<void>
}

export interface RuntimePublication {
  /**
   * Present only for a newly activated candidate. A trusted host can use this
   * nonce to acknowledge that it actually observed the rotated privileged
   * endpoint before the trial is durably accepted.
   */
  readonly trialID?: string
}

export interface RuntimeRefreshCoordinatorOptions {
  readonly publish: (state: SidecarOxpState, publication?: RuntimePublication) => void | Promise<void>
  readonly probe: (state: SidecarOxpState) => Promise<void>
  readonly backendTransition?: RuntimeBackendTransition
  readonly importModule?: (url: string) => Promise<unknown>
  readonly now?: () => number
  readonly activationDelayMs?: number
  /** Maximum time a staged refresh may wait for the scheduling response to finish. */
  readonly armWithinMs?: number
  /** Test/host override; production defaults to the conservative v1 migration window. */
  readonly legacyResponseEgressDelayMs?: number
  readonly artifactUrl?: string
  readonly checkpointRoot?: string
  readonly log?: (
    level: "info" | "warn" | "error",
    message: string,
    metadata?: Readonly<Record<string, unknown>>,
  ) => void
}

class RefreshError extends Error {
  constructor(
    readonly code:
      | "OXP_BUSY"
      | "OXP_CONFLICT"
      | "OXP_HANDLE_STALE"
      | "OXP_AUTH_DENIED"
      | "OXP_INVALID_ARGUMENT"
      | "OXP_DEPENDENCY_UNAVAILABLE",
    message: string,
  ) {
    super(message)
    this.name = "OxpRuntimeRefreshError"
  }
}

function fail(
  code: RefreshError["code"],
  message: string,
): never {
  throw new RefreshError(code, message)
}

function failArtifact(error: unknown): never {
  if (error instanceof RefreshError) throw error
  if (error instanceof RuntimeArtifactError) {
    if (error.code === "busy") {
      fail("OXP_BUSY", error.message)
    }
    if (error.code === "conflict") {
      fail("OXP_CONFLICT", error.message)
    }
    fail("OXP_DEPENDENCY_UNAVAILABLE", error.message)
  }
  fail(
    "OXP_DEPENDENCY_UNAVAILABLE",
    "The OXP runtime artifact transaction failed.",
  )
}

const unavailableOxpHost = new Proxy(
  {} as RuntimeBackendModule["OxpHost"],
  {
    get(_target, property) {
      // Avoid accidentally becoming thenable/inspectable while still
      // fail-closing every host operation, including newer methods that may
      // not yet be represented by this local structural type.
      if (property === "then" || typeof property === "symbol") return undefined
      return async () => {
        fail(
          "OXP_DEPENDENCY_UNAVAILABLE",
          "No verified OXP runtime is currently serving; restart is required.",
        )
      }
    },
  },
)

function canonicalFileUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== "file:") {
    fail(
      "OXP_DEPENDENCY_UNAVAILABLE",
      "The active OXP backend is not a reloadable file artifact.",
    )
  }
  url.search = ""
  url.hash = ""
  return url
}

function refreshableArtifact(filepath: string) {
  const normalized = filepath.replaceAll("\\", "/").toLowerCase()
  return normalized.endsWith("/dist/node/node.js")
}


function validateBackendModule(value: unknown): RuntimeBackendModule {
  if (!value || typeof value !== "object") {
    fail(
      "OXP_DEPENDENCY_UNAVAILABLE",
      "The candidate backend did not export an OXP runtime module.",
    )
  }
  const module = value as Partial<RuntimeBackendModule>
  if (
    typeof module.runtimeModuleUrl !== "string" ||
    !module.OxpHost ||
    typeof module.OxpHost.getState !== "function" ||
    typeof module.OxpHost.restore !== "function" ||
    typeof module.OxpHost.dispose !== "function" ||
    typeof module.OxpHost.start !== "function" ||
    typeof module.OxpHost.stop !== "function" ||
    typeof module.OxpHost.revoke !== "function" ||
    typeof module.OxpHost.setEnabled !== "function" ||
    typeof module.OxpHost.setGrant !== "function" ||
    typeof module.OxpHost.setWorkerDefaultModel !== "function" ||
    typeof module.OxpHost.listWorkerAgents !== "function" ||
    typeof module.OxpHost.setWorkerDefaultAgent !== "function" ||
    typeof module.OxpHost.approveRoot !== "function" ||
    typeof module.OxpHost.syncProjectRoots !== "function" ||
    typeof module.OxpHost.renameRoot !== "function" ||
    typeof module.OxpHost.removeRoot !== "function" ||
    typeof module.OxpHost.setOpenAiApiKey !== "function" ||
    typeof module.OxpHost.importLegacyConfig !== "function" ||
    !module.OxpRuntimeRefresh ||
    typeof module.OxpRuntimeRefresh.install !== "function"
  ) {
    fail(
      "OXP_DEPENDENCY_UNAVAILABLE",
      "The candidate backend does not implement the transactional OXP runtime ABI.",
    )
  }
  return module as RuntimeBackendModule
}

async function resolveArtifact(module: RuntimeBackendModule) {
  const url = canonicalFileUrl(module.runtimeModuleUrl)
  const filepath = await fs.realpath(fileURLToPath(url))
  return {
    url,
    filepath,
    refreshable: refreshableArtifact(filepath),
  }
}

export class RuntimeRefreshCoordinator {
  private active: RuntimeRecord
  /** Last runtime whose endpoint restore + validation + probe are proven live. */
  private serving: RuntimeRecord | undefined
  private readonly artifactPath: string
  private readonly refreshable: boolean
  private readonly artifactStore: RuntimeArtifactStore | undefined
  private readonly publish: RuntimeRefreshCoordinatorOptions["publish"]
  private readonly probe: RuntimeRefreshCoordinatorOptions["probe"]
  private readonly backendTransition: RuntimeRefreshCoordinatorOptions["backendTransition"]
  private readonly importModule: NonNullable<
    RuntimeRefreshCoordinatorOptions["importModule"]
  >
  private readonly now: NonNullable<RuntimeRefreshCoordinatorOptions["now"]>
  private readonly activationDelayMs: number
  private readonly armWithinMs: number
  private readonly legacyResponseEgressDelayMs: number
  private readonly log: NonNullable<RuntimeRefreshCoordinatorOptions["log"]>
  private activationGeneration = 1
  private trial: Trial | undefined
  private lockOwner: string | undefined
  private lastTransition: RuntimeStatus["lastTransition"]
  private operation: Promise<void> = Promise.resolve()
  private disposed = false

  private constructor(
    active: RuntimeRecord,
    artifactPath: string,
    refreshable: boolean,
    artifactStore: RuntimeArtifactStore | undefined,
    options: RuntimeRefreshCoordinatorOptions,
  ) {
    this.active = active
    this.serving = active
    this.artifactPath = artifactPath
    this.refreshable = refreshable
    this.artifactStore = artifactStore
    this.publish = options.publish
    this.probe = options.probe
    this.backendTransition = options.backendTransition
    this.importModule =
      options.importModule ??
      ((url) => import(/* @vite-ignore */ url))
    this.now = options.now ?? Date.now
    this.activationDelayMs =
      options.activationDelayMs ?? DEFAULT_ACTIVATION_DELAY_MS
    this.armWithinMs = options.armWithinMs ?? DEFAULT_ARM_WITHIN_MS
    this.legacyResponseEgressDelayMs =
      options.legacyResponseEgressDelayMs ?? LEGACY_RESPONSE_EGRESS_DELAY_MS
    this.log = options.log ?? (() => undefined)
  }

  static async create(
    initialModule: RuntimeBackendModule,
    options: RuntimeRefreshCoordinatorOptions,
  ) {
    const module = validateBackendModule(initialModule)
    const artifact = await resolveArtifact(module)
    let artifactStore: RuntimeArtifactStore | undefined
    let runtimeID = "unavailable"
    if (options.artifactUrl && options.checkpointRoot) {
      try {
        artifactStore = await RuntimeArtifactStore.create(
          options.artifactUrl,
          options.checkpointRoot,
        )
        if (
          path.normalize(artifactStore.artifactFile) !==
          path.normalize(artifact.filepath)
        ) {
          throw new RuntimeArtifactError(
            "conflict",
            "The loaded OXP runtime does not match the host-owned mutable artifact.",
          )
        }
        const accepted =
          (await artifactStore.accepted()) ??
          (await artifactStore.initializeAccepted())
        runtimeID = await artifactStore.currentID()
        if (accepted.runtimeID !== runtimeID) {
          throw new RuntimeArtifactError(
            "conflict",
            "The loaded OXP runtime does not match the durable accepted checkpoint.",
          )
        }
      } catch {
        artifactStore = undefined
      }
    }
    const now = (options.now ?? Date.now)()
    const active: RuntimeRecord = {
      module,
      artifactPath: artifact.filepath,
      runtimeID,
      activationGeneration: 1,
      activatedAt: now,
    }
    const coordinator = new RuntimeRefreshCoordinator(
      active,
      artifact.filepath,
      artifact.refreshable && artifactStore !== undefined,
      artifactStore,
      options,
    )
    coordinator.bind(active)
    return coordinator
  }

  get host() {
    const serving = this.serving
    return serving && this.backendMatches(serving) ? serving.module.OxpHost : unavailableOxpHost
  }

  status(): RuntimeStatus {
    const trial = this.trial
    const serving = this.serving && this.backendMatches(this.serving) ? this.serving : undefined
    return {
      refreshable: this.refreshable && !this.disposed && serving !== undefined,
      state:
        this.disposed
          ? "disposed"
          : trial?.phase === "scheduled"
          ? "scheduled"
          : trial?.phase === "active"
            ? "trial"
            : !serving
              ? "degraded"
              : "stable",
      ...(serving
        ? {
            runtimeID: serving.runtimeID,
            activationGeneration: serving.activationGeneration,
            activatedAt: serving.activatedAt,
          }
        : {}),
      ...(trial
        ? {
            trial: {
              id: trial.id,
              previousRuntimeID: trial.previous.runtimeID,
              candidateRuntimeID: trial.candidate.runtimeID,
              phase: trial.phase,
              ...(trial.activationAt !== undefined
                ? { activationAt: trial.activationAt }
                : {}),
              ...(trial.acceptBy !== undefined
                ? { acceptBy: trial.acceptBy }
                : {}),
            },
          }
        : {}),
      ...(this.lastTransition
        ? { lastTransition: this.lastTransition }
        : {}),
      ...(this.disposed
        ? {
            detail: "The OXP runtime-refresh coordinator is shutting down.",
          }
        : !serving
        ? {
            detail:
              "No OXP runtime is currently verified as serving; restart is required to recover the durable accepted runtime.",
          }
        : !this.refreshable
        ? {
            detail:
              "This backend is not the mutable standalone dist/node/node.js artifact; use the normal application update/restart path.",
          }
        : {}),
    }
  }

  refresh(
    caller: RuntimeRecord,
    input: { readonly expectedRuntimeID: string; readonly acceptWithinMs: number },
  ) {
    return this.enqueue(() => this.refreshNow(caller, input))
  }

  arm(caller: RuntimeRecord, trialID: string) {
    return this.enqueue(() => this.armNow(caller, trialID))
  }

  accept(caller: RuntimeRecord, trialID: string) {
    return this.enqueue(() => this.acceptNow(caller, trialID))
  }

  /**
   * Private host acknowledgment path. The Desktop parent process is already the
   * privileged owner of sidecar endpoint state, so it may acknowledge an active
   * candidate after receiving that candidate's publication even when the
   * external MCP caller is still pinned to the retired endpoint.
   *
   * This is intentionally not installed into OxpRuntimeRefresh and is therefore
   * unreachable through the public OXP capability surface.
   */
  acceptFromHost(trialID: string) {
    return this.enqueue(() => {
      const trial = this.requireTrial(trialID)
      if (
        trial.phase !== "active" ||
        this.active !== trial.candidate ||
        this.serving !== trial.candidate
      ) {
        fail(
          "OXP_CONFLICT",
          "The host can acknowledge only the currently active OXP runtime trial.",
        )
      }
      return this.acceptNow(trial.candidate, trialID)
    })
  }

  rollback(caller: RuntimeRecord, trialID: string) {
    return this.enqueue(() =>
      this.rollbackNow(caller, trialID, "explicit"),
    )
  }

  async dispose() {
    this.disposed = true
    await this.operation.catch(() => undefined)
    const trial = this.trial
    this.clearTrialTimers(trial)
    this.trial = undefined
    this.active.module.OxpRuntimeRefresh.install(undefined)
    if (trial) {
      trial.previous.module.OxpRuntimeRefresh.install(undefined)
      trial.candidate.module.OxpRuntimeRefresh.install(undefined)
    }
    const modules = new Set<RuntimeBackendModule>([
      this.active.module,
      ...(trial ? [trial.previous.module, trial.candidate.module] : []),
    ])
    await Promise.all(
      [...modules].map((module) =>
        module.OxpHost.dispose().catch(() => undefined),
      ),
    )
    this.serving = undefined
    if (this.artifactStore) {
      const accepted = await this.artifactStore.accepted().catch(() => undefined)
      if (trial && accepted) {
        await this.artifactStore
          .restore(accepted.snapshotPath, accepted.runtimeID)
          .catch(() => undefined)
        await this.artifactStore
          .cleanup([accepted.runtimeID])
          .catch(() => undefined)
      }
      await this.releaseLock(trial?.id ?? this.lockOwner)
    }
  }

  private bind(record: RuntimeRecord) {
    record.module.OxpRuntimeRefresh.install({
      status: async () => this.status(),
      refresh: (input) => this.refresh(record, input),
      arm: (trialID) => this.arm(record, trialID),
      accept: (trialID) => this.accept(record, trialID),
      rollback: (trialID) => this.rollback(record, trialID),
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(
        new RefreshError(
          "OXP_DEPENDENCY_UNAVAILABLE",
          "The OXP runtime-refresh coordinator is shutting down.",
        ),
      )
    }
    const run = this.operation.then(operation, operation)
    this.operation = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private assertCurrentCaller(caller: RuntimeRecord) {
    if (caller !== this.active) {
      fail(
        "OXP_HANDLE_STALE",
        "This OXP runtime is no longer authoritative.",
      )
    }
    if (this.serving !== caller) {
      fail(
        "OXP_DEPENDENCY_UNAVAILABLE",
        "No verified OXP runtime is currently serving.",
      )
    }
  }

  private async refreshNow(
    caller: RuntimeRecord,
    input: { readonly expectedRuntimeID: string; readonly acceptWithinMs: number },
  ): Promise<RuntimeMutationResult> {
    this.assertCurrentCaller(caller)
    const store = this.artifactStore
    if (!this.refreshable || !store) {
      fail(
        "OXP_DEPENDENCY_UNAVAILABLE",
        "Transactional refresh is unavailable for this backend layout.",
      )
    }
    if (this.trial) {
      fail(
        "OXP_BUSY",
        "An OXP runtime refresh trial is already pending.",
      )
    }
    if (input.expectedRuntimeID !== this.active.runtimeID) {
      fail(
        "OXP_CONFLICT",
        "The expected OXP runtime ID is stale; inspect status again before refreshing.",
      )
    }

    const trialID = randomUUID()
    let locked = false
    try {
      await store.acquire(trialID)
      locked = true
      this.lockOwner = trialID

      const snapshotted = await store.snapshotCurrent()
      if (snapshotted.runtimeID === this.active.runtimeID) {
        this.lastTransition = {
          trialID,
          outcome: "unchanged",
          at: this.now(),
        }
        await this.releaseLock(trialID)
        locked = false
        return { action: "refresh", changed: false, status: this.status() }
      }

      const url = canonicalFileUrl(this.active.module.runtimeModuleUrl)
      url.searchParams.set("oxp-runtime-trial", trialID)

      let candidateModule: RuntimeBackendModule
      try {
        candidateModule = validateBackendModule(
          await this.importModule(url.href),
        )
      } catch (error) {
        if (error instanceof RefreshError) throw error
        fail(
          "OXP_DEPENDENCY_UNAVAILABLE",
          "Unable to import the rebuilt OXP runtime artifact.",
        )
      }

      const candidateArtifact = await resolveArtifact(candidateModule).catch(
        (error) => {
          candidateModule.OxpRuntimeRefresh.install(undefined)
          throw error
        },
      )
      if (
        path.normalize(candidateArtifact.filepath) !==
        path.normalize(store.artifactFile)
      ) {
        candidateModule.OxpRuntimeRefresh.install(undefined)
        fail(
          "OXP_CONFLICT",
          "The candidate OXP module resolved to a different backend artifact.",
        )
      }

      const after = await store.currentID()
      if (after !== snapshotted.runtimeID) {
        candidateModule.OxpRuntimeRefresh.install(undefined)
        fail(
          "OXP_CONFLICT",
          "The OXP runtime artifact changed after candidate snapshotting.",
        )
      }

      const previous = this.active
      const candidate: RuntimeRecord = {
        module: candidateModule,
        artifactPath: this.artifactPath,
        runtimeID: snapshotted.runtimeID,
        activationGeneration: 0,
        activatedAt: 0,
      }
      this.bind(candidate)

      const baseline = await previous.module.OxpHost.getState()
      if (!baseline.enabled || baseline.endpoint.state !== "ready") {
        candidate.module.OxpRuntimeRefresh.install(undefined)
        await candidate.module.OxpHost.dispose().catch(() => undefined)
        fail(
          "OXP_CONFLICT",
          "The active OXP endpoint must be ready before starting a runtime refresh trial.",
        )
      }

      const trial: Trial = {
        id: trialID,
        previous,
        candidate,
        candidateSnapshot: snapshotted.snapshot,
        acceptWithinMs: input.acceptWithinMs,
        connectorID: baseline.connector.id,
        phase: "scheduled",
      }
      this.trial = trial
      if (
        (caller.module.OxpRuntimeRefresh.PROTOCOL_VERSION ?? 1) >=
        RESPONSE_ARM_PROTOCOL_VERSION
      ) {
        // v2+: do not arm candidate activation from inside the request that
        // scheduled it. The old OXP endpoint is carrying that response;
        // retiring it before HTTP egress completes can make a successful
        // refresh look like a transport failure. The backend response owner
        // calls arm() only after ServerResponse emits "finish". If that never
        // happens, expire the staged transaction without replacing the endpoint.
        trial.armTimer = setTimeout(() => {
          void this.enqueue(() =>
            this.rollbackNow(
              trial.previous,
              trialID,
              "unarmed",
            ),
          ).catch((error) => {
            this.log("error", "OXP runtime unarmed trial cleanup failed", {
              trialID,
              error: error instanceof Error ? error.message : String(error),
            })
          })
        }, this.armWithinMs)
        trial.armTimer.unref?.()
      } else {
        // One-way migration bridge for a currently accepted v1 backend: v1
        // cannot emit the post-response arm hook. Give its tiny local MCP
        // response a conservative egress window, then activate normally. Once
        // v2 is accepted this path is no longer used.
        const legacyDelay = Math.max(
          this.activationDelayMs,
          this.legacyResponseEgressDelayMs,
        )
        trial.activationTimer = setTimeout(() => {
          void this.enqueue(() => this.activateTrial(trialID)).catch((error) => {
            this.log("error", "OXP legacy runtime trial activation failed", {
              trialID,
              error: error instanceof Error ? error.message : String(error),
            })
          })
        }, legacyDelay)
        trial.activationTimer.unref?.()
        this.log("warn", "OXP refresh is using the legacy response-egress bridge", {
          trialID,
          activationDelayMs: legacyDelay,
        })
      }

      return { action: "refresh", changed: true, status: this.status() }
    } catch (error) {
      // Once a Trial owns the transaction, its lifecycle owns release. Before
      // that point this stack frame is the only owner and must release on error.
      if (locked && this.trial?.id !== trialID) {
        await this.releaseLock(trialID)
      }
      failArtifact(error)
    }
  }

  private async armNow(caller: RuntimeRecord, trialID: string) {
    const trial = this.requireTrial(trialID)
    this.assertCurrentCaller(caller)
    if (trial.phase !== "scheduled" || caller !== trial.previous) {
      fail(
        "OXP_HANDLE_STALE",
        "Only the runtime that scheduled the current OXP refresh may arm it.",
      )
    }
    if (trial.activationTimer) return
    if (trial.armTimer) clearTimeout(trial.armTimer)
    trial.armTimer = undefined
    trial.activationTimer = setTimeout(() => {
      void this.enqueue(() => this.activateTrial(trialID)).catch((error) => {
        this.log("error", "OXP runtime trial activation failed", {
          trialID,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, this.activationDelayMs)
    trial.activationTimer.unref?.()
  }

  private async activateTrial(trialID: string) {
    const trial = this.trial
    if (!trial || trial.id !== trialID || trial.phase !== "scheduled") return
    if (trial.activationTimer) clearTimeout(trial.activationTimer)
    trial.activationTimer = undefined

    try {
      // Once retirement starts, the previous endpoint is no longer proven live.
      // Do not publish a candidate identity until its own endpoint has restored,
      // validated, and passed the host probe.
      this.markNotServing(trial.previous)
      await trial.previous.module.OxpHost.dispose()
      const state = await trial.candidate.module.OxpHost.restore()
      await this.validateRestoredState(state, trial.connectorID)
      await this.probe(state)
      await this.transitionBackendTo(trial.candidate)
      this.activateRecord(trial.candidate)

      const now = this.now()
      trial.phase = "active"
      trial.activationAt = now
      trial.acceptBy = now + trial.acceptWithinMs
      await this.publish(state, { trialID })
      trial.acceptTimer = setTimeout(() => {
        void this.enqueue(() =>
          this.rollbackNow(
            trial.candidate,
            trialID,
            "deadline",
          ),
        ).catch((error) => {
          this.log("error", "OXP runtime automatic rollback failed", {
            trialID,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }, trial.acceptWithinMs)
      trial.acceptTimer.unref?.()
      this.log("info", "OXP runtime trial activated", {
        trialID,
        runtimeID: trial.candidate.runtimeID,
      })
    } catch {
      await this.restorePreviousAfterFailedActivation(trial)
    }
  }

  private activateRecord(record: RuntimeRecord) {
    if (!this.backendMatches(record)) {
      fail(
        "OXP_DEPENDENCY_UNAVAILABLE",
        "The ordinary HTTP backend does not match the runtime being activated.",
      )
    }
    record.activationGeneration = ++this.activationGeneration
    record.activatedAt = this.now()
    this.active = record
    this.serving = record
  }

  private markNotServing(record: RuntimeRecord) {
    if (this.serving === record) this.serving = undefined
  }

  private backendMatches(record: RuntimeRecord) {
    return this.backendTransition === undefined || this.backendTransition.current() === record.module
  }

  private async transitionBackendTo(record: RuntimeRecord) {
    const transition = this.backendTransition
    if (!transition) return
    const current = transition.current()
    if (current === record.module) return
    if (!current) {
      fail(
        "OXP_DEPENDENCY_UNAVAILABLE",
        "No ordinary HTTP backend is currently proven serving.",
      )
    }
    await transition.transition(current, record.module)
    if (transition.current() !== record.module) {
      fail(
        "OXP_DEPENDENCY_UNAVAILABLE",
        "The ordinary HTTP backend transition did not activate the requested runtime.",
      )
    }
  }

  private async releaseLock(trialID?: string) {
    const owner = this.lockOwner
    if (!owner || (trialID !== undefined && owner !== trialID)) return
    try {
      await this.artifactStore?.release(owner)
    } finally {
      if (this.lockOwner === owner) this.lockOwner = undefined
    }
  }

  private async finishTerminalTrial(
    trial: Trial,
    keepRuntimeIDs: readonly string[],
  ) {
    this.clearTrialTimers(trial)
    const store = this.artifactStore
    if (store) {
      // Keep the transaction lock through checkpoint cleanup. Release is the
      // structural finalizer and must run even when cleanup itself fails.
      try {
        await store.cleanup(keepRuntimeIDs)
      } catch {
        // Cleanup is best-effort; lock release and truthful serving state are not.
      } finally {
        await this.releaseLock(trial.id)
      }
    }
    if (this.trial === trial) this.trial = undefined
  }

  private armOrphanExpiry(trial: Trial) {
    const delay = Math.max(
      1,
      Math.min(trial.acceptWithinMs, ORPHAN_RECOVERY_MAX_MS),
    )
    const now = this.now()
    trial.orphaned = true
    trial.acceptBy = now + delay
    trial.acceptTimer = setTimeout(() => {
      void this.enqueue(() => this.abandonOrphanedTrial(trial.id)).catch(
        (error) => {
          this.log("error", "OXP orphaned runtime trial finalization failed", {
            trialID: trial.id,
            error: error instanceof Error ? error.message : String(error),
          })
        },
      )
    }, delay)
    trial.acceptTimer.unref?.()
  }

  private async abandonOrphanedTrial(trialID: string) {
    const trial = this.trial
    if (!trial || trial.id !== trialID || !trial.orphaned) return
    const store = this.artifactStore
    this.clearTrialTimers(trial)
    this.markNotServing(trial.candidate)
    trial.candidate.module.OxpRuntimeRefresh.install(undefined)
    await trial.candidate.module.OxpHost.dispose().catch(() => undefined)

    if (store) {
      const accepted = await store.accepted().catch(() => undefined)
      if (accepted?.runtimeID === trial.previous.runtimeID) {
        await store
          .restore(accepted.snapshotPath, accepted.runtimeID)
          .catch(() => undefined)
      }
    }

    this.lastTransition = {
      trialID,
      outcome: "failed",
      at: this.now(),
      detail:
        "Rollback recovery grace expired; no runtime is verified as serving and restart is required.",
    }
    await this.finishTerminalTrial(trial, [trial.previous.runtimeID])
  }

  private async validateRestoredState(
    state: SidecarOxpState,
    connectorID: string,
  ) {
    if (
      !state.enabled ||
      state.endpoint.state !== "ready" ||
      state.connector.id !== connectorID
    ) {
      fail(
        "OXP_DEPENDENCY_UNAVAILABLE",
        "The replacement OXP runtime did not restore the expected ready connector.",
      )
    }
  }

  private async restorePreviousAfterFailedActivation(
    trial: Trial,
  ) {
    const store = this.artifactStore
    if (!store) {
      fail(
        "OXP_DEPENDENCY_UNAVAILABLE",
        "The OXP runtime artifact store is unavailable during rollback.",
      )
    }
    await trial.candidate.module.OxpHost.dispose().catch(() => undefined)
    this.markNotServing(trial.candidate)

    try {
      let restored: SidecarOxpState
      try {
        const accepted = await store.accepted()
        if (!accepted || accepted.runtimeID !== trial.previous.runtimeID) {
          fail(
            "OXP_CONFLICT",
            "The durable accepted OXP checkpoint no longer matches the previous runtime.",
          )
        }
        await store
          .restore(accepted.snapshotPath, accepted.runtimeID)
          .catch(failArtifact)
        restored = await trial.previous.module.OxpHost.restore()
        await this.validateRestoredState(restored, trial.connectorID)
        await this.probe(restored)
        await this.transitionBackendTo(trial.previous)
        this.activateRecord(trial.previous)
      } catch (restoreError) {
        this.markNotServing(trial.previous)
        this.lastTransition = {
          trialID: trial.id,
          outcome: "failed",
          at: this.now(),
          detail:
            "Candidate activation and previous-runtime restoration both failed.",
        }
        throw restoreError
      }

      try {
        await this.publish(restored)
        this.lastTransition = {
          trialID: trial.id,
          outcome: "failed",
          at: this.now(),
          detail: "Candidate activation failed before publication.",
        }
        this.log("warn", "OXP runtime trial rejected before publication", {
          trialID: trial.id,
        })
      } catch (publishError) {
        this.lastTransition = {
          trialID: trial.id,
          outcome: "failed",
          at: this.now(),
          detail:
            "Candidate activation failed and the previous runtime was restored, but host publication failed; restart is required to reconcile endpoint discovery.",
        }
        throw publishError
      }
    } finally {
      trial.candidate.module.OxpRuntimeRefresh.install(undefined)
      await this.finishTerminalTrial(trial, [trial.previous.runtimeID])
    }
  }

  private async acceptNow(
    caller: RuntimeRecord,
    trialID: string,
  ): Promise<RuntimeMutationResult> {
    const trial = this.requireTrial(trialID)
    this.assertCurrentCaller(caller)
    if (
      trial.phase !== "active" ||
      caller !== trial.candidate
    ) {
      fail(
        "OXP_CONFLICT",
        "The runtime trial can be accepted only from the active candidate runtime.",
      )
    }
    const store = this.artifactStore
    if (!store) {
      fail(
        "OXP_DEPENDENCY_UNAVAILABLE",
        "The OXP runtime artifact store is unavailable during acceptance.",
      )
    }
    const liveRuntimeID = await store.currentID().catch(failArtifact)
    if (liveRuntimeID !== trial.candidate.runtimeID) {
      fail(
        "OXP_CONFLICT",
        "The live OXP runtime artifact changed after the candidate was activated.",
      )
    }
    await store
      .accept(trial.candidateSnapshot, trial.candidate.runtimeID)
      .catch(failArtifact)
    this.clearTrialTimers(trial)
    trial.previous.module.OxpRuntimeRefresh.install(undefined)
    this.lastTransition = {
      trialID,
      outcome: "accepted",
      at: this.now(),
    }
    await this.finishTerminalTrial(trial, [trial.candidate.runtimeID])
    this.log("info", "OXP runtime trial accepted", {
      trialID,
      runtimeID: this.active.runtimeID,
    })
    return { action: "accept", changed: true, status: this.status() }
  }

  private async rollbackNow(
    caller: RuntimeRecord,
    trialID: string,
    reason: "explicit" | "deadline" | "unarmed",
  ): Promise<RuntimeMutationResult> {
    const trial = this.requireTrial(trialID)

    if (trial.phase === "scheduled") {
      this.assertCurrentCaller(caller)
      if (caller !== trial.previous) {
        fail(
          "OXP_HANDLE_STALE",
          "Only the current runtime can cancel a scheduled refresh trial.",
        )
      }
      trial.candidate.module.OxpRuntimeRefresh.install(undefined)
      await trial.candidate.module.OxpHost.dispose().catch(() => undefined)
      const store = this.artifactStore
      if (!store) {
        fail(
          "OXP_DEPENDENCY_UNAVAILABLE",
          "The OXP runtime artifact store is unavailable during rollback.",
        )
      }
      try {
        const accepted = await store.accepted()
        if (!accepted || accepted.runtimeID !== trial.previous.runtimeID) {
          fail(
            "OXP_CONFLICT",
            "The durable accepted OXP checkpoint no longer matches the previous runtime.",
          )
        }
        await store.restore(accepted.snapshotPath, accepted.runtimeID).catch(failArtifact)
        this.lastTransition = {
          trialID,
          outcome: "reverted",
          at: this.now(),
          detail:
            reason === "unarmed"
              ? "Refresh trial expired before the scheduling response completed."
              : reason === "deadline"
                ? "Refresh trial expired before activation."
                : "Refresh trial cancelled before activation.",
        }
      } catch (error) {
        this.lastTransition = {
          trialID,
          outcome: "failed",
          at: this.now(),
          detail:
            "Scheduled refresh cleanup failed; the previous runtime remains serving and restart will reconcile the durable artifact.",
        }
        throw error
      } finally {
        await this.finishTerminalTrial(trial, [trial.previous.runtimeID])
      }
      return { action: "rollback", changed: true, status: this.status() }
    }

    if (
      reason === "explicit" &&
      caller !== trial.candidate
    ) {
      fail(
        "OXP_HANDLE_STALE",
        "Only the active candidate runtime can roll back this trial.",
      )
    }

    const store = this.artifactStore
    if (!store) {
      fail(
        "OXP_DEPENDENCY_UNAVAILABLE",
        "The OXP runtime artifact store is unavailable during rollback.",
      )
    }
    this.assertCurrentCaller(caller)
    if (trial.orphaned) {
      fail(
        "OXP_DEPENDENCY_UNAVAILABLE",
        "Rollback already failed once; the recovered candidate is serving only until its bounded recovery grace expires.",
      )
    }

    try {
      await trial.candidate.module.OxpHost.dispose()
    } catch (disposeError) {
      this.markNotServing(trial.candidate)
      trial.candidate.module.OxpRuntimeRefresh.install(undefined)
      this.lastTransition = {
        trialID,
        outcome: "failed",
        at: this.now(),
        detail:
          "The candidate runtime could not be retired safely; runtime state is degraded and restart is required.",
      }
      const accepted = await store.accepted().catch(() => undefined)
      if (accepted?.runtimeID === trial.previous.runtimeID) {
        await store
          .restore(accepted.snapshotPath, accepted.runtimeID)
          .catch(() => undefined)
      }
      await this.finishTerminalTrial(trial, [trial.previous.runtimeID])
      throw disposeError
    }

    this.markNotServing(trial.candidate)
    this.clearTrialTimers(trial)

    let previousState: SidecarOxpState | undefined
    try {
      const accepted = await store.accepted()
      if (!accepted || accepted.runtimeID !== trial.previous.runtimeID) {
        fail(
          "OXP_CONFLICT",
          "The durable accepted OXP checkpoint no longer matches the previous runtime.",
        )
      }
      await store.restore(accepted.snapshotPath, accepted.runtimeID).catch(failArtifact)
      const restored = await trial.previous.module.OxpHost.restore()
      await this.validateRestoredState(restored, trial.connectorID)
      await this.probe(restored)
      await this.transitionBackendTo(trial.previous)
      this.activateRecord(trial.previous)
      previousState = restored
    } catch {
      this.markNotServing(trial.previous)
    }

    if (previousState) {
      try {
        await this.publish(previousState)
      } catch (publishError) {
        this.lastTransition = {
          trialID,
          outcome: "failed",
          at: this.now(),
          detail:
            "The previous runtime was restored but host publication failed; restart is required to reconcile endpoint discovery.",
        }
        trial.candidate.module.OxpRuntimeRefresh.install(undefined)
        await this.finishTerminalTrial(trial, [trial.previous.runtimeID])
        throw publishError
      }

      trial.candidate.module.OxpRuntimeRefresh.install(undefined)
      this.lastTransition = {
        trialID,
        outcome: "reverted",
        at: this.now(),
        detail:
          reason === "deadline"
            ? "The candidate was not accepted before its deadline."
            : "The candidate was explicitly rolled back.",
      }
      await this.finishTerminalTrial(trial, [trial.previous.runtimeID])
      this.log("warn", "OXP runtime trial rolled back", {
        trialID,
        reason,
        runtimeID: trial.previous.runtimeID,
      })
      return { action: "rollback", changed: true, status: this.status() }
    }

    // Availability beats a false rollback claim. The candidate had already
    // passed readiness before this rollback began, so try to re-establish it,
    // but never claim it until artifact restore + endpoint restore + probe pass.
    let candidateState: SidecarOxpState
    try {
      await store
        .restore(trial.candidateSnapshot, trial.candidate.runtimeID)
        .catch(failArtifact)
      candidateState = await trial.candidate.module.OxpHost.restore()
      await this.validateRestoredState(candidateState, trial.connectorID)
      await this.probe(candidateState)
      await this.transitionBackendTo(trial.candidate)
      this.activateRecord(trial.candidate)
    } catch (candidateError) {
      this.markNotServing(trial.candidate)
      trial.candidate.module.OxpRuntimeRefresh.install(undefined)
      this.lastTransition = {
        trialID,
        outcome: "failed",
        at: this.now(),
        detail:
          "Neither the previous nor candidate OXP runtime could be restored; restart is required.",
      }
      await this.finishTerminalTrial(trial, [trial.previous.runtimeID])
      throw candidateError
    }

    try {
      await this.publish(candidateState)
    } catch (publishError) {
      this.markNotServing(trial.candidate)
      await trial.candidate.module.OxpHost.dispose().catch(() => undefined)
      trial.candidate.module.OxpRuntimeRefresh.install(undefined)
      this.lastTransition = {
        trialID,
        outcome: "failed",
        at: this.now(),
        detail:
          "The candidate runtime recovered but host publication failed; restart is required.",
      }
      await this.finishTerminalTrial(trial, [trial.previous.runtimeID])
      throw publishError
    }

    trial.phase = "active"
    trial.activationAt = trial.candidate.activatedAt
    this.armOrphanExpiry(trial)
    this.lastTransition = {
      trialID,
      outcome: "failed",
      at: this.now(),
      detail:
        "Rollback failed; the candidate runtime was restored temporarily and remains unaccepted during a bounded recovery grace.",
    }
    throw new RefreshError(
      "OXP_DEPENDENCY_UNAVAILABLE",
      "The previous OXP runtime could not be restored; the candidate is temporarily active and unaccepted.",
    )
  }

  private requireTrial(trialID: string) {
    const trial = this.trial
    if (!trial || trial.id !== trialID) {
      fail(
        "OXP_HANDLE_STALE",
        "The OXP runtime refresh trial is no longer current.",
      )
    }
    return trial
  }

  private clearTrialTimers(trial: Trial | undefined) {
    if (!trial) return
    if (trial.armTimer) clearTimeout(trial.armTimer)
    if (trial.activationTimer) clearTimeout(trial.activationTimer)
    if (trial.acceptTimer) clearTimeout(trial.acceptTimer)
    trial.armTimer = undefined
    trial.activationTimer = undefined
    trial.acceptTimer = undefined
  }
}
