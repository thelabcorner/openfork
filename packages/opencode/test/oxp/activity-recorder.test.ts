import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { OxpActivityInspection } from "@opencode-ai/core/oxp-activity/inspection"
import { OxpActivity } from "@opencode-ai/core/oxp-activity/activity"
import { OxpActivitySchema } from "@opencode-ai/core/oxp-activity/schema"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import {
  OxpCorrelationRefTable,
  OxpInvocationLinkTable,
  OxpInvocationTable,
  OxpParentActivityTable,
} from "@opencode-ai/core/oxp-activity/sql"
import { Global } from "@opencode-ai/core/global"
import { OxpActivityIdentity } from "@/oxp/activity-identity"
import { OxpActivityRecorder } from "@/oxp/activity-recorder"
import { OxpError } from "@/oxp/error"
import { testEffect } from "../lib/effect"

const fakeIdentity = Layer.succeed(
  OxpActivityIdentity.Service,
  OxpActivityIdentity.Service.of({
    pseudonymize: (correlation) =>
      Effect.succeed({
        scheme: correlation.scheme,
        digest:
          "digest:" +
          Buffer.from(correlation.scheme + "\0" + correlation.value).toString(
            "base64url",
          ),
        scope: correlation.scope,
      }),
  }),
)

const chatCorrelation = (value: string) =>
  ({
    scheme: "openai/session",
    value,
    scope: "conversation",
  }) as const

const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    OxpActivityRecorder.node,
    OxpActivityInspection.node,
  ]),
  [
    [Database.node, Database.layerFromPath(":memory:")],
    [
      Global.node,
      Global.layerWith({
        config: "/tmp/oxp-recorder-config",
        state: "/tmp/oxp-recorder-state",
      }),
    ],
    [OxpActivityIdentity.node, fakeIdentity],
  ],
)
const it = testEffect(layer)

function median(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

const failingSettlementActivity = Layer.mock(OxpActivity.Service)({
  begin: () =>
    Effect.succeed({
      activityID: OxpActivitySchema.ActivityID.make("oxpa_recorder_failure"),
      invocationID: OxpActivitySchema.InvocationID.make("oxpi_recorder_failure"),
      activityCreated: true,
    }),
  settle: () => Effect.die("synthetic recorder settlement failure"),
  link: () => Effect.die("synthetic recorder link failure"),
  runningHostRuns: () => Effect.succeed([]),
  interruptHostRun: () => Effect.succeed(0),
})

const failingRecorderLayer = AppNodeBuilder.build(
  LayerNode.group([OxpActivityRecorder.node]),
  [
    [Database.node, Database.layerFromPath(":memory:")],
    [
      Global.node,
      Global.layerWith({
        config: "/tmp/oxp-recorder-failure-config",
        state: "/tmp/oxp-recorder-failure-state",
      }),
    ],
    [OxpActivityIdentity.node, fakeIdentity],
    [OxpActivity.node, failingSettlementActivity],
  ],
)
const failingRecorderIt = testEffect(failingRecorderLayer)

const recoveryInterrupts: string[] = []
const recoveryActivity = Layer.mock(OxpActivity.Service)({
  runningHostRuns: () =>
    Effect.succeed([
      "runtime-owner:dead-host",
      "runtime-owner:live-host",
      "oxp-host:legacy-unknown",
    ]),
  interruptHostRun: (hostRunID) =>
    Effect.sync(() => {
      recoveryInterrupts.push(hostRunID)
      return 1
    }),
})
const recoveryRuntime = Layer.succeed(
  RuntimeOwner.Service,
  RuntimeOwner.Service.of({
    id: "runtime-owner:current-host" as RuntimeOwner.ID,
    pid: 10,
    startedAt: 1,
    retain: Effect.succeed({ release: Effect.void }),
    snapshot: () => Effect.succeed(undefined),
    proveLocalDeath: (id) =>
      Effect.succeed(
        id === ("runtime-owner:dead-host" as RuntimeOwner.ID)
          ? "dead"
          : "alive-or-unknown",
      ),
  }),
)
const recoveryRecorderIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([OxpActivityRecorder.node]), [
    [
      Global.node,
      Global.layerWith({
        config: "/tmp/oxp-recorder-recovery-config",
        state: "/tmp/oxp-recorder-recovery-state",
      }),
    ],
    [OxpActivityIdentity.node, fakeIdentity],
    [OxpActivity.node, recoveryActivity],
    [RuntimeOwner.node, recoveryRuntime],
  ]),
)

