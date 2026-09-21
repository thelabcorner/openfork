import { describe, expect, test } from "bun:test"
import { randomUUID } from "crypto"
import { OxpContext } from "@/oxp/context"
import { OxpSchema } from "@/oxp/schema"

function principal(): OxpContext.Principal {
  return {
    connectorID: OxpSchema.ConnectorID.make(randomUUID()),
    label: "ChatGPT",
    profileRealm: "desktop",
  }
}

const authority: OxpContext.CapabilityAuthority = { authorize: async () => "allow" }
const progress: OxpContext.CapabilityProgress = { report: () => undefined }
const grounding: OxpContext.ReadGrounding = {
  note: () => undefined,
  get: () => undefined,
  remove: () => undefined,
}

describe("OxpContext", () => {
  test("contains no ambient resident Session, model, provider, or human/System authorship", () => {
    const invocation = OxpContext.createInvocation({
      principal: principal(),
      grantRevision: 3,
      plane: "augmentation",
      operation: "read",
    })
    const provenance = OxpContext.provenance(invocation)
    const serialized = JSON.parse(JSON.stringify({ invocation, provenance })) as Record<string, unknown>
    const text = JSON.stringify(serialized)

    expect(text).not.toContain("sessionID")
    expect(text).not.toContain("modelID")
    expect(text).not.toContain("providerID")
    expect(text).not.toContain('"actor":"human"')
    expect(text).not.toContain('"actor":"system"')
    expect(provenance.actor).toBe("external-agent")
    expect(provenance.protocol).toBe("oxp-over-mcp")
  })

  test("permits native Session targets only for the supervision plane", () => {
    expect(() =>
      OxpContext.createInvocation({
        principal: principal(),
        grantRevision: 1,
        plane: "augmentation",
        operation: "read",
        target: { kind: "session", id: "ses_fake" },
      }),
    ).toThrow()

    const supervision = OxpContext.createInvocation({
      principal: principal(),
      grantRevision: 1,
      plane: "supervision",
      operation: "session.get",
      target: { kind: "session", id: "ses_native" },
    })
    expect(supervision.target).toEqual({ kind: "session", id: "ses_native" })
  })

  test("keeps delegation targets distinct from supervision targets", () => {
    expect(() =>
      OxpContext.createInvocation({
        principal: principal(),
        grantRevision: 1,
        plane: "delegation",
        operation: "worker.start",
        target: { kind: "session", id: "ses_existing" },
      }),
    ).toThrow()

    const worker = OxpContext.createInvocation({
      principal: principal(),
      grantRevision: 1,
      plane: "delegation",
      operation: "worker.wait",
      target: { kind: "worker", id: "wrk_1" },
    })
    expect(worker.target?.kind).toBe("worker")
  })

  test("propagates the exact cancellation signal by reference", () => {
    const abort = new AbortController()
    const invocation = OxpContext.createInvocation({
      principal: principal(),
      grantRevision: 1,
      plane: "augmentation",
      operation: "read",
    })
    const context = OxpContext.createContext({ invocation, abort: abort.signal, authority, progress, grounding })

    expect(context.abort).toBe(abort.signal)
    abort.abort()
    expect(context.abort.aborted).toBe(true)
  })

  test("constructs workspace identity only from resolved root truth", () => {
    const rootID = OxpSchema.RootID.make(randomUUID())
    const root = {
      id: rootID,
      alias: OxpSchema.RootAlias.make("project"),
      path: "/canonical/project",
      approvedAt: Date.now(),
    }
    const workspace = OxpContext.workspaceFromResolvedRoot({
      root,
      canonicalPath: "/canonical/project",
      path: "/canonical/project/src",
      virtualPath: "/project/src",
    })

    expect(workspace).toEqual({
      rootID,
      directory: "/canonical/project/src",
      virtualDirectory: "/project/src",
    })
    expect(Object.isFrozen(workspace)).toBe(true)
  })
})
