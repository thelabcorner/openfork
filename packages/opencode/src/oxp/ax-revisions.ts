/**
 * Deployment handshake for AX behavior that does NOT affect the static MCP
 * tool manifest fingerprint. Update this contract whenever corresponding
 * on-demand behavior changes. This is not an authorization/version gate.
 *
 * Frozen literals intentionally allow an older running OXP host to reveal
 * that it has not picked up checkout-only broker code.
 */
export const AX_IMPLEMENTATION = Object.freeze({
  capabilitySearch: "ranked-shared-v6-intent-scaffolding-abstention",
  schemaProjection: "guided-focus-null-preserving-v3-nested-project-workdir",
  activityPersistence: "isolated-350ms-sqlite-activity-lane-wrapper-diagnostics-v3",
  sessionSwarmReliability: "bound-profile-drift-guard-direct-tool-recall-v1",
  contractReplay: "owner-held-schema-digest-v1",
  transportStreaming: "bounded-backpressure-no-full-buffer-v1",
  timingDiagnostics: "lifetime-quantized-phase-latency-v1",
  transportBoundary: "generated-manifest-protocol-pagination-owner-v1",
  lazyHost: "single-owner-lean-listener-first-executable-activation-v1",
})

export * as OxpAxRevisions from "./ax-revisions"