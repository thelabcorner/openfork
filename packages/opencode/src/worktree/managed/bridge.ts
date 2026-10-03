import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ManagedWorktreeBinding } from "@opencode-ai/core/managed-worktree-binding"
import { Context, Effect, Layer } from "effect"
import path from "node:path"
import { serviceDiscoveryDirectory } from "@/server/service-discovery"
import { instanceIdentity, serviceRealmID } from "@/server/shared/instance-identity"
import {
  ManagedWorktreeCapability,
  WORKTREE_STORE_CONTROL_PLANE_ROOT_ENV,
  WORKTREE_STORE_DISCOVERY_DIR_ENV,
  type ManagedManagerDescriptor,
  type ResolutionOptions,
} from "./capability"
import { ManagedWorktreeManager, type Error as ManagedError } from "./client"
import {
  FenceConfigError,
  openForkActivityFenceAuthorization,
  provisionOpenForkActivityFenceConfig,
} from "./fence-config"
import type { ManagedCreateInitializeInput } from "./request"
import type { ManagedCreateInitializeResult } from "./protocol"

/**
 * Narrow managed-worktree activation seam (G4/G5 bridge).
 *
 * This is the caller-facing boundary that decides whether the managed path may
 * run *at all*. It is fail-closed in the strict sense: every precondition that
 * cannot be positively proven resolves to `unmanaged`, so callers keep the
 * existing unmanaged worktree path and no managed side effect is attempted.
 *
 * The bridge deliberately owns no worktree lifecycle state. Durable binding
 * authority (creation intent, activation, reconciliation, retirement) belongs
 * to `ManagedWorktreeBinding`; this seam only composes it:
 *
 *   recordCreationIntent -> managed-create-initialize -> activate
 *
 * with `markReconcileRequired` on any manager failure. A directory is never
 * exposed as managed unless the binding authority reports `active`.
 *
 * The managed path is only `ready` when:
 * 1. the packaged/staged sidecar capability resolves (root, CLI, handshake);
 * 2. the sidecar advertises the exact wired activity-fence adapter;
 * 3. an explicit OpenFork service-discovery directory exists (default:
 *    `Global.Path.state/service-discovery`, overridable for tests and
 *    non-standard installs);
 * 4. an explicit worktree-store control-plane root exists;
 * 5. the activity-fence config for *this launch's* identity and credentials is
 *    safely provisioned (or already byte-identical).
 */
export const ACTIVATION_REASONS = Object.freeze([
  "capability-unavailable",
  "fence-adapter-not-wired",
  "discovery-directory-missing",
  "control-plane-root-missing",
  "fence-config-unavailable",
  "binding-conflict",
  "binding-rejected",
  "binding-not-activated",
] as const)

export type ActivationReason = (typeof ACTIVATION_REASONS)[number]

export interface UnmanagedActivation {
  readonly state: "unmanaged"
  readonly reason: ActivationReason
  readonly detail: string
}

export interface ReadyActivation {
  readonly state: "ready"
  readonly descriptor: ManagedManagerDescriptor
  readonly controlPlaneRoot: string
  readonly discoveryDirectory: string
  readonly fenceConfigFile: string
  readonly fenceConfigState: "written" | "unchanged"
}

export type ManagedActivation = UnmanagedActivation | ReadyActivation

export interface ActivationOptions {
  readonly capability?: ResolutionOptions
  readonly controlPlaneRoot?: string
  readonly discoveryDirectory?: string
  readonly env?: Record<string, string | undefined>
}

/** Caller-owned facts the durable binding authority needs for one creation. */
export interface BindingIdentity {
  readonly directory: string
  readonly installationId: string
  readonly projectId: string
  readonly workspaceId?: string | null
}

export type ManagedCreateOutcome =
  | UnmanagedActivation
  | {
      readonly state: "created"
      readonly activation: ReadyActivation
      readonly binding: ManagedWorktreeBinding.BindingView
      readonly result: ManagedCreateInitializeResult
    }

