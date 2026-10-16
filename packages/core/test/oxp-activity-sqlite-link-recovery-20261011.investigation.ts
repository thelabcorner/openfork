import { test } from "bun:test"
import { Database as Native } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit, Fiber } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { OxpActivity } from "../src/oxp-activity/activity"
import { sqliteBusyCode } from "../src/database/sqlite-busy"

const MAX_TEXT = 120
const SECRET = /(?:select|insert|update|delete|create|from|where|values)/i

function clip(value: string) {
  const clean = value.replace(/[\r\n\t]+/g, " ")
  return clean.length > MAX_TEXT ? clean.slice(0, MAX_TEXT) + "…" : clean
}

function tagOf(value: unknown) {
  if (!value || typeof value !== "object") return typeof value
  const node = value as Record<string, unknown>
  return (node._tag as string) ?? ((node.constructor as { name?: string } | undefined)?.name ?? "(anonymous)")
}

function safeNative(error: unknown) {
  if (!error || typeof error !== "object") return undefined
  const node = error as Record<string, unknown>
  const read = (key: string) => {
    try {
      return node[key]
    } catch {
      return undefined
    }
  }
  const out: Record<string, unknown> = {}
  for (const key of ["code", "errno", "errcode", "constraint"] as const) {
    const value = read(key)
    if (value !== undefined && (typeof value === "number" || typeof value === "string")) out[key] = value
  }
  const message = read("message")
  if (typeof message === "string" && !SECRET.test(message)) out.message = clip(message)
  return Object.keys(out).length > 0 ? out : undefined
}

/** Explicit production chain: EffectDrizzleQueryError > Cause.reasons[0] > SqlError > SqlErrorReason > native. */
function unwrap(defect: unknown) {
  const out: Record<string, unknown> = { top: tagOf(defect), topBusy: sqliteBusyCode(defect) }
  const cause = (defect as Record<string, unknown> | undefined)?.cause as Record<string, unknown> | undefined
  out.causeTag = tagOf(cause)
  const reasons = cause?.reasons as readonly unknown[] | undefined
  if (!Array.isArray(reasons) || reasons.length === 0) return out
  const fail = reasons[0] as Record<string, unknown>
  out.reason0 = tagOf(fail)
  const sqlError = fail.error as Record<string, unknown> | undefined
  out.sqlError = tagOf(sqlError)
  const sqlReason = sqlError?.reason as Record<string, unknown> | undefined
  out.sqlReason = tagOf(sqlReason)
  out.sqlReasonNative = safeNative(sqlReason?.cause)
  out.sqlReasonOperation = typeof sqlReason?.operation === "string" ? clip(sqlReason.operation) : undefined
  out.sqlReasonRetryable = typeof sqlReason?.isRetryable === "boolean" ? sqlReason.isRetryable : undefined
  out.bottomBusy = sqliteBusyCode(sqlReason?.cause)
  return out
}

