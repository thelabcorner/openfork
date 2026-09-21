import { describe, expect, test } from "bun:test"
import { childEnvironment } from "@/oxp/process-environment"

describe("OXP process environment", () => {
  test("keeps ordinary toolchain state but does not inherit ambient secret values", () => {
    const env = childEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/example",
      LANG: "en_US.UTF-8",
      PUBLIC_URL: "https://example.test/public",
      OPENAI_API_KEY: "secret-openai",
      GH_TOKEN: "secret-gh",
      AWS_ACCESS_KEY_ID: "secret-access-id",
      AWS_SECRET_ACCESS_KEY: "secret-access-key",
      GOOGLE_APPLICATION_CREDENTIALS: "/home/example/google.json",
      DATABASE_URL: "postgres://user:password@example.test/database",
      HTTPS_PROXY: "https://proxy.example.test:8443",
    })

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/example",
      LANG: "en_US.UTF-8",
      PUBLIC_URL: "https://example.test/public",
      HTTPS_PROXY: "https://proxy.example.test:8443",
    })
  })
})
