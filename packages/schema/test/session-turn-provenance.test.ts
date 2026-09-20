import { describe, expect, test } from "bun:test"
import { SessionTurnProvenance } from "../src/session-turn-provenance"

describe("SessionTurnProvenance browser-safe info policy", () => {
  test("keeps legacy unstamped user rows as the narrow compatibility fallback", () => {
    const info = { role: "user", id: "unbranded-browser-id" }
    expect(SessionTurnProvenance.semanticKindInfo(info)).toBe("user")
    expect(SessionTurnProvenance.isSemanticUserInfo(info)).toBe(true)
    expect(SessionTurnProvenance.isWorkerPromptInfo(info)).toBe(true)
  })

  test("separates worker roots, derived events, and replaceable state without branded ids", () => {
    const host = { role: "user", provenance: { owner: "host" as const, source: "host.prompt" } }
    const continuation = {
      role: "user",
      provenance: { owner: "host" as const, source: "goal.continuation", sourceMessageID: "msg_root" },
    }
    const state = {
      role: "user",
      provenance: { owner: "host" as const, source: "goal.progress", ref: "state-ref" },
    }

    expect(SessionTurnProvenance.isWorkerPromptInfo(host)).toBe(true)
    expect(SessionTurnProvenance.isHostPromptInfo(host)).toBe(true)
    expect(SessionTurnProvenance.isWorkerPromptInfo(continuation)).toBe(false)
    expect(SessionTurnProvenance.semanticKindInfo(continuation)).toBe("synthetic")
    expect(SessionTurnProvenance.isStateProjectionInfo(state)).toBe(true)
    expect(SessionTurnProvenance.isWorkerPromptInfo(state)).toBe(false)
    expect(SessionTurnProvenance.isSemanticUserInfo(state)).toBe(false)
  })

  test("does not grant canonical semantics to mismatched explicit ownership", () => {
    const forged = { role: "user", provenance: { owner: "user" as const, source: "goal.continuation" } }
    expect(SessionTurnProvenance.semanticKindInfo(forged)).toBe("user")
    expect(SessionTurnProvenance.isWorkerPromptInfo(forged)).toBe(false)
  })

  test("keeps Goal action roots user-owned and worker-authoritative without granting Goal creation authority", () => {
    for (const source of [SessionTurnProvenance.Source.GoalStart, SessionTurnProvenance.Source.GoalUpdate]) {
      const info = { role: "user", provenance: { owner: "user" as const, source } }
      expect(SessionTurnProvenance.semanticKindInfo(info)).toBe("user")
      expect(SessionTurnProvenance.isWorkerPromptInfo(info)).toBe(true)
      expect(SessionTurnProvenance.policy(source)?.durableUserActionAuthorization).toBeUndefined()
    }
  })

  test("classifies every first-party special agent as host synthetic and never as a worker root", () => {
    for (const source of [
      SessionTurnProvenance.Source.PromptRevisor,
      SessionTurnProvenance.Source.GoalRevisor,
      SessionTurnProvenance.Source.SessionTitle,
      SessionTurnProvenance.Source.GoalAuditor,
      SessionTurnProvenance.Source.SpadAuditor,
    ]) {
      const info = { role: "user", provenance: { owner: "host" as const, source } }
      expect(SessionTurnProvenance.semanticKindInfo(info)).toBe("synthetic")
      expect(SessionTurnProvenance.isWorkerPromptInfo(info)).toBe(false)
      expect(SessionTurnProvenance.isSemanticUserInfo(info)).toBe(false)
    }
  })

  test("historical provenance preserves presentation while revoking live execution semantics", () => {
    const user = {
      role: "user",
      provenance: { owner: "user" as const, source: SessionTurnProvenance.Source.Prompt, lifetime: "historical" as const },
    }
    const host = {
      role: "user",
      provenance: { owner: "host" as const, source: SessionTurnProvenance.Source.HostPrompt, lifetime: "historical" as const },
    }
    const state = {
      role: "user",
      provenance: {
        owner: "host" as const,
        source: SessionTurnProvenance.Source.GoalProgress,
        lifetime: "historical" as const,
      },
    }

    expect(SessionTurnProvenance.isSemanticUserInfo(user)).toBe(true)
    expect(SessionTurnProvenance.isWorkerPromptInfo(user)).toBe(false)
    expect(SessionTurnProvenance.isWorkerPromptInfo(host)).toBe(false)
    expect(SessionTurnProvenance.isHostPromptInfo(host)).toBe(false)
    expect(SessionTurnProvenance.isStateProjectionInfo(state)).toBe(false)
  })
})
