import { test } from "bun:test"
import { Database as Native } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { OxpActivity } from "@opencode-ai/core/oxp-activity/activity"
import { OxpActivityInspection } from "@opencode-ai/core/oxp-activity/inspection"
import { Global } from "@opencode-ai/core/global"
import { sqliteBusyCode } from "@opencode-ai/core/database/sqlite-busy"
import { OxpActivityIdentity } from "@/oxp/activity-identity"
import { OxpActivityRecorder } from "@/oxp/activity-recorder"
import { OxpDiagnostics } from "@/oxp/diagnostics"

const fakeIdentity = Layer.succeed(
  OxpActivityIdentity.Service,
  OxpActivityIdentity.Service.of({
    pseudonymize: (correlation) =>
      Effect.succeed({
        scheme: correlation.scheme,
        digest: "digest:" + Buffer.from(correlation.scheme + "\0" + correlation.value).toString("base64url"),
        scope: correlation.scope,
      }),
  }),
)

const correlation = (value: string) =>
  ({ scheme: "openai/session", value, scope: "conversation" }) as const

function incidentSummary(incident: ReturnType<typeof OxpDiagnostics.list>[number]) {
  return {
    phase: incident.phase,
    activityOperation: incident.activityOperation,
    errorName: incident.errorName,
    errorCode: incident.errorCode,
  }
}

function newIncidents(from: number) {
  return OxpDiagnostics.list({ limit: 20 })
    .slice()
    .reverse()
    .filter((incident) => incident.at >= from)
    .map(incidentSummary)
}

