/**
 * Reviewed, action-scoped OXP Swarm discovery catalog.
 *
 * Important: these are *descriptions*, never separate execution privileges.
 * The complete original schema, OXP root grant and coordinator checks remain
 * authoritative at call time. Do not expose native-only force/admin actions.
 *
 * Each listed field was traced through OxpSwarm.execute, not guessed from the
 * parameter name. Keep this mapping alongside executable descriptor tests.
 */
import type { OxpSwarm } from "./swarm"

type Action = OxpSwarm.Input["action"]
type Field = keyof OxpSwarm.Input
type Projection = {
  readonly fields: readonly Field[]
  readonly required: readonly Field[]
  readonly constraints?: Readonly<Record<string, unknown>>
}
const item = (
  fields: readonly Field[],
  required: readonly Field[] = ["swarmId"],
  constraints?: Readonly<Record<string, unknown>>,
): Projection => ({ fields, required, ...(constraints ? { constraints } : {}) })

export const SWARM_FOCUSED_ACTIONS: Readonly<Partial<Record<Action, Projection>>> = {
  list: item(["status"], []),
  get: item(["swarmId"]),
  summary: item(["swarmId"]),
  delegate: item(["swarmName", "requestKey", "coordinatorName", "coordinatorRole", "members", "tasks"], ["swarmName"]),
  "creation.lookup": item(["requestKey"], ["requestKey"]),
  set_status: item(["swarmId", "status"], ["swarmId", "status"]),
  state: item(["swarmId", "status"], ["swarmId", "status"]), // deprecated alias
  "member.add": item(["swarmId", "memberName", "memberRole", "desiredProfile", "workspacePolicy", "capabilities"], [
    "swarmId", "memberName", "memberRole", "desiredProfile", "workspacePolicy",
  ]),
  "member.batch": item(["swarmId", "members"], ["swarmId", "members"], {
    allOf: [{ properties: { members: { type: "array", minItems: 1, maxItems: 8 } } }],
  }),
  "member.stop": item(["swarmId", "memberId"], ["swarmId", "memberId"]),
  "member.resume": item(["swarmId", "memberId"], ["swarmId", "memberId"]),
  "task.create": item(["swarmId", "title", "description", "priority", "reservedMemberId", "acceptance", "metadata", "dependencies"], [
    "swarmId", "title",
  ]),
  "task.batch": item(["swarmId", "tasks"], ["swarmId", "tasks"], {
    allOf: [{ properties: { tasks: { type: "array", minItems: 1, maxItems: 8 } } }],
  }),
  "task.dependencies": item(["swarmId", "taskId", "dependencies"], ["swarmId", "taskId"]),
  "task.runs": item(["swarmId", "taskId", "limit", "runCursor"]),
  // task.settle has supervised Session authority plus conditional failureKind:
  // represent all relevant args and leave conditional filter to canonical schema.
  "task.settle": item(["swarmId", "sessionID", "settlement", "resultSummary", "failureKind", "detail"], [
    "swarmId", "sessionID", "settlement",
  ], {
    allOf: [{ if: { properties: { settlement: { const: "failed" } }, required: ["settlement"] },
      then: { required: ["failureKind"] } }],
  }),
  "message.list": item(["swarmId", "limit"]),
  // message.send requires either targetMemberId or broadcast=true; the
  // original canonical action filter enforces this at execution.
  "message.send": item([
    "swarmId", "body", "targetMemberId", "broadcast", "kind", "messagePriority",
    "replyExpected", "taskId", "correlationId", "responseTo", "expiresAt",
  ], ["swarmId", "body"], {
    oneOf: [
      { required: ["targetMemberId"], properties: { broadcast: { enum: [false, "false"] } } },
      { required: ["broadcast"], properties: { broadcast: { enum: [true, "true"] } },
        not: { required: ["targetMemberId"] } },
    ],
  }),
  "blackboard.get": item(["swarmId", "key"]),
  "blackboard.put": item(["swarmId", "key", "value", "contentType", "taskId", "expectedVersion"], [
    "swarmId", "key", "value",
  ]),
  "claim.list": item(["swarmId"]),
  "claim.acquire": item(["swarmId", "scope", "expiresAt"], ["swarmId", "scope"]),
  "claim.renew": item(["swarmId", "scope", "expiresAt"], ["swarmId", "scope"]),
  "claim.release": item(["swarmId", "scope"], ["swarmId", "scope"]),
  "deliverable.list": item(["swarmId", "memberId"]),
  "deliverable.publish": item(["swarmId", "deliverableSummary", "refs", "files"], ["swarmId", "deliverableSummary"]),
  "deliverable.review": item(["swarmId", "deliverableId", "verdict"], ["swarmId", "deliverableId", "verdict"]),
  "recover.members": item(["swarmId"]),
  "recover.effects": item(["swarmId", "limit"]),
  "recover.contain": item(["swarmId", "taskId", "leaseGeneration"], ["swarmId", "taskId", "leaseGeneration"]),
  "recover.session": item(["swarmId", "memberId"], ["swarmId", "memberId"]),
  "task.review": item(["swarmId", "taskId", "decision", "detail", "expectedLeaseGeneration"], [
    "swarmId", "taskId", "decision", "expectedLeaseGeneration",
  ]),
  // admin.* deliberately excluded: native local-operator actions are forbidden
  // for connector-owned coordinators, even if the broad enum includes them.
  // sourceSwarmId/force deliberately omitted: native force cannot be inherited.
}

