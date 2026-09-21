import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { loadRootSessionsFast } from "./session-load"

describe("loadRootSessionsFast", () => {
  test("requests the existing Tier-0 root projection with project scope", async () => {
    const calls: unknown[] = []
    const result = await loadRootSessionsFast({
      client: {
        global: {
          sessionRoots: async (query: unknown) => {
            calls.push(query)
            return { data: [] }
          },
        },
      } as unknown as OpencodeClient,
      directory: "/project",
      projectID: "project-a",
      limit: 25,
    })

    expect(calls).toEqual([{ directory: "/project", projectID: "project-a", limit: "25" }])
    expect(result.data).toEqual([])
    expect(result.limited).toBe(true)
  })
})
