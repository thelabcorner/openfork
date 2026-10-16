import { describe, expect, test } from "bun:test"
import { swarmArgumentDiagnostic, SWARM_FOCUSED_ACTIONS } from "@/oxp/swarm-focus"

describe("Swarm AX focused error recovery", () => {
  test("corrects missing fields without reflecting untrusted payloads", () => {
    const result = swarmArgumentDiagnostic({
      rootID: "root", action: "task.batch", tasks: [],
      body: "do-not-leak-this-peer-message", metadata: { token: "do-not-leak" },
    })
    expect(result).toContain("missing: swarmId")
    expect(result).toContain("tasks must contain 1-8 entries")
    expect(result).toContain("focusAction=task.batch")
    expect(result).not.toContain("do-not-leak")
  })

  test("explains conditional messages and settlements", () => {
    const message = swarmArgumentDiagnostic({
      rootID: "root", swarmId: "sw_1", action: "message.send", body: "private",
      broadcast: true, targetMemberId: "another-private-value",
    })
    expect(message).toContain("OR broadcast=true")
    expect(message).not.toContain("another-private-value")
    expect(message).not.toContain("private")
    const settlement = swarmArgumentDiagnostic({
      rootID: "root", swarmId: "sw_1", action: "task.settle", sessionID: "sid", settlement: "failed",
    })
    expect(settlement).toContain("failureKind is required")
  })

  test("never suggests forbidden operator or force authority", () => {
    const force = swarmArgumentDiagnostic({
      rootID: "root", action: "delegate", swarmName: "name", force: true,
    })
    expect(force).toContain("native-only")
    expect(SWARM_FOCUSED_ACTIONS["admin.contain"]).toBeUndefined()
    expect(swarmArgumentDiagnostic({ action: "admin.contain", body: "sensitive" }))
      .toContain("connector-supported action")
  })

  test("guides invalid requestKey syntax without echoing the supplied key", () => {
    const invalid = swarmArgumentDiagnostic({
      action: "delegate", rootID: "root", swarmName: "example",
      requestKey: "secret agent note",
    })
    expect(invalid).toContain("requestKey must be 1-128")
    expect(invalid).not.toContain("secret agent note")
  })
})
