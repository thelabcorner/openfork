import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const source = (relative: string) => fs.readFile(path.join(root, relative), "utf8")

describe("revision draft HttpApi", () => {
  test("is owned by RootHttpApi and declares no Instance/runtime dependency", async () => {
    const api = await source("src/server/routes/instance/httpapi/api.ts")
    const rootApi = api.slice(api.indexOf("export const RootHttpApi"), api.indexOf("export const InstanceHttpApi"))
    const instanceApi = api.slice(api.indexOf("export const InstanceHttpApi"), api.indexOf("export const OpenCodeHttpApi"))
    expect(rootApi).toContain(".addHttpApi(RevisionDraftApi)")
    expect(instanceApi).not.toContain("RevisionDraftApi)")

    const group = await source("src/server/routes/instance/httpapi/groups/revision-draft.ts")
    const handler = await source("src/server/routes/instance/httpapi/handlers/revision-draft.ts")
    const combined = group + "\n" + handler
    expect(combined).not.toContain("InstanceContextMiddleware")
    expect(combined).not.toContain("WorkspaceRoutingMiddleware")
    expect(combined).not.toContain("InstanceState")
    expect(combined).not.toContain("Location.Service")
    expect(handler).not.toContain("InstanceHttpApi")

    const server = await source("src/server/routes/instance/httpapi/server.ts")
    expect(server).toContain("revisionDraftHandlers")
    expect(server).toContain("RevisionDraft.node")

    const service = await source("../core/src/revision-draft.ts")
    expect(service).toContain("deps: [Database.node]")
    expect(service).not.toContain("Location.Service")
    expect(service).not.toMatch(/from\s+["'][^"']*instance/i)
    expect(service).not.toMatch(/deps:\s*\[[^\]]*Instance/i)
  })

  test("recovery identity is self-contained and never requests a directory", async () => {
    const group = await source("src/server/routes/instance/httpapi/groups/revision-draft.ts")
    const payloadStart = group.indexOf("export const RevisionDraftRecoverPayload")
    const payloadEnd = group.indexOf("export const RevisionDraftConsumePayload")
    const payload = group.slice(payloadStart, payloadEnd)
    expect(payload).toContain("kind: RevisionDraft.Kind")
    expect(payload).toContain("key: Schema.String")
    expect(payload).not.toContain("directory")
  })
})
