import { describe, expect, test } from "bun:test"
import { delegatedWorkerGroup } from "@opencode-ai/core/oxp-activity/delegation-group"

describe("OXP worker navigation ownership (pure Core projection)", () => {
  const group = (ref?: string, title?: string, rootRef = "root-a") =>
    delegatedWorkerGroup({
      principalRef: "oxp:connector-a",
      rootRef,
      ...(ref ? { parentSession: { ref, ...(title ? { title } : {}) } } : {}),
    })

  test("uses source-session identity, never its mutable display title or root", () => {
    const first = group("conversation-a", "Silica Fidelity")
    const renamed = group("conversation-a", "Silica Accuracy", "root-b")
    expect(first.id).toBe(renamed.id)
    expect(first.ownerRef).toBe(renamed.ownerRef)
    expect(first.name).toBe("Silica Fidelity")
    expect(renamed.name).toBe("Silica Accuracy")
    expect(first.authoritativeTitle).toBe(true)
  })

  test("identical titles in unrelated conversations cannot combine groups", () => {
    expect(group("conversation-a", "Research").id).not.toBe(group("conversation-b", "Research").id)
  })

  test("no title never authorizes replacing a known group name", () => {
    const unknown = group("conversation-a")
    expect(unknown.name).toBe("OXP session")
    expect(unknown.authoritativeTitle).toBe(false)
  })

  test("preserves the historic connector/root group for genuinely unattributed calls", () => {
    const legacy = group()
    expect(legacy.name).toBe("OXP delegated workers")
    expect(legacy.ownerRef).toBe("oxp:connector-a:root-a")
    expect(legacy.id).not.toBe(group("conversation-a").id)
  })
})
