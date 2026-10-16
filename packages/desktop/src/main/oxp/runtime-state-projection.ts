import type { SidecarOxpState } from "../sidecar-protocol"

type RuntimeOwner = object

type OwnerRevision = {
  generation: number
  configRevision: number
}

/**
 * Runtime modules can be imported more than once in a sidecar during OXP
 * refresh. Their endpoint counters restart at one, while Electron's endpoint
 * fence intentionally spans the whole sidecar lifetime. This projection
 * restores that process-wide monotonicity and rejects late snapshots from a
 * runtime that no longer owns the serving endpoint.
 */
export class OxpRuntimeStateProjection {
  private readonly revisions = new WeakMap<RuntimeOwner, OwnerRevision>()
  private generation = 0
  private readyOwner: RuntimeOwner | undefined
  private readyIdentity: string | undefined

  project(
    owner: RuntimeOwner,
    activeOwner: RuntimeOwner | undefined,
    state: SidecarOxpState,
  ): SidecarOxpState | undefined {
    if (owner !== activeOwner) return undefined

    const localGeneration = state.endpoint.generation ?? 0
    const previous = this.revisions.get(owner)
    if (
      previous &&
      (state.configRevision < previous.configRevision ||
        localGeneration < previous.generation)
    ) {
      return undefined
    }
    this.revisions.set(owner, {
      generation: localGeneration,
      configRevision: state.configRevision,
    })

    const endpoint = state.endpoint
    if (
      endpoint.state === "ready" &&
      endpoint.generation !== undefined &&
      endpoint.url
    ) {
      const identity = `${endpoint.generation}:${endpoint.url}:${endpoint.schemaFingerprint ?? ""}`
      if (owner !== this.readyOwner || identity !== this.readyIdentity) {
        this.generation += 1
        this.readyOwner = owner
        this.readyIdentity = identity
      }
    } else if (owner === this.readyOwner) {
      this.readyOwner = undefined
      this.readyIdentity = undefined
    }

    return {
      ...state,
      endpoint: {
        ...endpoint,
        ...(this.generation > 0 ? { generation: this.generation } : {}),
      },
    }
  }
}