test("probe: genuine linkMany failure chain under held writer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openfork-oxp-link-probe-"))
  const filename = join(dir, "probe.sqlite")
  let probeExit: Exit.Exit<unknown, unknown> | undefined
  try {
    const graph = AppNodeBuilder.build(
      LayerNode.group([Database.node, EventV2.node, OxpActivity.node]),
      [[Database.node, Database.layerFromPath(filename)]],
    )

    probeExit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const activity = yield* OxpActivity.Service
            const started = yield* activity.begin({
              correlation: { scheme: "mcp-session-id", digest: "probe-busy", scope: "unknown" },
              hostRunID: "host-probe",
              plane: "augmentation",
              tool: "read",
            })
            const peer = new Native(filename)
            peer.exec("BEGIN IMMEDIATE")
            let released = false
            const timer = setTimeout(() => {
              peer.exec("COMMIT")
              released = true
            }, 300)
            const startedAt = performance.now()
            const exit = yield* Effect.exit(
              activity.linkMany([{ invocationID: started.invocationID, kind: "root", ref: "root-1", relation: "target" }]),
            )
            const elapsed = performance.now() - startedAt
            clearTimeout(timer)
            if (!released) peer.exec("COMMIT")
            console.log("BUSY_LINK_EXIT", Exit.isFailure(exit) ? "FAILURE" : "SUCCESS", "elapsed_ms=" + elapsed.toFixed(1))
            if (Exit.isFailure(exit)) console.log("BUSY_UNWRAP", JSON.stringify(unwrap(Cause.squash(exit.cause))))

            const retry = yield* activity.linkMany([
              { invocationID: started.invocationID, kind: "root", ref: "root-1", relation: "target" },
            ]).pipe(Effect.exit)
            console.log("RELEASE_RETRY", Exit.isFailure(retry) ? "FAILURE" : "SUCCESS")
            const repeat = yield* activity.linkMany([
              { invocationID: started.invocationID, kind: "root", ref: "root-1", relation: "target" },
            ]).pipe(Effect.exit)
            console.log("REPEAT_IDEMPOTENT", Exit.isFailure(repeat) ? "FAILURE" : "SUCCESS")

            const stale = yield* activity.begin({
              correlation: { scheme: "mcp-session-id", digest: "probe-stale", scope: "unknown" },
              hostRunID: "host-probe",
              plane: "augmentation",
              tool: "read",
            })
            yield* activity.deleteHistory(stale.activityID)
            const fkExit = yield* Effect.exit(
              activity.linkMany([
                { invocationID: stale.invocationID, kind: "root", ref: "root-stale", relation: "target" },
              ]),
            )
            console.log("STALE_FK_EXIT", Exit.isFailure(fkExit) ? "FAILURE" : "SUCCESS")
            if (Exit.isFailure(fkExit)) console.log("STALE_UNWRAP", JSON.stringify(unwrap(Cause.squash(fkExit.cause))))

            const cancelPeer = new Native(filename)
            cancelPeer.exec("BEGIN IMMEDIATE")
            const fiber = yield* Effect.forkChild(
              activity.linkMany([
                { invocationID: started.invocationID, kind: "root", ref: "root-cancel", relation: "target" },
              ]),
            )
            yield* Effect.sleep("40 millis")
            const cancelExit = yield* Effect.exit(Fiber.interrupt(fiber))
            console.log("CANCEL_EXIT", Exit.isFailure(cancelExit) ? "FAILURE" : "SUCCESS", "causeTags=" + JSON.stringify(Exit.isFailure(cancelExit) ? cancelExit.cause.reasons?.map((reason) => tagOf(reason)) : []))
            cancelPeer.exec("ROLLBACK")
            cancelPeer.close()
            yield* Effect.sleep("20 millis")
            const afterCancel = yield* activity.linkMany([
              { invocationID: started.invocationID, kind: "root", ref: "root-cancel", relation: "target" },
            ]).pipe(Effect.exit)
            console.log("AFTER_CANCEL", Exit.isFailure(afterCancel) ? "FAILURE" : "SUCCESS")
            peer.close()

            const verifier = new Native(filename)
            const linkCount = verifier
              .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM oxp_invocation_link WHERE invocation_id = ?")
              .get(stale.invocationID)
            const orphan = verifier
              .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM oxp_invocation_link WHERE invocation_id NOT IN (SELECT id FROM oxp_invocation)")
              .get()
            const fkViolations = verifier.query("PRAGMA foreign_key_check").all()
            const busyRootLink = verifier
              .query<{ count: number }, [string, string]>("SELECT COUNT(*) AS count FROM oxp_invocation_link WHERE invocation_id = ? AND ref = ?")
              .get(started.invocationID, "root-1")
            const cancelLink = verifier
              .query<{ count: number }, [string, string]>("SELECT COUNT(*) AS count FROM oxp_invocation_link WHERE invocation_id = ? AND ref = ?")
              .get(started.invocationID, "root-cancel")
            verifier.close()
            console.log(
              "INTEGRITY",
              JSON.stringify({
                staleInvocationLinks: linkCount,
                orphanLinks: orphan,
                fkViolations: fkViolations.length,
                busyRootLinks: busyRootLink?.count,
                cancelLinks: cancelLink?.count,
              }),
            )
          }).pipe(Effect.provide(graph)),
        ),
      ),
    )
  } finally {
    if (probeExit && Exit.isFailure(probeExit)) {
      console.log("PROBE_EXIT FAILURE", JSON.stringify(unwrap(Cause.squash(probeExit.cause))))
      console.log(
        "PROBE_CAUSE_TAGS",
        JSON.stringify(Cause.prettyErrors(probeExit.cause).map((error) => (error as any)?._tag ?? (error as any)?.name ?? "err")),
      )
    } else {
      console.log("PROBE_EXIT SUCCESS")
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}, 30_000)
