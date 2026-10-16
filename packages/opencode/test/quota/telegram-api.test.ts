import { describe, expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { OpenCodeHttpApi, RootHttpApi } from "../../src/server/routes/instance/httpapi/api"

describe("first-party Telegram HTTP surface", () => {
  test("publishes Telegram and quota service operations as a distinct Tier-0 API", () => {
    const paths = OpenApi.fromApi(OpenCodeHttpApi).paths ?? {}
    const expected = {
      "/global/telegram": ["get", "patch"],
      "/global/telegram/bot": ["post", "delete"],
      "/global/telegram/pairing": ["post"],
      "/global/telegram/pairing/check": ["post"],
      "/global/telegram/test": ["post"],
      "/global/telegram/services/quota": ["get", "patch"],
    } satisfies Record<string, string[]>
    for (const [pathname, methods] of Object.entries(expected)) {
      expect(Object.keys(paths[pathname] ?? {}).sort()).toEqual(methods.sort())
    }
  })

  test("does not inject Telegram into RootHttpApi fixture dependencies", () => {
    const paths = OpenApi.fromApi(RootHttpApi).paths ?? {}
    expect(Object.keys(paths).some((pathname) => pathname.startsWith("/global/telegram"))).toBe(false)
  })
})