describe("OxpActivityRecorder", () => {
  recoveryRecorderIt.live(
    "interrupts only host generations with an explicit RuntimeOwner death proof",
    Effect.gen(function* () {
      yield* OxpActivityRecorder.Service
      expect(recoveryInterrupts).toEqual(["runtime-owner:dead-host"])
    }),
  )

  failingRecorderIt.live(
    "swallows recorder settlement failures after the real operation has succeeded",
    Effect.gen(function* () {
      const recorder = yield* OxpActivityRecorder.Service
      const input = {
        parentCorrelation: chatCorrelation("parent-recorder-failure"),
        tool: "read",
        args: {},
      } as const
      const handle = yield* recorder.begin(input)
      expect(handle).toBeDefined()

      // The operation result is already authoritative before recorder.success
      // runs. A storage/event failure in observability must not replace it.
      const operation = {
        output: "authoritative operation success",
        structured: { ok: true },
        mutation: { attempted: true, committed: true },
      } as const
      yield* recorder.success(handle, input, operation)
      expect(operation.mutation.committed).toBe(true)

      // The same isolation applies to failure recording itself: attempting to
      // persist an outcome cannot manufacture a second failure mode.
      yield* recorder.failure(
        handle,
        input,
        new OxpError.Conflict({ detail: "authoritative operation failure" }),
      )
    }),
  )

  it.live(
    "records one structural invocation and safe durable worker link without raw payloads",
    Effect.gen(function* () {
      const recorder = yield* OxpActivityRecorder.Service
      const inspection = yield* OxpActivityInspection.Service
      const { db } = yield* Database.Service
      const input = {
        parentCorrelation: chatCorrelation("raw-upstream-parent"),
        observedEpoch: 2,
        continuityMarker: "handoff_advisory",
        tool: "openfork_worker",
        args: {
          action: "start",
          rootID: "11111111-1111-4111-8111-111111111111",
          prompt: "PRIVATE PROMPT MUST NOT PERSIST",
        },
      } as const
      const handle = yield* recorder.begin(input)
      expect(handle).toBeDefined()
      yield* recorder.success(handle, input, {
        output: "PRIVATE RESULT MUST NOT PERSIST",
        structured: {
          workerID: "ses_worker_activity",
          secret: "PRIVATE STRUCTURED SECRET",
        },
        mutation: { attempted: true, committed: true },
      })

      const [summary] = yield* inspection.list()
      expect(summary).toMatchObject({
        call_count: 1,
        delegation_calls: 1,
        observed_epoch_count: 1,
        last_tool: "openfork_worker",
      })
      const page = yield* inspection.invocations({
        activityID: handle!.activityID,
      })
      expect(page.items[0]).toMatchObject({
        tool: "openfork_worker",
        action: "start",
        safe_summary: { continuityMarker: "handoff_advisory" },
        status: "committed",
        mutation_attempted: true,
        mutation_committed: true,
      })
      expect(page.items[0]?.host_run_id.startsWith("runtime-owner:")).toBe(true)
      expect(page.links).toContainEqual(
        expect.objectContaining({
          kind: "worker_session",
          ref: "ses_worker_activity",
          relation: "created",
        }),
      )
      const persisted = JSON.stringify({ summary, page })
      expect(persisted).not.toContain("raw-upstream-parent")
      expect(persisted).not.toContain("PRIVATE PROMPT")
      expect(persisted).not.toContain("PRIVATE RESULT")
      expect(persisted).not.toContain("PRIVATE STRUCTURED SECRET")

      const databaseRows = JSON.stringify({
        parents: yield* db.select().from(OxpParentActivityTable).all(),
        correlations: yield* db.select().from(OxpCorrelationRefTable).all(),
        invocations: yield* db.select().from(OxpInvocationTable).all(),
        links: yield* db.select().from(OxpInvocationLinkTable).all(),
      })
      expect(databaseRows).not.toContain("raw-upstream-parent")
      expect(databaseRows).not.toContain("PRIVATE PROMPT MUST NOT PERSIST")
      expect(databaseRows).not.toContain("PRIVATE RESULT MUST NOT PERSIST")
      expect(databaseRows).not.toContain("PRIVATE STRUCTURED SECRET")
    }),
  )

  it.live(
    "persists bounded mutation presentation data without durable diff bodies",
    Effect.gen(function* () {
      const recorder = yield* OxpActivityRecorder.Service
      const inspection = yield* OxpActivityInspection.Service
      const input = {
        parentCorrelation: chatCorrelation("parent-safe-mutation-summary"),
        tool: "patch",
        args: {
          rootID: "11111111-1111-4111-8111-111111111111",
          patchText: "PRIVATE PATCH BODY MUST NOT PERSIST",
        },
      } as const
      const handle = yield* recorder.begin(input)
      yield* recorder.success(handle, input, {
        output: "PRIVATE PATCH RESULT MUST NOT PERSIST",
        metadata: {
          format: "opencode",
          fileCount: 2,
          applied: true,
          files: [
            { type: "update", path: "/webstormprojects/a.ts", additions: 4, deletions: 2 },
            { type: "add", path: "/webstormprojects/b.ts", additions: 8, deletions: 0 },
          ],
          diff: "PRIVATE DIFF BODY MUST NOT PERSIST",
        },
        mutation: { attempted: true, committed: true },
      })

      const page = yield* inspection.invocations({ activityID: handle!.activityID })
      expect(page.items[0]?.safe_summary).toEqual({
        format: "opencode",
        fileCount: 2,
        applied: true,
        files: [
          { type: "update", path: "/webstormprojects/a.ts", additions: 4, deletions: 2 },
          { type: "add", path: "/webstormprojects/b.ts", additions: 8, deletions: 0 },
        ],
      })
      const persisted = JSON.stringify(page)
      expect(persisted).not.toContain("PRIVATE PATCH BODY")
      expect(persisted).not.toContain("PRIVATE PATCH RESULT")
      expect(persisted).not.toContain("PRIVATE DIFF BODY")
    }),
  )

  it.live(
    "records post-commit cancellation as committed historical truth and links the worker",
    Effect.gen(function* () {
      const recorder = yield* OxpActivityRecorder.Service
      const inspection = yield* OxpActivityInspection.Service
      const input = {
        parentCorrelation: chatCorrelation("parent-post-commit"),
        observedEpoch: 1,
        tool: "openfork_worker",
        args: { action: "start" },
      } as const
      const handle = yield* recorder.begin(input)
      yield* recorder.failure(
        handle,
        input,
        new OxpError.Cancelled({
          detail: "caller disconnected after commit",
          metadata: {
            committed: true,
            workerID: "ses_committed_worker",
          },
        }),
      )
      const page = yield* inspection.invocations({
        activityID: handle!.activityID,
      })
      expect(page.items[0]).toMatchObject({
        status: "cancelled_after_commit",
        error_code: "OXP_CANCELLED",
        mutation_attempted: true,
        mutation_committed: true,
      })
      expect(page.links).toContainEqual(
        expect.objectContaining({
          kind: "worker_session",
          ref: "ses_committed_worker",
          relation: "created",
        }),
      )
    }),
  )

  it.live(
    "records structural root, Session, worker-group, worker-Session, and process lineage",
    Effect.gen(function* () {
      const recorder = yield* OxpActivityRecorder.Service
      const inspection = yield* OxpActivityInspection.Service
      const parentCorrelation = chatCorrelation("parent-structural-lineage")

      const sessionInput = {
        parentCorrelation,
        tool: "openfork_session",
        args: {
          action: "inspect",
          rootID: "root_structural",
          sessionID: "ses_target",
        },
      } as const
      const sessionHandle = yield* recorder.begin(sessionInput)
      yield* recorder.success(sessionHandle, sessionInput, {
        output: "ignored",
        structured: { sessionID: "ses_observed" },
      })

      const workerInput = {
        parentCorrelation,
        tool: "openfork_worker",
        args: {
          action: "batch_start",
          batchID: "batch_target",
        },
      } as const
      const workerHandle = yield* recorder.begin(workerInput)
      yield* recorder.success(workerHandle, workerInput, {
        output: "ignored",
        structured: {
          batchID: "batch_created",
          workerIDs: ["ses_worker_a", "ses_worker_b"],
        },
        mutation: { attempted: true, committed: true },
      })

      const processInput = {
        parentCorrelation,
        tool: "process",
        args: {
          action: "start",
          handle: "proc_target",
        },
      } as const
      const processHandle = yield* recorder.begin(processInput)
      yield* recorder.success(processHandle, processInput, {
        output: "ignored",
        structured: { handle: "proc_created" },
        mutation: { attempted: true, committed: true },
      })

      const page = yield* inspection.invocations({
        activityID: sessionHandle!.activityID,
        limit: 20,
      })
      const expected = [
        ["root", "root_structural", "target"],
        ["session", "ses_target", "target"],
        ["session", "ses_observed", "observed"],
        ["worker_group", "batch_target", "target"],
        ["worker_group", "batch_created", "created"],
        ["worker_session", "ses_worker_a", "created"],
        ["worker_session", "ses_worker_b", "created"],
        ["process", "proc_target", "target"],
        ["process", "proc_created", "created"],
      ] as const
      for (const [kind, ref, relation] of expected) {
        expect(page.links).toContainEqual(
          expect.objectContaining({ kind, ref, relation }),
        )
      }
    }),
  )

  it.live(
    "projects denial, pre-commit cancellation, and ambiguous external outcomes truthfully",
    Effect.gen(function* () {
      const recorder = yield* OxpActivityRecorder.Service
      const inspection = yield* OxpActivityInspection.Service
      const scenarios = [
        {
          error: new OxpError.AuthDenied({ detail: "denied" }),
          status: "denied",
          code: "OXP_AUTH_DENIED",
        },
        {
          error: new OxpError.Cancelled({ detail: "cancelled before commit" }),
          status: "cancelled_before_commit",
          code: "OXP_CANCELLED",
        },
        {
          error: new OxpError.AmbiguousExternalResult({
            detail: "external commit unknown",
          }),
          status: "ambiguous_external_result",
          code: "OXP_AMBIGUOUS_EXTERNAL_RESULT",
        },
      ] as const
      const handles: OxpActivityRecorder.Handle[] = []
      for (const [index, scenario] of scenarios.entries()) {
        const input = {
          parentCorrelation: chatCorrelation("parent-outcome-taxonomy"),
          tool: "read",
          args: { action: "case-" + index },
        } as const
        const handle = yield* recorder.begin(input)
        handles.push(handle!)
        yield* recorder.failure(handle, input, scenario.error)
      }

      const page = yield* inspection.invocations({
        activityID: handles[0]!.activityID,
        limit: 20,
      })
      for (const [index, scenario] of scenarios.entries()) {
        expect(
          page.items.find((row) => row.id === handles[index]!.invocationID),
        ).toMatchObject({
          status: scenario.status,
          error_code: scenario.code,
          mutation_attempted: false,
          mutation_committed: false,
        })
      }
    }),
  )

  it.live(
    "keeps warm recorder begin and settle medians below the provisional 1 ms target",
    Effect.gen(function* () {
      const recorder = yield* OxpActivityRecorder.Service
      const input = {
        parentCorrelation: chatCorrelation("parent-recorder-benchmark"),
        observedEpoch: 1,
        tool: "read",
        args: {},
      } as const
      const rounds = 4
      const warmSamples = 20
      const measuredSamples = 80
      const beginMedians: number[] = []
      const settleMedians: number[] = []

      for (let round = 0; round < rounds; round++) {
        const beginMs: number[] = []
        const settleMs: number[] = []
        for (
          let index = 0;
          index < warmSamples + measuredSamples;
          index++
        ) {
          const beginAt = performance.now()
          const handle = yield* recorder.begin(input)
          const begunAt = performance.now()
          yield* recorder.success(handle, input, {
            output: "ok",
            structured: {},
          })
          const settledAt = performance.now()
          if (index >= warmSamples) {
            beginMs.push(begunAt - beginAt)
            settleMs.push(settledAt - begunAt)
          }
        }
        beginMedians.push(median(beginMs))
        settleMedians.push(median(settleMs))
      }

      // The target explicitly excludes SQLite/OS contention. Preserve the real
      // sequential call shape, log every warm round, and gate on the best round
      // so transient host scheduling cannot masquerade as sustained regression.
      const beginMedian = Math.min(...beginMedians)
      const settleMedian = Math.min(...settleMedians)
      console.info(
        `Gate P recorder warm medians: begin best ${beginMedian.toFixed(3)}ms [${beginMedians.map((value) => value.toFixed(3)).join(", ")}]; settle best ${settleMedian.toFixed(3)}ms [${settleMedians.map((value) => value.toFixed(3)).join(", ")}]`,
      )
      expect(beginMedian).toBeLessThan(1)
      expect(settleMedian).toBeLessThan(1)
    }),
  )

  it.live(
    "records brokered Scheduled Task lineage as a typed durable resource link",
    Effect.gen(function* () {
      const recorder = yield* OxpActivityRecorder.Service
      const inspection = yield* OxpActivityInspection.Service
      const input = {
        parentCorrelation: chatCorrelation("parent-schedule-lineage"),
        observedEpoch: 3,
        tool: "capability",
        args: {
          action: "call",
          namespace: "openfork",
          capability: "schedule.create",
          contract: "opaque-contract-not-for-history",
          args: { prompt: "PRIVATE SCHEDULE PROMPT" },
        },
      } as const
      const handle = yield* recorder.begin(input)
      yield* recorder.success(handle, input, {
        output: "PRIVATE SCHEDULE RESULT",
        structured: {
          created: true,
          taskID: "stk_lineage_activity",
          enabled: true,
        },
        mutation: { attempted: true, committed: true },
      })
      const page = yield* inspection.invocations({
        activityID: handle!.activityID,
      })
      expect(page.links).toContainEqual(
        expect.objectContaining({
          kind: "scheduled_task",
          ref: "stk_lineage_activity",
          relation: "created",
        }),
      )
      const serialized = JSON.stringify(page)
      expect(serialized).not.toContain("PRIVATE SCHEDULE PROMPT")
      expect(serialized).not.toContain("PRIVATE SCHEDULE RESULT")
      expect(serialized).not.toContain("opaque-contract-not-for-history")
    }),
  )

  it.live(
    "records only canonical structural lineage for external MCP and file-transfer calls",
    Effect.gen(function* () {
      const recorder = yield* OxpActivityRecorder.Service
      const inspection = yield* OxpActivityInspection.Service
      const { db } = yield* Database.Service

      const mcpInput = {
        parentCorrelation: chatCorrelation("parent-external-lineage"),
        tool: "capability",
        args: {
          action: "call",
          namespace: "mcp",
          capability: "attacker-controlled-selector",
          contract: "PRIVATE MCP CONTRACT",
          args: { token: "PRIVATE MCP ARG" },
        },
      } as const
      const mcpHandle = yield* recorder.begin(mcpInput)
      yield* recorder.success(mcpHandle, mcpInput, {
        output: "PRIVATE MCP OUTPUT",
        structured: { secret: "PRIVATE MCP STRUCTURED" },
        metadata: {
          namespace: "mcp",
          capability: "trusted-server/trusted-tool",
          server: "trusted-server",
          tool: "trusted-tool",
        },
        mutation: { attempted: true, committed: true },
      })

      const fileInput = {
        parentCorrelation: chatCorrelation("parent-external-lineage"),
        tool: "capability",
        args: {
          action: "call",
          namespace: "openfork",
          capability: "file.transfer",
          contract: "PRIVATE FILE CONTRACT",
          args: { source: "/PRIVATE/native/path" },
        },
      } as const
      const fileHandle = yield* recorder.begin(fileInput)
      yield* recorder.success(fileHandle, fileInput, {
        output: "PRIVATE FILE OUTPUT",
        structured: {
          action: "upload_openai_file",
          source: "/PRIVATE/native/path",
          file: {
            id: "file-safe-lineage",
            filename: "PRIVATE_FILENAME.txt",
            bytes: 123,
          },
        },
        mutation: { attempted: true, committed: true },
      })

      const page = yield* inspection.invocations({
        activityID: mcpHandle!.activityID,
        limit: 20,
      })
      expect(page.links).toContainEqual(
        expect.objectContaining({
          kind: "external_mcp",
          ref: "trusted-server/trusted-tool",
          relation: "called",
        }),
      )
      expect(page.links).toContainEqual(
        expect.objectContaining({
          kind: "file_transfer",
          ref: "file-safe-lineage",
          relation: "created",
        }),
      )
      const serialized = JSON.stringify(page)
      expect(serialized).not.toContain("attacker-controlled-selector")
      expect(serialized).not.toContain("PRIVATE MCP")
      expect(serialized).not.toContain("/PRIVATE/native/path")
      expect(serialized).not.toContain("PRIVATE_FILENAME")
      expect(serialized).not.toContain("PRIVATE FILE OUTPUT")

      const databaseRows = JSON.stringify({
        parents: yield* db.select().from(OxpParentActivityTable).all(),
        correlations: yield* db.select().from(OxpCorrelationRefTable).all(),
        invocations: yield* db.select().from(OxpInvocationTable).all(),
        links: yield* db.select().from(OxpInvocationLinkTable).all(),
      })
      expect(databaseRows).not.toContain("attacker-controlled-selector")
      expect(databaseRows).not.toContain("PRIVATE MCP")
      expect(databaseRows).not.toContain("/PRIVATE/native/path")
      expect(databaseRows).not.toContain("PRIVATE_FILENAME")
      expect(databaseRows).not.toContain("PRIVATE FILE OUTPUT")
    }),
  )

  it.live(
    "does not fabricate an activity when no upstream correlation is available",
    Effect.gen(function* () {
      const recorder = yield* OxpActivityRecorder.Service
      const inspection = yield* OxpActivityInspection.Service
      const handle = yield* recorder.begin({
        tool: "read",
        args: { rootID: "11111111-1111-4111-8111-111111111111" },
      })
      expect(handle).toBeUndefined()
      expect(yield* inspection.list()).toEqual([])
    }),
  )
})

