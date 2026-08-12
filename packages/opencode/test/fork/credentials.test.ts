import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ForkCredentials } from "../../src/fork/credentials"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([ForkCredentials.node, Database.node])))

describe("ForkCredentials", () => {
  it.effect("adding a key marks it active; a second key does not steal activity automatically", () =>
    Effect.gen(function* () {
      const credentials = yield* ForkCredentials.Service
      const first = yield* credentials.add({ key: "sk-first", label: "Personal" })
      expect(first.active).toBe(true)

      const second = yield* credentials.add({ key: "sk-second", label: "Work" })
      expect(second.active).toBe(false)

      const list = yield* credentials.list()
      expect(list.map((item) => item.label)).toEqual(["Personal", "Work"])

      const active = yield* credentials.active()
      expect(active?.id).toBe(first.id)
    }),
  )

  it.effect("select switches the active credential", () =>
    Effect.gen(function* () {
      const credentials = yield* ForkCredentials.Service
      const first = yield* credentials.add({ key: "sk-first", label: "Personal" })
      const second = yield* credentials.add({ key: "sk-second", label: "Work" })

      yield* credentials.select(second.id)
      expect((yield* credentials.active())?.id).toBe(second.id)

      const list = yield* credentials.list()
      expect(list.find((item) => item.id === first.id)?.active).toBe(false)
      expect(list.find((item) => item.id === second.id)?.active).toBe(true)
    }),
  )

  it.effect("removing the active credential falls back to the newest remaining one", () =>
    Effect.gen(function* () {
      const credentials = yield* ForkCredentials.Service
      const first = yield* credentials.add({ key: "sk-first", label: "Personal" })
      const second = yield* credentials.add({ key: "sk-second", label: "Work" })
      yield* credentials.select(second.id)

      yield* credentials.remove(second.id)
      expect((yield* credentials.active())?.id).toBe(first.id)
    }),
  )

  it.effect("rename updates the label without touching activity", () =>
    Effect.gen(function* () {
      const credentials = yield* ForkCredentials.Service
      const created = yield* credentials.add({ key: "sk-first", label: "Personal" })
      yield* credentials.rename(created.id, "Renamed")
      const list = yield* credentials.list()
      expect(list[0]?.label).toBe("Renamed")
      expect(list[0]?.active).toBe(true)
    }),
  )

  it.effect("rename preserves message-to-credential association", () =>
    Effect.gen(function* () {
      const credentials = yield* ForkCredentials.Service
      const created = yield* credentials.add({ key: "sk-first", label: "Personal" })
      yield* credentials.recordUsage({ messageID: "msg_1", credentialID: created.id })
      yield* credentials.rename(created.id, "Renamed")

      const attribution = yield* credentials.credentialsForMessages(["msg_1"])
      expect(attribution.get("msg_1")).toBe(created.id)
    }),
  )

  it.effect("recordUsage and credentialsForMessages round-trip", () =>
    Effect.gen(function* () {
      const credentials = yield* ForkCredentials.Service
      const created = yield* credentials.add({ key: "sk-first", label: "Personal" })
      yield* credentials.recordUsage({ messageID: "msg_1", credentialID: created.id })
      yield* credentials.recordUsage({ messageID: "msg_2", credentialID: created.id })

      const attribution = yield* credentials.credentialsForMessages(["msg_1", "msg_2", "msg_missing"])
      expect(attribution.get("msg_1")).toBe(created.id)
      expect(attribution.get("msg_2")).toBe(created.id)
      expect(attribution.has("msg_missing")).toBe(false)
    }),
  )

  it.effect("credentialsForMessages handles more message IDs than one SQLite IN clause allows", () =>
    Effect.gen(function* () {
      const credentials = yield* ForkCredentials.Service
      const created = yield* credentials.add({ key: "sk-first", label: "Personal" })
      const count = 1200
      const ids = Array.from({ length: count }, (_, i) => `bulk_${i}`)
      for (const id of ids) yield* credentials.recordUsage({ messageID: id, credentialID: created.id })

      const attribution = yield* credentials.credentialsForMessages(ids)
      expect(attribution.size).toBe(count)
      for (const id of ids) expect(attribution.get(id)).toBe(created.id)
    }),
  )

  it.effect("backfills opencode-go assistant messages when only one credential exists", () =>
    Effect.gen(function* () {
      const credentials = yield* ForkCredentials.Service
      const database = yield* Database.Service
      const created = yield* credentials.add({ key: "sk-first", label: "Migrated key" })

      yield* database.db
        .run(
          sql`
            INSERT INTO project (id, time_created, time_updated, worktree, sandboxes)
            VALUES (${"proj_backfill"}, ${1}, ${1}, ${"C:/tmp/project"}, ${JSON.stringify(["C:/tmp/project"])})
          `,
        )
        .pipe(Effect.orDie)
      yield* database.db
        .run(
          sql`
            INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
            VALUES (${"ses_backfill"}, ${"proj_backfill"}, ${"backfill"}, ${"C:/tmp/project"}, ${"Backfill"}, ${"test"}, ${1}, ${1})
          `,
        )
        .pipe(Effect.orDie)

      yield* database.db
        .run(
          sql`
            INSERT INTO message (id, session_id, time_created, time_updated, data)
            VALUES
              (
                ${"msg_go"},
                ${"ses_backfill"},
                ${1},
                ${1},
                ${JSON.stringify({
                  id: "msg_go",
                  sessionID: "ses_backfill",
                  role: "assistant",
                  providerID: "opencode-go",
                  cost: 1,
                  time: { created: 1 },
                })}
              ),
              (
                ${"msg_zen"},
                ${"ses_backfill"},
                ${1},
                ${1},
                ${JSON.stringify({
                  id: "msg_zen",
                  sessionID: "ses_backfill",
                  role: "assistant",
                  providerID: "opencode",
                  cost: 1,
                  time: { created: 1 },
                })}
              )
          `,
        )
        .pipe(Effect.orDie)

      const attribution = yield* credentials.credentialsForMessages(["msg_go", "msg_zen"])
      expect(attribution.get("msg_go")).toBe(created.id)
      expect(attribution.has("msg_zen")).toBe(false)
    }),
  )

  it.effect("does not backfill usage when multiple credentials exist", () =>
    Effect.gen(function* () {
      const credentials = yield* ForkCredentials.Service
      const database = yield* Database.Service
      yield* credentials.add({ key: "sk-first", label: "Personal" })
      yield* credentials.add({ key: "sk-second", label: "Work" })

      yield* database.db
        .run(
          sql`
            INSERT INTO project (id, time_created, time_updated, worktree, sandboxes)
            VALUES (${"proj_backfill"}, ${1}, ${1}, ${"C:/tmp/project"}, ${JSON.stringify(["C:/tmp/project"])})
          `,
        )
        .pipe(Effect.orDie)
      yield* database.db
        .run(
          sql`
            INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
            VALUES (${"ses_backfill"}, ${"proj_backfill"}, ${"backfill"}, ${"C:/tmp/project"}, ${"Backfill"}, ${"test"}, ${1}, ${1})
          `,
        )
        .pipe(Effect.orDie)

      yield* database.db
        .run(
          sql`
            INSERT INTO message (id, session_id, time_created, time_updated, data)
            VALUES (
              ${"msg_ambiguous"},
              ${"ses_backfill"},
              ${1},
              ${1},
              ${JSON.stringify({
                id: "msg_ambiguous",
                sessionID: "ses_backfill",
                role: "assistant",
                providerID: "opencode-go",
                cost: 1,
                time: { created: 1 },
              })}
            )
          `,
        )
        .pipe(Effect.orDie)

      const attribution = yield* credentials.credentialsForMessages(["msg_ambiguous"])
      expect(attribution.has("msg_ambiguous")).toBe(false)
    }),
  )
})
