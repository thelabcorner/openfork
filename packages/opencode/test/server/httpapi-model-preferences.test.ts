import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"
import { it } from "../lib/effect"

function app() {
  return Server.Default().app
}

function patch(body: unknown) {
  return Effect.promise(() =>
    Promise.resolve(
      app().request("/global/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  )
}

type Document = {
  order?: Record<string, string[]>
  favorite?: string[]
  subProvider?: Record<string, string>
  updatedAt?: number
}

function read() {
  return Effect.promise(async () => {
    const response = await app().request("/global/preferences")
    return { status: response.status, body: (await response.json()) as Document }
  })
}

afterEach(async () => {
  // The document is one shared file in the (test-isolated) global state dir,
  // so it outlives a single case unless it is removed.
  await fs.rm(path.join(Global.Path.state, "model-preferences.json"), { force: true })
  await disposeAllInstances()
  await resetDatabase()
})

describe("model preferences HttpApi", () => {
  it.live(
    "round-trips the provider rail order the desktop pushes",
    Effect.gen(function* () {
      const written = yield* patch({ order: { "section:provider:rail": ["anthropic", "openrouter", "opencode"] } })
      expect(written.status).toBe(200)

      const result = yield* read()
      expect(result.status).toBe(200)
      expect(result.body.order?.["section:provider:rail"]).toEqual(["anthropic", "openrouter", "opencode"])
      expect(typeof result.body.updatedAt).toBe("number")
    }),
  )

  it.live(
    "merges partial writes instead of replacing the document",
    Effect.gen(function* () {
      // The desktop reorders its rail...
      yield* patch({ order: { "section:provider:rail": ["openai", "anthropic"] } })
      // ...and the phone, which never saw that write, toggles one favorite. A
      // whole-document PUT here would silently roll the rail order back.
      yield* patch({ favorite: ["anthropic:claude-sonnet-4"] })

      const result = yield* read()
      expect(result.body.order?.["section:provider:rail"]).toEqual(["openai", "anthropic"])
      expect(result.body.favorite).toEqual(["anthropic:claude-sonnet-4"])
    }),
  )

  it.live(
    "deletes a key listed in the patch's remove field",
    Effect.gen(function* () {
      yield* patch({ subProvider: { "openrouter:some/model": "novita" } })
      yield* patch({ remove: { subProvider: ["openrouter:some/model"] } })

      const result = yield* read()
      expect(result.body.subProvider).toBeUndefined()
    }),
  )

  it.live(
    "rejects a payload that exceeds the declared bounds",
    Effect.gen(function* () {
      const response = yield* patch({ favorite: [`x`.repeat(600)] })
      expect(response.status).toBe(400)
    }),
  )
})
