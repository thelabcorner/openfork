import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"
import { ProjectID } from "@opencode-ai/schema/project-id"
import { Authorization } from "../middleware/authorization"
import { ApiNotFoundError, ConflictError, InvalidRequestError } from "../errors"
import { described } from "./metadata"

const root = "/scheduled-task"

export const ScheduledTaskPaths = {
  list: root,
  create: root,
  preview: `${root}/preview`,
  agenda: `${root}/agenda`,
  sessionCandidates: `${root}/session-candidate`,
  binding: `${root}/:taskID/session-binding`,
  inbox: `${root}/run`,
  unreadCount: `${root}/inbox/count`,
  control: `${root}/control`,
  acknowledge: `${root}/run/:runID/ack`,
  get: `${root}/:taskID`,
  update: `${root}/:taskID`,
  remove: `${root}/:taskID`,
  enabled: `${root}/:taskID/enabled`,
  runs: `${root}/:taskID/run`,
  runNow: `${root}/:taskID/run-now`,
} as const

export const ListQuery = Schema.Struct({
  projectID: Schema.optionalKey(ProjectID),
})

export const CreatePayload = Schema.Struct({
  projectID: Schema.optionalKey(ProjectID),
  targetDirectory: Schema.String,
  target: Schema.optionalKey(ScheduledTask.Target),
  sessionPolicy: Schema.optionalKey(ScheduledTask.SessionPolicy),
  name: Schema.String,
  enabled: Schema.optionalKey(Schema.Boolean),
  schedule: ScheduledTask.ScheduleInput,
  timezone: Schema.optionalKey(Schema.String),
  action: ScheduledTask.Action,
  policy: Schema.optionalKey(ScheduledTask.Policy),
})

export const UpdatePayload = Schema.Struct({
  expectedRevision: Schema.Number,
  name: Schema.optionalKey(Schema.String),
  targetDirectory: Schema.optionalKey(Schema.String),
  target: Schema.optionalKey(ScheduledTask.Target),
  sessionPolicy: Schema.optionalKey(ScheduledTask.SessionPolicy),
  schedule: Schema.optionalKey(ScheduledTask.ScheduleInput),
  timezone: Schema.optionalKey(Schema.NullOr(Schema.String)),
  action: Schema.optionalKey(ScheduledTask.Action),
  policy: Schema.optionalKey(ScheduledTask.Policy),
})

export const EnabledPayload = Schema.Struct({
  enabled: Schema.Boolean,
  expectedRevision: Schema.optionalKey(Schema.Number),
})

export const PreviewPayload = Schema.Struct({
  schedule: ScheduledTask.ScheduleInput,
  timezone: Schema.optionalKey(Schema.String),
  count: Schema.optionalKey(Schema.Number),
})

export const AgendaQuery = Schema.Struct({
  from: Schema.NumberFromString,
  to: Schema.NumberFromString,
  limit: Schema.optionalKey(Schema.NumberFromString),
  projectID: Schema.optionalKey(ProjectID),
})

export const SessionCandidatesQuery = Schema.Struct({
  targetDirectory: Schema.String,
  projectID: Schema.optionalKey(ProjectID),
  limit: Schema.optionalKey(Schema.NumberFromString),
})

export const ControlPayload = Schema.Struct({
  paused: Schema.Boolean,
})

export const RunsQuery = Schema.Struct({
  limit: Schema.optionalKey(Schema.NumberFromString),
  before: Schema.optionalKey(Schema.NumberFromString),
})

export const InboxQuery = Schema.Struct({
  limit: Schema.optionalKey(Schema.NumberFromString),
  unread: Schema.optionalKey(Schema.Literal("true")),
})

export const RunNowPayload = Schema.Struct({
  /** Optional timestamp override for deterministic tests; defaults to now. */
  now: Schema.optionalKey(Schema.Number),
})

const errors = [InvalidRequestError, ApiNotFoundError, ConflictError] as const