test("probe: recorder link failures under real file-backed WAL contention", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openfork-oxp-recorder-probe-"))
  const filename = join(dir, "recorder.sqlite")
  let probeExit: Exit.Exit<unknown, unknown> | undefined
  let cleanup: string
  try {
    const graph = AppNodeBuilder.build(
      LayerNode.group([Database.node, OxpActivity.node, OxpActivityRecorder.node, OxpActivityInspection.node]),
      [
        [Database.node, Database.layerFromPath(filename)],
        [Global.node, Global.layerWith({ config: join(dir, "config"), state: join(dir, "state") })],
        [OxpActivityIdentity.node, fakeIdentity],
      ],
    )

    probeExit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const recorder = yield* OxpActivityRecorder.Service
            const activity = yield* OxpActivity.Service
            const inspection = yield* OxpActivityInspection.Service

            // ---- Stage 1: busy contention held BEYOND the 450ms recorder budget
            const busyInput = {
              parentCorrelation: correlation("probe-busy-beyond"),
              tool: "openfork_worker",
              args: { action: "status", workerID: "wrk_busy" },
            } as const
            const busyHandle = yield* recorder.begin(busyInput)
            const busyPeer = new Native(filename)
            busyPeer.exec("BEGIN IMMEDIATE")
            const busyReleased = { done: false }
            const busyTimer = setTimeout(() => {
              busyPeer.exec("COMMIT")
              busyReleased.done = true
            }, 1200)
            const busyStart = Date.now()
            const busyAt = performance.now()
            yield* recorder.success(busyHandle, busyInput, { structured: { workerID: "wrk_busy" } })
            const busyElapsed = performance.now() - busyAt
            clearTimeout(busyTimer)
            if (!busyReleased.done) busyPeer.exec("COMMIT")
            console.log(
              "STAGE_BUSY",
              JSON.stringify({ elapsedMs: Math.round(busyElapsed), incidents: newIncidents(busyStart) }),
            )
            busyPeer.close()

            // ---- Stage 2: delayed writer release WITHIN the retry budget recovers silently
            const recoverInput = {
              parentCorrelation: correlation("probe-busy-recover"),
              tool: "openfork_worker",
              args: { action: "status", workerID: "wrk_recover" },
            } as const
            const recoverHandle = yield* recorder.begin(recoverInput)
            const recoverPeer = new Native(filename)
            recoverPeer.exec("BEGIN IMMEDIATE")
            const recoverReleased = { done: false }
            const recoverTimer = setTimeout(() => {
              recoverPeer.exec("COMMIT")
              recoverReleased.done = true
            }, 280)
            const recoverStart = Date.now()
            const recoverAt = performance.now()
            yield* recorder.success(recoverHandle, recoverInput, { structured: { workerID: "wrk_recover" } })
            const recoverElapsed = performance.now() - recoverAt
            clearTimeout(recoverTimer)
            if (!recoverReleased.done) recoverPeer.exec("COMMIT")
            const recoverPage = yield* inspection.invocations({ activityID: recoverHandle.activityID })
            console.log(
              "STAGE_RECOVER",
              JSON.stringify({
                elapsedMs: Math.round(recoverElapsed),
                status: recoverPage.items[0]?.status,
                incidents: newIncidents(recoverStart),
              }),
            )
            recoverPeer.close()

            // ---- Stage 3: stale invocation FK failure (non-retryable, immediate)
            const staleInput = {
              parentCorrelation: correlation("probe-stale-fk"),
              tool: "openfork_worker",
              args: { action: "status", workerID: "wrk_stale" },
            } as const
            const staleHandle = yield* recorder.begin(staleInput)
            yield* activity.deleteHistory(staleHandle.activityID)
            const staleStart = Date.now()
            const staleAt = performance.now()
            yield* recorder.success(staleHandle, staleInput, { structured: { workerID: "wrk_stale" } })
            const staleElapsed = performance.now() - staleAt
            console.log(
              "STAGE_STALE",
              JSON.stringify({ elapsedMs: Math.round(staleElapsed), incidents: newIncidents(staleStart) }),
            )

            // ---- Stage 4: capture genuine defects directly and run PRODUCTION classifiers
            const captureHandle = yield* activity.begin({
              correlation: { scheme: "mcp-session-id", digest: "probe-capture-busy", scope: "unknown" },
              hostRunID: "host-probe",
              plane: "augmentation",
              tool: "read",
            })
            const capturePeer = new Native(filename)
            capturePeer.exec("BEGIN IMMEDIATE")
            const busyExit = yield* Effect.exit(
              activity.linkMany([
                { invocationID: captureHandle.invocationID, kind: "root", ref: "probe-root", relation: "target" },
              ]),
            )
            capturePeer.exec("ROLLBACK")
            capturePeer.close()
            const busyDefect = Exit.isFailure(busyExit) ? Cause.squash(busyExit.cause) : undefined
            console.log(
              "CAPTURE_BUSY",
              JSON.stringify({
                defectTag: busyDefect && ((busyDefect as any)._tag ?? (busyDefect as any).constructor?.name),
                sqliteBusyCode: sqliteBusyCode(busyDefect),
                sqliteIncidentCode: OxpDiagnostics.sqliteIncidentCode(busyDefect),
              }),
            )

            const staleCapture = yield* activity.begin({
              correlation: { scheme: "mcp-session-id", digest: "probe-capture-stale", scope: "unknown" },
              hostRunID: "host-probe",
              plane: "augmentation",
              tool: "read",
            })
            yield* activity.deleteHistory(staleCapture.activityID)
            const fkExit = yield* Effect.exit(
              activity.linkMany([
                { invocationID: staleCapture.invocationID, kind: "root", ref: "probe-root", relation: "target" },
              ]),
            )
            const fkDefect = Exit.isFailure(fkExit) ? Cause.squash(fkExit.cause) : undefined
            console.log(
              "CAPTURE_FK",
              JSON.stringify({
                defectTag: fkDefect && ((fkDefect as any)._tag ?? (fkDefect as any).constructor?.name),
                sqliteBusyCode: sqliteBusyCode(fkDefect),
                sqliteIncidentCode: OxpDiagnostics.sqliteIncidentCode(fkDefect),
              }),
            )
          }).pipe(Effect.provide(graph)),
        ),
      ),
    )
  } finally {
    if (probeExit && Exit.isFailure(probeExit)) {
      const squashed = Cause.squash(probeExit.cause)
      const safe = {
        tag: (squashed as any)?._tag ?? (squashed as any)?.constructor?.name ?? typeof squashed,
        message: (() => {
          const message = (squashed as any)?.message
          if (typeof message !== "string") return undefined
          const clean = message.replace(/[\r\n\t]+/g, " ").slice(0, 160)
          return /(?:select|insert|update|delete|from|where|values)/i.test(clean) ? "[sql-like]" : clean
        })(),
      }
      console.log("PROBE_EXIT FAILURE", JSON.stringify(safe))
      console.log("PROBE_CAUSE_TAGS", JSON.stringify(Cause.prettyErrors(probeExit.cause).map((error) => (error as any)?._tag ?? (error as any)?.name ?? "err").slice(0, 6)))
    } else {
      console.log("PROBE_EXIT SUCCESS")
    }
    const rmAt = performance.now()
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 })
      cleanup = "ok_ms=" + Math.round(performance.now() - rmAt)
    } catch (error) {
      cleanup = "FAILED code=" + ((error as NodeJS.ErrnoException).code ?? "unknown") + " ms=" + Math.round(performance.now() - rmAt)
    }
    console.log("CLEANUP", cleanup)
  }
}, 60_000)
