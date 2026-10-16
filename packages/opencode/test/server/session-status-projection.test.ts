import { describe, expect, it } from "bun:test"
import { projectSessionStatus } from "../../src/server/routes/instance/httpapi/handlers/session-status-projection"
import type { Info } from "@opencode-ai/schema/session-status-event"

const busy: Info = { type: "busy" }
const interrupted: Info = { type: "interrupted" }
const retry: Info = { type: "retry", attempt: 2, message: "temporary failure", next: 3 }

describe("global session status projection", () => {
  it("drops cached activity without durable execution ownership", () => {
    expect(
      projectSessionStatus(
        { busy: busy, retry: retry, interrupted: interrupted },
        new Map(),
      ),
    ).toEqual({})
  })

  it("keeps retry detail only for an owned live generation", () => {
    expect(
      projectSessionStatus(
        { retry: retry, staleInterrupted: interrupted },
        new Map([
          ["retry", busy],
          ["staleInterrupted", busy],
          ["newlyWorking", busy],
        ]),
      ),
    ).toEqual({ retry, staleInterrupted: busy, newlyWorking: busy })
  })

  it("lets an interrupted durable generation override cached retry state", () => {
    expect(projectSessionStatus({ interrupted: retry }, new Map([["interrupted", interrupted]]))).toEqual({
      interrupted,
    })
  })
})

describe("directory session status projection", () => {
  it("uses the same durable-owner filter and preserves retry details for live owners", () => {
    expect(
      projectSessionStatus(
        { stale: busy, retry: retry },
        new Map([["retry", busy]]),
      ),
    ).toEqual({ retry })
  })
})
