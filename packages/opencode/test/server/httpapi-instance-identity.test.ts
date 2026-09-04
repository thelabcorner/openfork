import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import {
  INSTANCE_ID_ENV,
  INSTANCE_IDENTITY_PATH,
  instanceIdentity,
} from "../../src/server/shared/instance-identity"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

function app(input: { password?: string } = {}) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: input.password })),
      ),
    ),
    { disableLogger: true },
  ).handler
  return (path: string, init?: RequestInit) =>
    handler(new Request(new URL(path, "http://localhost"), init), HttpApiApp.context)
}

async function withEnv<T>(key: string, value: string | undefined, run: () => T | Promise<T>) {
  const previous = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    // Awaited inside the try: the route reads the env var when the handler
    // runs, not when the request promise is created.
    return await run()
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("instanceIdentity", () => {
  test("echoes the launcher-supplied instance id", async () => {
    const identity = await withEnv(INSTANCE_ID_ENV, "desktop:abc-123", () => instanceIdentity())
    expect(identity.instanceID).toBe("desktop:abc-123")
    expect(identity.processID).toBe(process.pid)
    expect(identity.version).toBeString()
    expect(Number.isNaN(Date.parse(identity.startedAt))).toBe(false)
  })

  test("trims whitespace and ignores a blank id", async () => {
    expect((await withEnv(INSTANCE_ID_ENV, "  padded  ", () => instanceIdentity())).instanceID).toBe("padded")
    expect((await withEnv(INSTANCE_ID_ENV, "   ", () => instanceIdentity())).instanceID).toStartWith("anon:")
  })

  test("falls back to a stable anon id nobody can be mistaken for", async () => {
    const first = await withEnv(INSTANCE_ID_ENV, undefined, () => instanceIdentity())
    const second = await withEnv(INSTANCE_ID_ENV, undefined, () => instanceIdentity())
    expect(first.instanceID).toStartWith("anon:")
    // Stable within a process: a client pins this value and re-checks it, so a
    // regenerating id would look like a server swap on every poll.
    expect(second.instanceID).toBe(first.instanceID)
  })

  test("carries no user data", async () => {
    const identity = await withEnv(INSTANCE_ID_ENV, "desktop:abc-123", () => instanceIdentity())
    expect(Object.keys(identity).sort()).toEqual(["instanceID", "processID", "startedAt", "version"])
  })
})

describe("GET /instance/identity", () => {
  test("answers without credentials even when the server has a password", async () => {
    const request = app({ password: "secret" })
    const response = await withEnv(INSTANCE_ID_ENV, "desktop:route-test", () => request(INSTANCE_IDENTITY_PATH))
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = (await response.json()) as { instanceID: string; processID: number }
    expect(body.instanceID).toBe("desktop:route-test")
    expect(body.processID).toBe(process.pid)
  })

  test("does not need an instance directory header", async () => {
    const response = await app()(INSTANCE_IDENTITY_PATH)
    expect(response.status).toBe(200)
    expect((await response.json()).instanceID).toBeString()
  })
})
