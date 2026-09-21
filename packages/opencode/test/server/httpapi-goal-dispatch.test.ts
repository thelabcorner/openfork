import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { GoalPaths } from "../../src/server/routes/instance/httpapi/groups/goal"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

const context = Context.empty() as Context.Context<unknown>

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  if (init.body !== undefined) headers.set("content-type", "application/json")
  return HttpApiApp.webHandler().handler(new Request(`http://localhost${route}`, { ...init, headers }), context)
}

async function json<T>(response: Response) {
  const body = await response.json()
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`)
  return body as T
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("Goal dispatch HttpApi", () => {
  test("derives a retry-idempotent Goal action turn from server-owned state instead of caller prompt/provenance", async () => {
    await using tmp = await tmpdir({ git: true })
    const session = await json<any>(
      await request(SessionPaths.create, tmp.path, { method: "POST", body: JSON.stringify({ title: "Goal dispatch" }) }),
    )
    expect((await request(pathFor(SessionPaths.pause, { sessionID: session.id }), tmp.path, { method: "POST" })).status).toBe(204)

    const goal = await json<any>(
      await request(GoalPaths.create, tmp.path, {
        method: "POST",
        body: JSON.stringify({
          projectID: session.projectID,
          title: "Dispatch proof",
          objective: "Prove trusted Goal dispatch.",
          criteria: ["The worker receives only an action root."],
        }),
      }),
    )
    expect(
      (
        await request(pathFor(GoalPaths.sessionFocus, { sessionID: session.id }), tmp.path, {
          method: "PUT",
          body: JSON.stringify({ goalID: goal.goal.id }),
        })
      ).status,
    ).toBe(200)
    const active = await json<any>(
      await request(pathFor(GoalPaths.transition, { goalID: goal.goal.id }), tmp.path, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: goal.goal.revision, action: "start" }),
      }),
    )

    const route = pathFor(GoalPaths.sessionDispatch, { sessionID: session.id })
    const payload = JSON.stringify({
      goalID: goal.goal.id,
      revision: active.goal.revision,
      action: "start",
      prompt: "MALICIOUS CALLER-CONTROLLED GOAL SNAPSHOT",
      provenance: { owner: "host", source: "goal.continuation" },
    })
    expect((await request(route, tmp.path, { method: "POST", body: payload })).status).toBe(204)
    expect((await request(route, tmp.path, { method: "POST", body: payload })).status).toBe(204)

    const messages = await json<any[]>(
      await request(pathFor(SessionPaths.messages, { sessionID: session.id }), tmp.path),
    )
    const actions = messages.filter(
      (message) => message.info?.provenance?.source === SessionTurnProvenance.Source.GoalStart,
    )
    expect(actions).toHaveLength(1)
    expect(actions[0]?.info.provenance).toEqual({ owner: "user", source: SessionTurnProvenance.Source.GoalStart })
    expect(actions[0]?.parts.filter((part: any) => part.type === "text").map((part: any) => part.text)).toEqual([
      "Begin the focused Goal.",
    ])
    expect(JSON.stringify(actions[0])).not.toContain("MALICIOUS CALLER-CONTROLLED GOAL SNAPSHOT")
    expect(SessionTurnProvenance.isWorkerPromptTurn(actions[0])).toBe(true)
    expect(SessionTurnProvenance.isGoalAuthorizationTurn(actions[0])).toBe(false)
  }, 20_000)
})
