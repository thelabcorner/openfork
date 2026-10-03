import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit, Schema } from "effect"
import { ACTION_REQUIREMENTS_DESCRIPTION, Parameters } from "@/tool/swarm"
import { ToolJsonSchema } from "@/tool/json-schema"

const decode = Schema.decodeUnknownEffect(Parameters)

async function decodeFailure(input: unknown) {
  const exit = await Effect.runPromiseExit(decode(input))
  if (Exit.isSuccess(exit)) return undefined
  return Cause.pretty((exit as { cause: unknown }).cause as never).replace(/\s+/g, " ")
}

async function accept(input: unknown) {
  return (await decodeFailure(input)) === undefined
}

function requirementLines() {
  const lines = ACTION_REQUIREMENTS_DESCRIPTION.split("\n")
  expect(lines[0]).toBe("Required inputs by action:")
  return new Map(lines.slice(1).map((line) => [line.slice(2, line.indexOf(": ")), line.slice(line.indexOf(": ") + 2)]))
}

describe("tool.swarm action schema", () => {
  it("documents one required-input line per action from the enforced table", () => {
    const lines = requirementLines()
    expect([...lines]).toEqual([
      ["list", "none"],
      [
        "get",
        "swarmId; full Swarm detail only; use task.runs for TaskRun/result audit",
      ],
      ["summary", "swarmId"],
      ["delegate", "swarmName"],
      [
        "set_status",
        "swarmId, status; mutating Swarm lifecycle action; `state` is the deprecated alias of this action",
      ],
      ["state", "swarmId, status; deprecated alias of set_status"],
      ["member.add", "swarmId, memberName, memberRole, desiredProfile, workspacePolicy"],
      ["member.stop", "swarmId, memberId"],
      ["member.resume", "swarmId, memberId"],
      ["task.create", "swarmId, title"],
      ["task.dependencies", "swarmId, taskId"],
      [
        "task.runs",
        "swarmId; bounded newest-first TaskRun audit; optional taskId, limit (1-200), and runCursor. Pass response.next back as runCursor to page older runs",
      ],
      [
        "task.settle",
        "swarmId, settlement; when settlement=failed also require failureKind; omit taskId and member identity; completed settlement may include resultSummary for durable successor handoff",
      ],
      ["message.list", "swarmId"],
      ["message.send", "swarmId, body, and either targetMemberId or broadcast=true"],
      ["blackboard.get", "swarmId"],
      ["blackboard.put", "swarmId, key, value; expectedVersion is required when overwriting"],
      ["claim.list", "swarmId"],
      ["claim.acquire", "swarmId, scope"],
      ["claim.renew", "swarmId, scope"],
      ["claim.release", "swarmId, scope"],
      ["deliverable.list", "swarmId"],
      ["deliverable.publish", "swarmId, deliverableSummary"],
      ["deliverable.review", "swarmId, deliverableId, verdict"],
      ["recover.members", "swarmId"],
      ["recover.effects", "swarmId; read-only; lists retiring leases fenced by unresolved external effects"],
      [
        "recover.contain",
        "swarmId, taskId, leaseGeneration; explicit containment acknowledgement; requires a recover.effects entry for this Swarm",
      ],
      [
        "task.review",
        "swarmId, taskId, decision, expectedLeaseGeneration; expectedLeaseGeneration is the task's current leaseGeneration as last observed; a stale value fails closed",
      ],
    ])
  })

  it("exposes set_status as the canonical mutating lifecycle action and keeps state as a deprecated alias", async () => {
    const json = ToolJsonSchema.fromSchema(Parameters) as { properties: { action: { enum: string[] } } }
    expect(json.properties.action.enum).toContain("set_status")
    expect(json.properties.action.enum).toContain("state")
    expect(await accept({ action: "set_status", swarmId: "swr_1", status: "paused" })).toBe(true)
    expect(await accept({ action: "state", swarmId: "swr_1", status: "paused" })).toBe(true)
    const missingStatus = await decodeFailure({ action: "set_status", swarmId: "swr_1" })
    expect(missingStatus).toContain('action "set_status" is missing required input(s): status')

    const misleadingGet = await decodeFailure({ action: "get", swarmId: "swr_1", taskId: "swt_1" })
    expect(misleadingGet).toContain('action "get" must not include taskId')
    expect(misleadingGet).toContain("use task.runs for run-level audit")
  })

  it("rejects a missing action input at the schema boundary instead of during execution", async () => {
    const cases: Array<{ input: Record<string, unknown>; action: string; missing: string[] }> = [
      { input: { action: "get" }, action: "get", missing: ["swarmId"] },
      { input: { action: "summary" }, action: "summary", missing: ["swarmId"] },
      { input: { action: "delegate" }, action: "delegate", missing: ["swarmName"] },
      { input: { action: "recover.members" }, action: "recover.members", missing: ["swarmId"] },
      { input: { action: "message.list" }, action: "message.list", missing: ["swarmId"] },
      { input: { action: "blackboard.get" }, action: "blackboard.get", missing: ["swarmId"] },
      { input: { action: "claim.list" }, action: "claim.list", missing: ["swarmId"] },
      { input: { action: "deliverable.list" }, action: "deliverable.list", missing: ["swarmId"] },
      { input: { action: "member.stop", swarmId: "swr_1" }, action: "member.stop", missing: ["memberId"] },
      { input: { action: "member.resume", memberId: "swm_1" }, action: "member.resume", missing: ["swarmId"] },
      {
        input: { action: "member.add", swarmId: "swr_1", memberName: "w", memberRole: "impl" },
        action: "member.add",
        missing: ["desiredProfile", "workspacePolicy"],
      },
      { input: { action: "task.create", swarmId: "swr_1" }, action: "task.create", missing: ["title"] },
      { input: { action: "task.dependencies", swarmId: "swr_1" }, action: "task.dependencies", missing: ["taskId"] },
      { input: { action: "task.runs" }, action: "task.runs", missing: ["swarmId"] },
      { input: { action: "claim.acquire", swarmId: "swr_1" }, action: "claim.acquire", missing: ["scope"] },
      { input: { action: "claim.renew", swarmId: "swr_1" }, action: "claim.renew", missing: ["scope"] },
      { input: { action: "claim.release", swarmId: "swr_1" }, action: "claim.release", missing: ["scope"] },
      {
        input: { action: "deliverable.publish", swarmId: "swr_1" },
        action: "deliverable.publish",
        missing: ["deliverableSummary"],
      },
      {
        input: { action: "deliverable.review", swarmId: "swr_1", deliverableId: "swdlv_1" },
        action: "deliverable.review",
        missing: ["verdict"],
      },
      { input: { action: "blackboard.put", swarmId: "swr_1", value: { a: 1 } }, action: "blackboard.put", missing: ["key"] },
      {
        input: { action: "message.send", swarmId: "swr_1", targetMemberId: "swm_1" },
        action: "message.send",
        missing: ["body"],
      },
      { input: { action: "message.send", swarmId: "swr_1", body: "hi" }, action: "message.send", missing: [] },
    ]
    for (const entry of cases) {
      const failure = await decodeFailure(entry.input)
      expect(failure, JSON.stringify(entry.input)).toContain(`action "${entry.action}"`)
      for (const field of entry.missing) expect(failure, JSON.stringify(entry.input)).toContain(field)
    }
    expect(await decodeFailure({ action: "message.send", swarmId: "swr_1", body: "hi" })).toContain(
      "needs one of: targetMemberId or broadcast=true",
    )
    expect(await accept({ action: "message.send", swarmId: "swr_1", body: "hi", targetMemberId: "swm_1" })).toBe(true)
    expect(await accept({ action: "message.send", swarmId: "swr_1", body: "hi", broadcast: true })).toBe(true)
  })

  it("treats a blank string as a missing action input", async () => {
    const failure = await decodeFailure({ action: "blackboard.put", swarmId: "swr_1", key: "   ", value: 1 })
    expect(failure).toContain("missing required input(s): key")
  })

  it("refuses model-supplied settlement authority and requires a typed failure kind", async () => {
    expect(await accept({ action: "task.settle", swarmId: "swr_1", settlement: "completed" })).toBe(true)
    expect(await accept({ action: "task.settle", swarmId: "swr_1", settlement: "failed", failureKind: "tool" })).toBe(true)
    const injected = await decodeFailure({
      action: "task.settle",
      swarmId: "swr_1",
      settlement: "completed",
      taskId: "swt_1",
    })
    expect(injected).toContain('action "task.settle" must not include taskId')
    expect(injected).toContain("derives current task authority from the caller Session")
    expect(await decodeFailure({ action: "task.settle", swarmId: "swr_1", settlement: "failed" })).toContain(
      "requires failureKind when settlement=failed",
    )
  })

  it("coerces only lossless scalar serialization noise and never widens bounds", async () => {
    expect(await accept({ action: "message.list", swarmId: "swr_1", limit: "50" })).toBe(true)
    expect(await accept({ action: "task.runs", swarmId: "swr_1", taskId: "swt_1", limit: "200" })).toBe(true)
    expect(
      await accept({
        action: "task.runs",
        swarmId: "swr_1",
        runCursor: { createdAt: "1791000000000", id: "swrn_cursor" },
      }),
    ).toBe(true)
    expect(await accept({ action: "task.runs", swarmId: "swr_1", limit: "201" })).toBe(false)
    expect(
      await accept({
        action: "task.runs",
        swarmId: "swr_1",
        runCursor: { createdAt: "1.5", id: "swrn_cursor" },
      }),
    ).toBe(false)
    expect(await accept({ action: "task.create", swarmId: "swr_1", title: "t", priority: "3" })).toBe(true)
    expect(await accept({ action: "blackboard.put", swarmId: "swr_1", key: "k", value: 1, expectedVersion: "2" })).toBe(
      true,
    )
    expect(await accept({ action: "message.send", swarmId: "swr_1", body: "hi", broadcast: "false", targetMemberId: "swm_1" })).toBe(
      true,
    )
    expect(await accept({ action: "claim.acquire", swarmId: "swr_1", scope: "src", expiresAt: "1700000000000" })).toBe(true)

    for (const limit of ["500", "0", "1e3", "50.5", "abc", ""]) {
      const failure = await decodeFailure({ action: "message.list", swarmId: "swr_1", limit })
      expect(failure, `limit=${limit}`).toBeDefined()
    }
    expect(await decodeFailure({ action: "message.list", swarmId: "swr_1", limit: "500" })).toContain(
      "Expected a value between 1 and 200",
    )
    expect(await decodeFailure({ action: "message.send", swarmId: "swr_1", body: "hi", broadcast: "yes" })).toContain(
      "Expected",
    )
  })
})