/**
 * Zero-payload, bounded validation guidance for a failed external tool call.
 * Never stringify the attempted request or Schema's source-value diagnostics:
 * task text, peer messages and provider settings can all be sensitive.
 */
export function swarmArgumentDiagnostic(value: unknown): string {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  const action = typeof input.action === "string" && Object.hasOwn(SWARM_FOCUSED_ACTIONS, input.action)
    ? input.action as Action : undefined
  if (!action) return "Invalid Swarm arguments. Choose a connector-supported action; use capability.describe(openfork_swarm) to inspect actions. Native admin/force permissions are not inherited."
  const spec = SWARM_FOCUSED_ACTIONS[action]!
  const missing = (["rootID", "action", ...spec.required] as string[])
    .filter((key) => input[key] === undefined || input[key] === null || typeof input[key] === "string" && !input[key].trim())
  const errors: string[] = []
  if (missing.length) errors.push("missing: " + missing.join(", "))
  if (input.force !== undefined || input.sourceSwarmId !== undefined)
    errors.push("force/sourceSwarmId are native-only")
  if ((action === "delegate" || action === "creation.lookup") && input.requestKey !== undefined &&
    (typeof input.requestKey !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.requestKey)))
    errors.push("requestKey must be 1-128 ASCII letters/digits/._:- starting with a letter or digit")
  if (action === "member.batch" || action === "task.batch") {
    const key = action === "member.batch" ? "members" : "tasks"
    if (input[key] !== undefined && (!Array.isArray(input[key]) || input[key].length < 1 || input[key].length > 8))
      errors.push(key + " must contain 1-8 entries")
  }
  if (action === "message.send" && !missing.length) {
    const direct = typeof input.targetMemberId === "string" && input.targetMemberId.trim().length > 0
    const broadcast = input.broadcast === true || input.broadcast === "true"
    if (direct === broadcast) errors.push("choose targetMemberId OR broadcast=true, not both/neither")
  }
  if (action === "task.settle" && input.settlement === "failed" && !input.failureKind)
    errors.push("failureKind is required when settlement=failed")
  const correction = errors.length ? errors.join("; ") + ". " : "Check field types and nested requirements. "
  return "Invalid Swarm " + action + " arguments: " + correction +
    "Describe openfork_swarm with focusAction=" + action + " and retry only after correcting the input."
}