export const ScheduledTaskApi = HttpApi.make("scheduledTask").add(
  HttpApiGroup.make("scheduledTask")
    .add(
      HttpApiEndpoint.get("list", ScheduledTaskPaths.list, {
        query: ListQuery,
        success: described(Schema.Array(ScheduledTask.Info), "Scheduled tasks"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "scheduledTask.list",
          summary: "List scheduled tasks",
          description:
            "Durable Tier 0 read of scheduled task rows. This endpoint never materializes an Instance, including when projectID is omitted.",
        }),
      ),
      HttpApiEndpoint.post("create", ScheduledTaskPaths.create, {
        payload: CreatePayload,
        success: described(ScheduledTask.Info, "Created scheduled task"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "scheduledTask.create",
          summary: "Create a scheduled task",
          description:
            "targetDirectory is required and must be absolute; the due cursor is materialized in the same transaction.",
        }),
      ),
      HttpApiEndpoint.post("preview", ScheduledTaskPaths.preview, {
        payload: PreviewPayload,
        success: described(ScheduledTask.Preview, "Computed next occurrences and DST warnings"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "scheduledTask.preview",
          summary: "Preview a schedule",
          description: "Pure recurrence evaluation. No database write and no Instance.",
        }),
      ),
      HttpApiEndpoint.get("agenda", ScheduledTaskPaths.agenda, {
        query: AgendaQuery,
        success: described(Schema.Array(ScheduledTask.AgendaOccurrence), "Scheduled task calendar occurrences"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "scheduledTask.agenda",
          summary: "Calendar occurrences for scheduled tasks",
          description:
            "Bounded Tier 0 recurrence projection for a requested window. Returns compact task/time rows only; never materializes an Instance.",
        }),
      ),
      HttpApiEndpoint.get("sessionCandidates", ScheduledTaskPaths.sessionCandidates, {
        query: SessionCandidatesQuery,
        success: described(Schema.Array(ScheduledTask.SessionCandidate), "User-drivable root Session candidates"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "scheduledTask.sessionCandidates",
          summary: "List Session candidates for Existing mode",
          description:
            "Bounded Tier 0 root-Session projection filtered by canonical producer ownership. No history hydration and no Instance materialization.",
        }),
      ),
      HttpApiEndpoint.get("inbox", ScheduledTaskPaths.inbox, {
        query: InboxQuery,
        success: described(Schema.Array(ScheduledTask.Run), "Scheduled task runs across all tasks"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "scheduledTask.inbox",
          summary: "Scheduled run inbox",
          description: "Newest runs across all tasks, optionally unread only.",
        }),
      ),
      HttpApiEndpoint.get("unreadCount", ScheduledTaskPaths.unreadCount, {
        success: described(ScheduledTask.InboxCount, "Unread run count"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "scheduledTask.unreadCount", summary: "Unread inbox count" }),
      ),
      HttpApiEndpoint.get("getControl", ScheduledTaskPaths.control, {
        success: described(ScheduledTask.Control, "Global scheduling control"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "scheduledTask.getControl", summary: "Get the global kill switch" }),
      ),
      HttpApiEndpoint.post("setControl", ScheduledTaskPaths.control, {
        payload: ControlPayload,
        success: described(ScheduledTask.Control, "Updated global scheduling control"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "scheduledTask.setControl",
          summary: "Pause or resume all schedules",
          description: "Pausing disarms the process-global timer; in-flight runs complete normally.",
        }),
      ),
      HttpApiEndpoint.post("acknowledge", ScheduledTaskPaths.acknowledge, {
        params: { runID: ScheduledTask.RunID },
        success: described(HttpApiSchema.NoContent, "Acknowledged run"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "scheduledTask.acknowledge",
          summary: "Acknowledge a run",
          description: "Clears the unread inbox bit server-side so it converges across clients.",
        }),
      ),
      HttpApiEndpoint.get("get", ScheduledTaskPaths.get, {
        params: { taskID: ScheduledTask.ID },
        success: described(ScheduledTask.Info, "Scheduled task"),
        error: errors,
      }).annotateMerge(OpenApi.annotations({ identifier: "scheduledTask.get", summary: "Get a scheduled task" })),
      HttpApiEndpoint.get("getBinding", ScheduledTaskPaths.binding, {
        params: { taskID: ScheduledTask.ID },
        success: described(Schema.NullOr(ScheduledTask.SessionBindingProjection), "Current Scheduled Task Session anchor"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "scheduledTask.getBinding",
          summary: "Get current Session anchor",
          description: "Tier 0 compact projection; does not hydrate Session history or materialize an Instance.",
        }),
      ),
      HttpApiEndpoint.delete("clearBinding", ScheduledTaskPaths.binding, {
        params: { taskID: ScheduledTask.ID },
        success: described(HttpApiSchema.NoContent, "Cleared current Session anchor"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "scheduledTask.clearBinding",
          summary: "Start fresh on the next reusable run",
          description: "Clears only runner-owned binding state. The Session itself survives.",
        }),
      ),
      HttpApiEndpoint.patch("update", ScheduledTaskPaths.update, {
        params: { taskID: ScheduledTask.ID },
        payload: UpdatePayload,
        success: described(ScheduledTask.Info, "Updated scheduled task"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "scheduledTask.update",
          summary: "Update a scheduled task",
          description: "Optimistic concurrency via expectedRevision; the due cursor is recomputed in-transaction.",
        }),
      ),
      HttpApiEndpoint.delete("remove", ScheduledTaskPaths.remove, {
        params: { taskID: ScheduledTask.ID },
        success: described(HttpApiSchema.NoContent, "Removed scheduled task"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "scheduledTask.remove",
          summary: "Delete a scheduled task",
          description: "Deletes the task and its run history; Sessions created by runs are never deleted.",
        }),
      ),
      HttpApiEndpoint.post("enabled", ScheduledTaskPaths.enabled, {
        params: { taskID: ScheduledTask.ID },
        payload: EnabledPayload,
        success: described(ScheduledTask.Info, "Updated scheduled task"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "scheduledTask.enabled",
          summary: "Enable or disable a scheduled task",
          description: "Cheap toggle separate from update; enables compute the cursor from now.",
        }),
      ),
      HttpApiEndpoint.get("runs", ScheduledTaskPaths.runs, {
        params: { taskID: ScheduledTask.ID },
        query: RunsQuery,
        success: described(Schema.Array(ScheduledTask.Run), "Run history"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "scheduledTask.runs",
          summary: "Run history for one task",
          description: "Paged newest-first. Fetched only when a run history surface is explicitly opened.",
        }),
      ),
      HttpApiEndpoint.post("runNow", ScheduledTaskPaths.runNow, {
        params: { taskID: ScheduledTask.ID },
        payload: RunNowPayload,
        success: described(ScheduledTask.Run, "Queued manual run"),
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "scheduledTask.runNow",
          summary: "Run a scheduled task immediately",
          description:
            "Tier 0 durable enqueue: writes a queued run and returns before the process-global runner crosses the Tier 3 execution boundary.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({ title: "scheduledTask", description: "Tier 0 durable scheduled task catalog." }),
    )
    .middleware(Authorization),
)
