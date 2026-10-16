import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const source = (relative: string) => fs.readFile(path.join(root, relative), "utf8")

describe("prompt revision progress HttpApi", () => {
  test("is owned by RootHttpApi and declares no Instance/runtime dependency", async () => {
    const api = await source("src/server/routes/instance/httpapi/api.ts")
    const rootApi = api.slice(api.indexOf("export const RootHttpApi"), api.indexOf("export const InstanceHttpApi"))
    const instanceApi = api.slice(api.indexOf("export const InstanceHttpApi"), api.indexOf("export const OpenCodeHttpApi"))
    expect(rootApi).toContain(".addHttpApi(PromptRevisionProgressApi)")
    expect(instanceApi).not.toContain("PromptRevisionProgressApi)")

    const group = await source("src/server/routes/instance/httpapi/groups/prompt-revision-progress.ts")
    const handler = await source("src/server/routes/instance/httpapi/handlers/prompt-revision-progress.ts")
    const combined = group + "\n" + handler
    expect(combined).not.toContain("InstanceContextMiddleware")
    expect(combined).not.toContain("WorkspaceRoutingMiddleware")
    expect(combined).not.toContain("InstanceState")
    expect(combined).not.toContain("Location.Service")
    expect(combined).not.toContain("process.cwd")
    expect(handler).not.toContain("InstanceHttpApi")

    const server = await source("src/server/routes/instance/httpapi/server.ts")
    expect(server).toContain("promptRevisionProgressHandlers")
    expect(server).toContain("RevisionProgress.node")

    const service = await source("../core/src/revision-progress.ts")
    expect(service).toContain("deps: []")
    expect(service).not.toContain("Location.Service")
    expect(service).not.toMatch(/from\s+["'][^"']*instance/i)
    expect(service).not.toMatch(/deps:\s*\[[^\]]*Instance/i)
    // Advisory progress is memory-only: no durable table, no event rows.
    expect(service).not.toContain("Database")
    expect(service).not.toContain("EventV2")
  })

  test("reads only a bounded correlation id and never a directory", async () => {
    const group = await source("src/server/routes/instance/httpapi/groups/prompt-revision-progress.ts")
    const payloadStart = group.indexOf("export const PromptRevisionProgressQuery")
    const payloadEnd = group.indexOf("export const PromptRevisionProgressApi")
    const query = group.slice(payloadStart, payloadEnd)
    expect(query).toContain("operationID: Schema.String")
    expect(query).not.toContain("directory")
    expect(group).toContain("/prompt/revise/progress")
  })
})
