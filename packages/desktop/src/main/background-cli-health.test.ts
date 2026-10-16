import { describe, expect, test } from "bun:test"
import { waitForBackgroundService } from "./background-cli-health"

describe("background CLI service readiness", () => {
  test("waits for the authenticated process-wide health endpoint before startup is ready", async () => {
    let now = 0
    let calls = 0
    const requests: Array<{ url: string; authorization: string | null }> = []

    await waitForBackgroundService(
      { url: "http://127.0.0.1:49374", username: "opencode", password: "sidecar-secret" },
      {
        timeoutMs: 1_000,
        intervalMs: 25,
        now: () => now,
        sleep: async (ms) => { now += ms },
        fetcher: async (url, init) => {
          calls++
          requests.push({
            url: url.toString(),
            authorization: new Headers(init.headers).get("authorization"),
          })
          return { ok: calls === 3, status: calls === 3 ? 200 : 503 }
        },
      },
    )

    expect(calls).toBe(3)
    expect(requests.map((request) => request.url)).toEqual(Array(3).fill("http://127.0.0.1:49374/global/health"))
    expect(requests.map((request) => request.authorization)).toEqual(
      Array(3).fill(`Basic ${Buffer.from("opencode:sidecar-secret").toString("base64")}`),
    )
  })

  test("fails within a fixed deadline instead of advertising a dead daemon", async () => {
    let now = 0
    let calls = 0
    const error = await waitForBackgroundService(
      { url: "http://127.0.0.1:49374", username: "opencode", password: "sidecar-secret" },
      {
        timeoutMs: 500,
        intervalMs: 100,
        now: () => now,
        sleep: async (ms) => { now += ms },
        fetcher: async () => {
          calls++
          return { ok: false, status: 503 }
        },
      },
    ).then(() => undefined, (reason: unknown) => reason)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("/global/health")
    expect((error as Error).message).toContain("500 ms (HTTP 503)")
    expect(now).toBe(500)
    expect(calls).toBe(5)
  })
})
