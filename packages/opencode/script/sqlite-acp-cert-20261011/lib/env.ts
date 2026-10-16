/// <reference types="bun" />
// Host environment construction. Every host runs against a disposable fixture
// database with a pinned synthetic HOME/XDG root, a local-only provider config,
// and no inherited OpenFork overrides or provider API keys.

import { join } from "node:path"
import type { DriverMode } from "./args"
import type { Fixture } from "./fixture"

export type CertEnv = {
  readonly env: Record<string, string>
  readonly certKeys: Record<string, string>
  readonly removedKeys: string[]
}

function providerConfig(baseURL: string): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "test/test-model",
    formatter: false,
    lsp: false,
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL },
      },
    },
  })
}

const SECRET_PATTERN = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/i

export function buildCertEnv(
  fixture: Fixture,
  driver: DriverMode,
  options?: { baseURL?: string },
): CertEnv {
  const env: Record<string, string> = {}
  const removedKeys: string[] = []
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith("OPENCODE_") || SECRET_PATTERN.test(key)) {
      removedKeys.push(key)
      continue
    }
    env[key] = value
  }

  const home = fixture.home
  const certKeys: Record<string, string> = {
    OPENCODE_TEST_HOME: home,
    HOME: home,
    TEMP: join(fixture.root, "tmp"),
    TMP: join(fixture.root, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OPENCODE_CONFIG_CONTENT: providerConfig(options?.baseURL ?? "http://127.0.0.1:9"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_DB: fixture.db,
    OPENCODE_DISABLE_CHANNEL_DB: "1",
  }

  if (driver === "optout") {
    certKeys.OPENFORK_SQLITE_ASYNC_PRIMARY = "0"
    certKeys.OPENFORK_SQLITE_ASYNC_READ_WORKER = "0"
  }

  Object.assign(env, certKeys)
  return { env, certKeys, removedKeys }
}

export function configContent(env: Record<string, string>): string {
  return env.OPENCODE_CONFIG_CONTENT ?? ""
}
