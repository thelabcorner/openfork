import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { resolveNotificationSession } from "./notification-session"

const session = (directory: string) => ({ id: "ses_test", directory, parentID: undefined }) as Session

describe("resolveNotificationSession", () => {
  test("resolves global event sentinels through metadata without workspace hydration", async () => {
    const current = session("C:\\work\\project")
    let resolves = 0
    const owner = {
      get: () => undefined,
      resolve: async (_id: string, options?: { priority?: string }) => {
        resolves++
        expect(options?.priority).toBe("background")
        return current
      },
    }

    const result = await resolveNotificationSession(owner, "global", "ses_test")

    expect(result).toBe(current)
    expect(result?.directory).toBe("C:\\work\\project")
    expect(resolves).toBe(1)
  })

  test("uses cached metadata and rejects mismatched workspace events", async () => {
    const current = session("/work/project")
    let resolves = 0
    const owner = {
      get: () => current,
      resolve: async () => {
        resolves++
        return current
      },
    }

    expect(await resolveNotificationSession(owner, "/work/project/", "ses_test")).toBe(current)
    expect(await resolveNotificationSession(owner, "/other/project", "ses_test")).toBeUndefined()
    expect(resolves).toBe(1)
  })

  test("rejects invalid location sentinels before querying metadata", async () => {
    let resolves = 0
    const owner = {
      get: () => undefined,
      resolve: async () => {
        resolves++
        return session("/work/project")
      },
    }

    expect(await resolveNotificationSession(owner, "relative/project", "ses_test")).toBeUndefined()
    expect(await resolveNotificationSession(owner, "global", undefined)).toBeUndefined()
    expect(resolves).toBe(0)
  })
})
