export type EndpointGenerationInput = {
  state: "stopped" | "ready" | "error"
  generation?: number
  url?: string
  schemaFingerprint?: string
}

/**
 * Sidecar endpoint generations are process-local. The desktop owns the process
 * replacement boundary, so it lifts them into one monotonic desktop generation
 * before projecting state or associating async tunnel work with an endpoint.
 */
export class OxpEndpointGenerationTracker {
  private identity: string | undefined
  private generation = 0
  private epoch = 0
  private sidecarGeneration = 0
  private configRevision = 0

  attach(sidecarEpoch: number) {
    this.epoch = sidecarEpoch
    this.sidecarGeneration = 0
    this.configRevision = 0
    this.identity = undefined
  }

  observe(
    sidecarEpoch: number,
    endpoint: EndpointGenerationInput,
    configRevision = 0,
  ): { readonly accepted: boolean; readonly generation?: number; readonly changed: boolean } {
    // Epochs are desktop-owned and monotonically increase whenever the utility
    // sidecar is replaced. A delayed event from an older process must not be
    // allowed to roll this tracker backward and become authoritative again.
    if (sidecarEpoch < this.epoch) return { accepted: false, changed: false }
    if (sidecarEpoch > this.epoch) this.attach(sidecarEpoch)
    const localGeneration = endpoint.generation ?? 0
    if (configRevision < this.configRevision || localGeneration < this.sidecarGeneration) {
      return { accepted: false, changed: false }
    }
    this.configRevision = configRevision
    this.sidecarGeneration = localGeneration
    if (endpoint.state !== "ready" || endpoint.generation === undefined || !endpoint.url) {
      const changed = this.identity !== undefined
      this.identity = undefined
      return { accepted: true, changed }
    }
    // A connector tool schema is part of endpoint identity even when the
    // loopback route/generation is reused. Treat schema changes as endpoint
    // replacement so the existing tunnel retirement/reconnect path forces
    // external MCP clients to rediscover tools instead of retaining a stale
    // materialized function signature.
    const identity = `${sidecarEpoch}:${endpoint.generation}:${endpoint.url}:${endpoint.schemaFingerprint ?? ""}`
    const changed = identity !== this.identity
    if (changed) {
      this.identity = identity
      this.generation += 1
    }
    return { accepted: true, generation: this.generation, changed }
  }

  detach() {
    this.identity = undefined
  }

  current() {
    return this.generation
  }
}
