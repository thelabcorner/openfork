import type { UsageSessionContextResponse } from "@opencode-ai/sdk/v2/client"
import type { Info as SessionTelemetryInfo } from "@opencode-ai/schema/session-telemetry"
import { ContextOccupancy } from "@opencode-ai/core/session/context-occupancy"

export type SessionContextOccupancy = ContextOccupancy.Footprint

// The generated V2 client can lag the shared schema during a rolling source
// update. SessionTelemetry.Info is the authoritative producer contract; retain
// the generated route shape while admitting fields already present on the
// server/schema surface.
export type SessionContextTelemetry = NonNullable<UsageSessionContextResponse["telemetry"]> &
  Pick<SessionTelemetryInfo, "sampledAt">
type SessionContextHistory = UsageSessionContextResponse["history"]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const looksLikeHistory = (value: unknown): value is SessionContextHistory =>
  isRecord(value) &&
  typeof value.sessionID === "string" &&
  Array.isArray(value.models) &&
  isRecord(value.totals) &&
  isRecord(value.breakdown)

/**
 * Accept the current wrapped server projection and the immediately previous
 * bare-history response shape.
 *
 * Desktop/server upgrades are not atomic: an already-running server can briefly
 * outlive a renderer HMR/update. Keeping this compatibility at the fetch
 * boundary prevents version skew from leaking into every Context-pane consumer.
 */
export function normalizeSessionContextResponse(value: unknown): UsageSessionContextResponse {
  if (!isRecord(value)) throw new Error("Invalid session context response")

  if (looksLikeHistory(value.history)) return value as UsageSessionContextResponse

  if (looksLikeHistory(value)) {
    return {
      history: value,
      telemetry: null,
    } as unknown as UsageSessionContextResponse
  }

  throw new Error("Invalid session context response")
}

/**
 * Reconcile the telemetry bundled with the projection request against the
 * independently streamed telemetry store.
 *
 * The event stream can legitimately lag a just-completed HTTP snapshot during
 * reconnect/hydration. Never let an older client watermark overwrite fresher
 * server truth merely because it happens to be present locally.
 */
export function newestSessionContextTelemetry(
  snapshot: SessionContextTelemetry | null | undefined,
  streamed: SessionContextTelemetry | undefined,
): SessionContextTelemetry | undefined {
  if (!snapshot) return streamed
  if (!streamed) return snapshot
  if (streamed.updatedAt !== snapshot.updatedAt) return streamed.updatedAt > snapshot.updatedAt ? streamed : snapshot

  // The producer can emit multiple states inside one Date.now() millisecond.
  // sampledAt is the projection-materialization watermark and therefore breaks
  // ties without consulting renderer wall time.
  if (streamed.sampledAt === undefined) return snapshot
  if (snapshot.sampledAt === undefined) return streamed
  return streamed.sampledAt > snapshot.sampledAt ? streamed : snapshot
}

/**
 * Project the latest provider-reported context footprint.
 *
 * Live/persisted SessionTelemetry is authoritative when available. Historical
 * sessions created before telemetry backfill fall back to Usage's indexed latest
 * settled-generation scalar. Neither path depends on client transcript pages.
 */
export function projectSessionContextOccupancy(
  snapshot: UsageSessionContextResponse | undefined,
): SessionContextOccupancy | undefined {
  return ContextOccupancy.project(snapshot)
}
