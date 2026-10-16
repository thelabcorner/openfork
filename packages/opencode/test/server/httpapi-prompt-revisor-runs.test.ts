import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const source = (relative: string) => fs.readFile(path.join(root, relative), "utf8")

describe("prompt revisor run HttpApi", () => {
  test("is owned by RootHttpApi and declares no Instance/runtime dependency", async () => {
    const api = await source("src/server/routes/instance/httpapi/api.ts")
    const rootApi = api.slice(api.indexOf("export const RootHttpApi"), api.indexOf("export const InstanceHttpApi"))
    const instanceApi = api.slice(
      api.indexOf("export const InstanceHttpApi"),
      api.indexOf("export const OpenCodeHttpApi"),
    )
    expect(rootApi).toContain(".addHttpApi(PromptRevisorRunsApi)")
    expect(instanceApi).not.toContain("PromptRevisorRunsApi)")

    const group = await source("src/server/routes/instance/httpapi/groups/prompt-revisor-runs.ts")
    const handler = await source("src/server/routes/instance/httpapi/handlers/prompt-revisor-runs.ts")
    const combined = group + "\n" + handler
    expect(combined).not.toContain("InstanceContextMiddleware")
    expect(combined).not.toContain("WorkspaceRoutingMiddleware")
    expect(combined).not.toContain("InstanceState")
    expect(combined).not.toContain("Location.Service")
    expect(combined).not.toContain("process.cwd")
    expect(handler).not.toContain("InstanceHttpApi")
    expect(handler).toContain("PromptRevisorRuns.status")
    expect(handler).toContain("PromptRevisorRuns.cancel")

    const server = await source("src/server/routes/instance/httpapi/server.ts")
    expect(server).toContain("promptRevisorRunHandlers")
  })

  test("the revise handler detaches durable-target runs and preserves the legacy path", async () => {
    const handler = await source("src/server/routes/instance/httpapi/handlers/prompt-revisor.ts")
    expect(handler).toContain("PromptRevisorRuns.runDetached")
    expect(handler).toContain("ctx.payload.target")
    expect(handler).toContain("target === undefined")
    // The detached fiber must still carry the instance-scoped services.
    expect(handler).toContain("Effect.provide(services)")
  })
})