export interface Interface {
  readonly resolveActivation: (options?: ActivationOptions) => Effect.Effect<ManagedActivation>
  readonly createManagedWorktree: (
    options: ActivationOptions & {
      readonly request: ManagedCreateInitializeInput
      readonly binding: BindingIdentity
    },
  ) => Effect.Effect<ManagedCreateOutcome, ManagedWorktreeBinding.Error | ManagedError>
  /** Durable binding view for a directory; never implies authority. */
  readonly binding: (directory: string) => Effect.Effect<ManagedWorktreeBinding.BindingView | undefined, ManagedWorktreeBinding.Error>
  /** Exposure gate: only an `active` binding may be loaded as managed. */
  readonly requireActiveBinding: (
    directory: string,
  ) => Effect.Effect<ManagedWorktreeBinding.ActiveLookup, ManagedWorktreeBinding.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ManagedWorktreeBridge") {}

function unmanaged(reason: ActivationReason, detail: string): UnmanagedActivation {
  return Object.freeze({ state: "unmanaged" as const, reason, detail })
}

function describeManagedError(error: ManagedError): string {
  const code = "code" in error && typeof error.code === "string" ? error.code : error._tag
  const message = "message" in error && typeof error.message === "string" ? error.message : ""
  return message.length === 0 ? code : `${code}: ${message}`
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const capability = yield* ManagedWorktreeCapability.Service
    const manager = yield* ManagedWorktreeManager.Service
    const bindings = yield* ManagedWorktreeBinding.Service

    const resolveActivation = Effect.fn("ManagedWorktreeBridge.resolveActivation")(function* (
      options: ActivationOptions = {},
    ) {
      const env = options.env ?? process.env
      const resolved = yield* capability.resolve(options.capability ?? {}).pipe(
        Effect.match({
          onFailure: (error) => ({
            kind: "unmanaged" as const,
            activation: unmanaged("capability-unavailable", describeManagedError(error)),
          }),
          onSuccess: (descriptor) => ({ kind: "descriptor" as const, descriptor }),
        }),
      )
      if (resolved.kind === "unmanaged") return resolved.activation
      const descriptor = resolved.descriptor

      if (!descriptor.fenceAdapter.fenceReady) {
        return unmanaged(
          "fence-adapter-not-wired",
          "the managed sidecar does not advertise the wired openfork-http-directory-activity-fence adapter.",
        )
      }

      const configuredDiscovery = options.discoveryDirectory ?? env[WORKTREE_STORE_DISCOVERY_DIR_ENV]
      if (configuredDiscovery !== undefined && configuredDiscovery.length > 0 && !path.isAbsolute(configuredDiscovery)) {
        return unmanaged(
          "discovery-directory-missing",
          "the OpenFork service-discovery directory override must be an absolute path.",
        )
      }
      const discoveryDirectory = path.resolve(configuredDiscovery ?? serviceDiscoveryDirectory())
      if (!(yield* fs.isDir(discoveryDirectory))) {
        return unmanaged(
          "discovery-directory-missing",
          `the OpenFork service-discovery directory does not exist: ${discoveryDirectory}.`,
        )
      }

      const controlPlaneValue = options.controlPlaneRoot ?? env[WORKTREE_STORE_CONTROL_PLANE_ROOT_ENV]
      if (controlPlaneValue === undefined || controlPlaneValue.length === 0) {
        return unmanaged(
          "control-plane-root-missing",
          `no worktree-store control-plane root is configured; set ${WORKTREE_STORE_CONTROL_PLANE_ROOT_ENV} or provide an explicit root.`,
        )
      }
      const controlPlaneRoot = path.resolve(controlPlaneValue)

      const authorization = openForkActivityFenceAuthorization(env)
      const provisioned = yield* provisionOpenForkActivityFenceConfig(fs, {
        controlPlaneRoot,
        discoveryDirectory,
        config: {
          configVersion: 1,
          expectedInstanceID: instanceIdentity().instanceID,
          expectedRealmID: serviceRealmID(),
          ...(authorization === undefined ? {} : { authorization }),
        },
      }).pipe(
        Effect.catch((error: FenceConfigError) =>
          Effect.succeed(unmanaged("fence-config-unavailable", `${error.code}: ${error.message}`)),
        ),
      )
      if (provisioned.state === "unmanaged") return provisioned

      return Object.freeze({
        state: "ready" as const,
        descriptor,
        controlPlaneRoot,
        discoveryDirectory,
        fenceConfigFile: provisioned.file,
        fenceConfigState: provisioned.state,
      })
    })

    const createManagedWorktree = Effect.fn("ManagedWorktreeBridge.createManagedWorktree")(function* (
      options: ActivationOptions & {
        readonly request: ManagedCreateInitializeInput
        readonly binding: BindingIdentity
      },
    ) {
      const activation = yield* resolveActivation(options)
      if (activation.state === "unmanaged") return activation
      const request = options.request

      const recorded = yield* bindings.recordCreationIntent({
        directory: options.binding.directory,
        installationId: options.binding.installationId,
        repositoryId: request.repositoryId,
        worktreeId: request.worktreeId,
        storageVolumeId: request.storageVolumeId,
        projectId: options.binding.projectId,
        ...(options.binding.workspaceId === undefined ? {} : { workspaceId: options.binding.workspaceId }),
        branchRef: `refs/heads/${request.branchName}`,
        pinRef: `refs/worktree-store/pins/${request.worktreeId}`,
      })
      if (recorded.state === "duplicate") {
        return unmanaged(
          "binding-conflict",
          `a durable managed-worktree binding already exists for this directory or identity (state ${recorded.binding.bindingState}).`,
        )
      }
      const generation = recorded.binding.generation

      // Any manager failure leaves durable reconcile-required evidence instead
      // of an ambiguous handoff; the typed failure still propagates.
      const result = yield* manager
        .createInitialize({
          executable: activation.descriptor.executable,
          request,
          controlPlaneRoot: activation.controlPlaneRoot,
          discoveryDirectory: activation.discoveryDirectory,
        })
        .pipe(
          Effect.tapError((error) =>
            bindings
              .markReconcileRequired({
                directory: options.binding.directory,
                expectedGeneration: generation,
                reason: `managed-create-initialize failed: ${describeManagedError(error)}`,
              })
              .pipe(Effect.ignore),
          ),
        )

      const operationId =
        result.createOperationId ??
        result.initializationOperationId ??
        `managed-create:${result.worktreeId}:${result.revision}`
      const activated = yield* bindings.activate({
        directory: options.binding.directory,
        expectedGeneration: generation,
        operationId,
        observation: {
          installationId: options.binding.installationId,
          repositoryId: request.repositoryId,
          worktreeId: result.worktreeId,
          storageVolumeId: result.storageVolumeId,
          targetPath: result.targetPath,
          pathKey: result.pathKey,
          ownership: result.ownership,
          lifecycleState: result.lifecycleState,
          durabilityClass: result.durabilityClass,
          revision: result.revision,
          head: result.head,
          branchRef: result.branchRef,
          pinRef: result.pinRef,
          createOperationId: result.createOperationId,
          initializationOperationId: result.initializationOperationId,
        },
      })
      if (activated.state !== "activated") {
        const detail =
          activated.state === "stale"
            ? "the durable binding changed generation before activation; no managed handoff was recorded."
            : `the durable binding did not activate (${activated.state}: ${activated.reason}).`
        return unmanaged("binding-not-activated", detail)
      }

      return Object.freeze({
        state: "created" as const,
        activation,
        binding: activated.binding,
        result,
      })
    })

    const binding = Effect.fn("ManagedWorktreeBridge.binding")(function* (directory: string) {
      return yield* bindings.get(directory)
    })

    const requireActiveBinding = Effect.fn("ManagedWorktreeBridge.requireActiveBinding")(function* (
      directory: string,
    ) {
      return yield* bindings.requireActive(directory)
    })

    return Service.of({ resolveActivation, createManagedWorktree, binding, requireActiveBinding })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [FSUtil.node, ManagedWorktreeCapability.node, ManagedWorktreeManager.node, ManagedWorktreeBinding.node],
})

export * as ManagedWorktreeBridge from "./bridge"
