import { describe, expect, test } from "bun:test"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"

describe("Session metadata ownership", () => {
  test("special-agent classification is string-only and fails closed for unknown kinds", () => {
    expect(SessionMetadataOwnership.isSpecialAgent({ specialAgent: "future_agent" })).toBe(true)
    expect(SessionMetadataOwnership.specialAgentKind({ specialAgent: "future_agent" })).toBe("future_agent")
    expect(
      SessionMetadataOwnership.specialAgentOwnerID({
        specialAgent: "future_agent",
        specialAgentOwnerID: "owner-1",
      }),
    ).toBe("owner-1")
    expect(
      SessionMetadataOwnership.specialAgentOwnerKind({
        specialAgent: "future_agent",
        specialAgentOwnerKind: "session",
      }),
    ).toBe("session")
    expect(SessionMetadataOwnership.isSpecialAgent({ specialAgent: 1 })).toBe(false)
    expect(SessionMetadataOwnership.specialAgentOwnerID({ specialAgentOwnerID: "spoof" })).toBeUndefined()
    expect(SessionMetadataOwnership.isSpecialAgent(undefined)).toBe(false)
  })

  test("scheduled-task aggregate ownership fails closed on partial protected metadata", () => {
    expect(SessionMetadataOwnership.hasScheduledTaskOrigin({ scheduledTaskID: "stk_real" })).toBe(true)
    expect(SessionMetadataOwnership.hasScheduledTaskOrigin({ scheduledTaskRunID: "str_real" })).toBe(true)
    expect(
      SessionMetadataOwnership.isProducerOwned({
        scheduledTaskID: "stk_real",
        scheduledTaskRunID: "str_real",
      }),
    ).toBe(true)
    expect(SessionMetadataOwnership.isProducerOwned({ ordinary: true })).toBe(false)
  })

  test("public creation cannot mint producer-owned Session identity", () => {
    expect(
      SessionMetadataOwnership.forPublicCreate({
        ordinary: "keep",
        scheduledTaskID: "stk_spoof",
        scheduledTaskRunID: "str_spoof",
        specialAgent: "goal_auditor",
        specialAgentOwnerKind: "goal",
        specialAgentOwnerID: "owner",
        workerDelegation: {
          producer: "oxp",
          principalRef: "principal",
          invocationRef: "invocation",
          rootRef: "root",
          agent: "build",
          model: { providerID: "p", modelID: "m" },
          nestedDelegation: false,
        },
        goalID: "goal_spoof",
        parentSessionID: "ses_spoof",
      }),
    ).toEqual({ ordinary: "keep" })
  })

  test("replacement stays replacement semantics for caller-owned keys while preserving scheduled origin", () => {
    expect(
      SessionMetadataOwnership.replaceCallerOwned(
        {
          ordinaryOld: true,
          scheduledTaskID: "stk_real",
          scheduledTaskRunID: "str_real",
        },
        {
          ordinaryNew: true,
          scheduledTaskID: "stk_spoof",
          scheduledTaskRunID: "str_spoof",
        },
      ),
    ).toEqual({
      ordinaryNew: true,
      scheduledTaskID: "stk_real",
      scheduledTaskRunID: "str_real",
    })
  })

  test("replacement cannot invent producer origin on an ordinary Session", () => {
    expect(
      SessionMetadataOwnership.replaceCallerOwned(
        { ordinaryOld: true },
        {
          ordinaryNew: true,
          scheduledTaskID: "stk_spoof",
          specialAgent: "goal_auditor",
          specialAgentOwnerID: "owner",
        },
      ),
    ).toEqual({ ordinaryNew: true })
  })

  test("special-agent relation metadata survives caller replacement", () => {
    expect(
      SessionMetadataOwnership.replaceCallerOwned(
        {
          specialAgent: "goal_auditor",
          specialAgentOwnerKind: "goal",
          specialAgentOwnerID: "ses_parent\u0000goal_real",
          goalID: "goal_real",
          parentSessionID: "ses_parent",
          ordinaryOld: true,
        },
        {
          specialAgent: "prompt_revisor",
          specialAgentOwnerID: "spoof",
          goalID: "goal_spoof",
          parentSessionID: "ses_spoof",
          ordinaryNew: true,
        },
      ),
    ).toEqual({
      specialAgent: "goal_auditor",
      specialAgentOwnerKind: "goal",
      specialAgentOwnerID: "ses_parent\u0000goal_real",
      goalID: "goal_real",
      parentSessionID: "ses_parent",
      ordinaryNew: true,
    })
  })

  test("derived Sessions retain caller metadata but drop producer origin", () => {
    const nested = { strictSubagentModelPolicy: true }
    const source = {
      ordinary: "keep",
      localMcp: nested,
      scheduledTaskID: "stk_real",
      scheduledTaskRunID: "str_real",
      workerDelegation: {
        producer: "oxp",
        principalRef: "principal",
        invocationRef: "invocation",
        rootRef: "root",
        agent: "build",
        model: { providerID: "p", modelID: "m" },
        nestedDelegation: false,
      },
    }
    const derived = SessionMetadataOwnership.forDerivedSession(source)
    expect(
      derived,
    ).toEqual({
      ordinary: "keep",
      localMcp: { strictSubagentModelPolicy: true },
    })
    expect((derived?.localMcp as typeof nested) === nested).toBe(false)

    expect(
      SessionMetadataOwnership.forDerivedSession({
        specialAgent: "goal_auditor",
        specialAgentOwnerKind: "goal",
        specialAgentOwnerID: "owner",
        goalID: "goal_real",
        parentSessionID: "ses_parent",
      }),
    ).toBeUndefined()
  })

  test("worker delegation origin is protected, parsed explicitly, and preserved across caller replacement", () => {
    const origin = {
      producer: "oxp",
      principalRef: "oxp:connector",
      invocationRef: "invocation-1",
      rootRef: "root-1",
      agent: "build",
      model: {
        providerID: "workbuddy",
        modelID: "deepseek-v4.1-flash",
        accountID: "wb-account",
        variant: "max",
      },
      nestedDelegation: false,
    } as const
    const metadata = SessionMetadataOwnership.delegatedWorker({
      ...origin,
      metadata: { ordinary: true, workerDelegation: { producer: "spoof" } },
    })
    expect(SessionMetadataOwnership.workerDelegation(metadata)).toEqual(origin)
    expect(SessionMetadataOwnership.isProducerOwned(metadata)).toBe(true)
    expect(
      SessionMetadataOwnership.replaceCallerOwned(metadata, {
        ordinary: "next",
        workerDelegation: { producer: "spoof" },
      }),
    ).toEqual({
      ordinary: "next",
      workerDelegation: origin,
    })
  })

  test("malformed worker delegation metadata remains producer-owned but yields no executable policy", () => {
    const metadata = { workerDelegation: { producer: "oxp" } }
    expect(SessionMetadataOwnership.hasWorkerDelegationOrigin(metadata)).toBe(true)
    expect(SessionMetadataOwnership.isProducerOwned(metadata)).toBe(true)
    expect(SessionMetadataOwnership.workerDelegation(metadata)).toBeUndefined()
  })

  test("special-agent producer identity wins over extra metadata", () => {
    expect(
      SessionMetadataOwnership.specialAgent({
        agent: "goal_auditor",
        ownerKind: "goal",
        ownerID: "real-owner",
        metadata: {
          specialAgent: "prompt_revisor",
          specialAgentOwnerKind: "session",
          specialAgentOwnerID: "spoof-owner",
          goalID: "goal_real",
        },
      }),
    ).toEqual({
      specialAgent: "goal_auditor",
      specialAgentOwnerKind: "goal",
      specialAgentOwnerID: "real-owner",
      goalID: "goal_real",
    })
  })
})
