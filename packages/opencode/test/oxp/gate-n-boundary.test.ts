import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"

const oxp = path.join(import.meta.dir, "../../src/oxp")

describe("OXP Gate N continuity boundary", () => {
  test("keeps parent-tool epochs request-driven and out of authority/runtime owners", async () => {
    const [epoch, server] = await Promise.all([
      fs.readFile(path.join(oxp, "parent-tool-epoch.ts"), "utf8"),
      fs.readFile(path.join(oxp, "server.ts"), "utf8"),
    ])
    expect(epoch).not.toContain("setInterval(")
    expect(epoch).not.toContain("setTimeout(")
    expect(epoch).toContain("HANDOFF_AFTER_MS = 20 * 60 * 1000")
    expect(epoch).toContain("EPOCH_MAX_MS = 25 * 60 * 1000")
    expect(epoch).toContain("MAX_TRACKED_PARENTS = 256")
    expect(server).toMatch(/request\.params\??\._meta/)
    expect(server).toContain('{ legacy: "reject" }')
    expect(server).not.toMatch(/headers\.get\(["']mcp-session-id["']\)/)
    expect(server).not.toContain("legacySessionIDFromHeader")
    expect(server).toContain("parentCorrelation(")
    expect(server).not.toMatch(/remoteAddress.*parent|socket.*parentSession/i)
  })

  test("decorates both success and error paths and preserves post-commit worker continuity", async () => {
    const server = await fs.readFile(path.join(oxp, "server.ts"), "utf8")
    expect(server).toContain("onFailure: (error) =>")
    expect(server).toContain("onSuccess: (result) =>")
    expect(server).toContain("withContinuity(")
    expect(server).toContain("error.metadata?.committed === true")
    expect(server).toContain("parentEpochs.markDurableContinuation(parentCorrelation)")
  })

  test("never fabricates a parent identity when documented conversation metadata is absent", async () => {
    const epoch = await fs.readFile(path.join(oxp, "parent-tool-epoch.ts"), "utf8")
    expect(epoch).toContain('state: "unattributed"')
    expect(epoch).toContain("unattributedParentCalls += 1")
    expect(epoch).toContain('createHash("sha256")')
    expect(epoch).toContain('"openai/session"')
    expect(epoch).not.toContain('source?.["openai/subject"]')
    expect(epoch).not.toContain('"mcp-session-id"')
    expect(epoch).not.toContain("legacySessionIDFromHeader")
    expect(epoch).not.toContain("req.socket")
  })
})
