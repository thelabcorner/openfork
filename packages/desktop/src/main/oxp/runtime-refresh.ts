import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type {
  SidecarLegacyImport,
  SidecarOxpGrant,
  SidecarOxpState,
} from "../sidecar-protocol"
import {
  RuntimeArtifactError,
  RuntimeArtifactStore,
} from "./runtime-artifacts"

const DEFAULT_ACTIVATION_DELAY_MS = 750

export interface RuntimeStatus {
  readonly refreshable: boolean
  readonly state: "stable" | "scheduled" | "trial"
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
  activationTimer?: NodeJS.Timeout
  acceptTimer?: NodeJS.Timeout
}

export interface RuntimeRefreshCoordinatorOptions {
  readonly publish: (state: SidecarOxpState) => void | Promise<void>
  readonly probe: (state: SidecarOxpState) => Promise<void>
  readonly importModule?: (url: string) => Promise<unknown>
  readonly now?: () => number
  readonly activationDelayMs?: number
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
  private readonly artifactPath: string
  private readonly refreshable: boolean
  private readonly artifactStore: RuntimeArtifactStore | undefined
  private readonly publish: RuntimeRefreshCoordinatorOptions["publish"]
  private readonly probe: RuntimeRefreshCoordinatorOptions["probe"]
  private readonly importModule: NonNullable<
    RuntimeRefreshCoordinatorOptions["importModule"]
  >
  private readonly now: NonNullable<RuntimeRefreshCoordinatorOptions["now"]>
  private readonly activationDelayMs: number
  private readonly log: NonNullable<RuntimeRefreshCoordinatorOptions["log"]>
  private activationGeneration = 1
  private trial: Trial | undefined
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
    this.artifactPath = artifactPath
    this.refreshable = refreshable
    this.artifactStore = artifactStore
    this.publish = options.publish
    this.probe = options.probe
    this.importModule =
      options.importModule ??
      ((url) => import(/* @vite-ignore */ url))
    this.now = options.now ?? Date.now
    this.activationDelayMs =
      options.activationDelayMs ?? DEFAULT_ACTIVATION_DELAY_MS
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
    return this.active.module.OxpHost
  }

  status(): RuntimeStatus {
    const trial = this.trial
    return {
      refreshable: this.refreshable && !this.disposed,
      state:
        trial?.phase === "scheduled"
          ? "scheduled"
          : trial?.phase === "active"
            ? "trial"
            : "stable",
      runtimeID: this.active.runtimeID,
      activationGeneration: this.active.activationGeneration,
      activatedAt: this.active.activatedAt,
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
      ...(!this.refreshable
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

  accept(caller: RuntimeRecord, trialID: string) {
    return this.enqueue(() => this.acceptNow(caller, trialID))
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
    if (trial && this.artifactStore) {
      const accepted = await this.artifactStore.accepted().catch(() => undefined)
      if (accepted) {
        await this.artifactStore
          .restore(accepted.snapshotPath, accepted.runtimeID)
          .catch(() => undefined)
        await this.artifactStore
          .cleanup([accepted.runtimeID])
          .catch(() => undefined)
      }
      await this.artifactStore.release(trial.id).catch(() => undefined)
    }
  }

  private bind(record: RuntimeRecord) {
    record.module.OxpRuntimeRefresh.install({
      status: async () => this.status(),
      refresh: (input) => this.refresh(record, input),
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

      const snapshotted = await store.snapshotCurrent()
      if (snapshotted.runtimeID === this.active.runtimeID) {
        this.lastTransition = {
          trialID,
          outcome: "unchanged",
          at: this.now(),
        }
        await store.release(trialID)
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
      trial.activationTimer = setTimeout(() => {
        void this.enqueue(() => this.activateTrial(trialID)).catch(() => {
          this.log("error", "OXP runtime trial activation failed")
        })
      }, this.activationDelayMs)
      trial.activationTimer.unref?.()

      return { action: "refresh", changed: true, status: this.status() }
    } catch (error) {
      if (locked) await store.release(trialID).catch(() => undefined)
      failArtifact(error)
    }
  }

  private async activateTrial(trialID: string) {
    const trial = this.trial
    if (!trial || trial.id !== trialID || trial.phase !== "scheduled") return
    if (trial.activationTimer) clearTimeout(trial.activationTimer)
    trial.activationTimer = undefined

    try {
      await trial.previous.module.OxpHost.dispose()
      this.activateRecord(trial.candidate)
      const state = await trial.candidate.module.OxpHost.restore()
      await this.validateRestoredState(state, trial.connectorID)
      await this.probe(state)

      const now = this.now()
      trial.phase = "active"
      trial.activationAt = now
      trial.acceptBy = now + trial.acceptWithinMs
      await this.publish(state)
      trial.acceptTimer = setTimeout(() => {
        void this.enqueue(() =>
          this.rollbackNow(
            trial.candidate,
            trialID,
            "deadline",
          ),
        ).catch((error) => {
          this.log("error", "OXP runtime automatic rollback failed")
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
    record.activationGeneration = ++this.activationGeneration
    record.activatedAt = this.now()
    this.active = record
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
    const accepted = await store.accepted()
    if (!accepted || accepted.runtimeID !== trial.previous.runtimeID) {
      fail(
        "OXP_CONFLICT",
        "The durable accepted OXP checkpoint no longer matches the previous runtime.",
      )
    }
    await store.restore(accepted.snapshotPath, accepted.runtimeID).catch(failArtifact)
    this.activateRecord(trial.previous)
    try {
      const restored = await trial.previous.module.OxpHost.restore()
      await this.validateRestoredState(restored, trial.connectorID)
      await this.probe(restored)
      await this.publish(restored)
      this.lastTransition = {
        trialID: trial.id,
        outcome: "failed",
        at: this.now(),
        detail: "Candidate activation failed before publication.",
      }
      trial.candidate.module.OxpRuntimeRefresh.install(undefined)
      this.clearTrialTimers(trial)
      this.trial = undefined
      await store.release(trial.id).catch(() => undefined)
      await store.cleanup([trial.previous.runtimeID]).catch(() => undefined)
      this.log("warn", "OXP runtime trial rejected before publication", {
        trialID: trial.id,
      })
    } catch (restoreError) {
      this.lastTransition = {
        trialID: trial.id,
        outcome: "failed",
        at: this.now(),
        detail: "Candidate activation and previous-runtime restoration both failed.",
      }
      this.clearTrialTimers(trial)
      this.trial = undefined
      throw restoreError
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
    this.trial = undefined
    await store.release(trialID).catch(() => undefined)
    await store.cleanup([trial.candidate.runtimeID]).catch(() => undefined)
    this.log("info", "OXP runtime trial accepted", {
      trialID,
      runtimeID: this.active.runtimeID,
    })
    return { action: "accept", changed: true, status: this.status() }
  }

  private async rollbackNow(
    caller: RuntimeRecord,
    trialID: string,
    reason: "explicit" | "deadline",
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
      this.clearTrialTimers(trial)
      trial.candidate.module.OxpRuntimeRefresh.install(undefined)
      await trial.candidate.module.OxpHost.dispose().catch(() => undefined)
      const store = this.artifactStore
      if (!store) {
        fail(
          "OXP_DEPENDENCY_UNAVAILABLE",
          "The OXP runtime artifact store is unavailable during rollback.",
        )
      }
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
          reason === "deadline"
            ? "Refresh trial expired before activation."
            : "Refresh trial cancelled before activation.",
      }
      this.trial = undefined
      await store.release(trialID).catch(() => undefined)
      await store.cleanup([trial.previous.runtimeID]).catch(() => undefined)
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

    this.clearTrialTimers(trial)
    await trial.candidate.module.OxpHost.dispose()
    const store = this.artifactStore
    if (!store) {
      fail(
        "OXP_DEPENDENCY_UNAVAILABLE",
        "The OXP runtime artifact store is unavailable during rollback.",
      )
    }
    const accepted = await store.accepted()
    if (!accepted || accepted.runtimeID !== trial.previous.runtimeID) {
      fail(
        "OXP_CONFLICT",
        "The durable accepted OXP checkpoint no longer matches the previous runtime.",
      )
    }
    await store.restore(accepted.snapshotPath, accepted.runtimeID).catch(failArtifact)
    this.activateRecord(trial.previous)

    try {
      const restored = await trial.previous.module.OxpHost.restore()
      await this.validateRestoredState(restored, trial.connectorID)
      await this.probe(restored)
      await this.publish(restored)
    } catch (restoreError) {
      // Availability beats a false rollback claim. If the known-previous runtime
      // cannot be restored, attempt to put the already-probed candidate back.
      await store
        .restore(trial.candidateSnapshot, trial.candidate.runtimeID)
        .catch(() => undefined)
      this.activateRecord(trial.candidate)
      let candidateRestored = false
      try {
        const candidate = await trial.candidate.module.OxpHost.restore()
        await this.validateRestoredState(candidate, trial.connectorID)
        await this.probe(candidate)
        await this.publish(candidate)
        candidateRestored = true
        trial.phase = "active"
        trial.activationAt = this.active.activatedAt
        trial.acceptBy = undefined
        this.lastTransition = {
          trialID,
          outcome: "failed",
          at: this.now(),
          detail:
            "Rollback failed; the candidate runtime was restored to preserve OXP availability.",
        }
      } catch (candidateError) {
        this.lastTransition = {
          trialID,
          outcome: "failed",
          at: this.now(),
          detail:
            "Neither the previous nor candidate OXP runtime could be restored.",
        }
        this.trial = undefined
        throw candidateError instanceof RefreshError
          ? candidateError
          : restoreError
      }
      if (candidateRestored) {
        throw new RefreshError(
          "OXP_DEPENDENCY_UNAVAILABLE",
          "The previous OXP runtime could not be restored; the candidate remains active and unaccepted.",
        )
      }
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
    this.trial = undefined
    await store.release(trialID).catch(() => undefined)
    await store.cleanup([trial.previous.runtimeID]).catch(() => undefined)
    this.log("warn", "OXP runtime trial rolled back", {
      trialID,
      reason,
      runtimeID: this.active.runtimeID,
    })
    return { action: "rollback", changed: true, status: this.status() }
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
    if (trial.activationTimer) clearTimeout(trial.activationTimer)
    if (trial.acceptTimer) clearTimeout(trial.acceptTimer)
    trial.activationTimer = undefined
    trial.acceptTimer = undefined
  }
}
