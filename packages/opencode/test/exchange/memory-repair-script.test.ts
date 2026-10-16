/**
 * Exercising the operator-facing executable (not merely the underlying
 * SessionSearch.repairChunk API) against a disposable SQLite database.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DateTime, Effect, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionSearch } from "@opencode-ai/core/session/search"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"

const script = join(import.meta.dir, "../../script/repair-memory-session-index.ts")
const inspectScript = join(import.meta.dir, "../../script/inspect-memory-session-index.ts")
const cwd = join(import.meta.dir, "../..")
function invoke(args: string[], entry = script) {
  const result = Bun.spawnSync(["bun", "run", entry, ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

describe("historical repair CLI / disposable database", () => {
  test("invalid CLI requests cannot mutate an unspecified database", () => {
    const missing = invoke([])
    expect(missing.exitCode).toBe(2)
    expect(missing.stdout).toBe("")
    const relative = invoke(["--db", "./not-approved.db"])
    expect(relative.exitCode).toBe(2)
    const invalidBudget = invoke(["--db", "/nonexistent/repair.db", "--rows", "-1"])
    expect(invalidBudget.exitCode).toBe(2)
    expect(invoke([], inspectScript).exitCode).toBe(2)
    expect(invoke(["--db", "./no.db"], inspectScript).exitCode).toBe(2)
  }, 30_000)

  test("the CLI performs one bounded resumable maintenance pass and retains scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openfork-cli-repair-"))
    const filename = join(dir, "fixture.db")
    try {
      const layer = AppNodeBuilder.build(
        LayerNode.group([Database.node]),
        [[Database.node, Database.layerFromPath(filename)]],
      )
      await Effect.runPromise(Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.insert(ProjectTable).values({
          id: ProjectV2.ID.global, worktree: AbsolutePath.make("/allowed"), sandboxes: [],
        }).run().pipe(Effect.orDie)
        const sessionID = SessionSchema.ID.make("ses_cli_repair_allowed")
        yield* db.insert(SessionTable).values({
          id: sessionID, project_id: ProjectV2.ID.global, slug: "cli-repair",
          directory: "/allowed/project", title: "Ordinary session", version: "test",
        }).run().pipe(Effect.orDie)
        const message = SessionMessage.User.make({
          id: SessionMessage.ID.make("msg_cli_repair"),
          type: "user", text: "precisecaraway historical note about the importer",
          time: { created: DateTime.makeUnsafe(1234) },
        })
        const { id, type, ...data } = Schema.encodeSync(SessionMessage.Message)(message)
        yield* db.insert(SessionMessageTable).values({
          id: SessionMessage.ID.make(id), session_id: sessionID,
          type, seq: 1, data, time_created: 1234, search_text: "",
        }).run().pipe(Effect.orDie)
        expect((yield* SessionSearch.search(db, { query: "precisecaraway" })).messageMatches).toHaveLength(0)
        const pending = invoke(["--db", filename], inspectScript)
        expect(pending.exitCode).toBe(0)
        const initial = JSON.parse(pending.stdout)
        expect(initial.readOnly).toBe(true)
        expect(initial.complete).toBe(false)
        expect(initial.sources).toHaveLength(5)
        expect(initial.sources.find((item: { name: string }) => item.name === "v2ToolIndexReady"))
          .toMatchObject({ sourceMaxRowid: 1, ready: false })
        expect(pending.stdout).not.toContain(filename)
        const first = invoke(["--db", filename, "--rows", "1", "--timeout-ms", "3000"])
        expect(first.exitCode).toBe(0)
        const a = JSON.parse(first.stdout)
        expect(a.action).toBe("bounded-session-index-repair")
        expect(a.rowsBudgetPerStore).toBe(1)
        expect(a.sessionMessages).toMatchObject({ processed: 1, done: false })
        expect(a.complete).toBe(false)
        const second = invoke(["--db", filename, "--rows", "1", "--timeout-ms", "3000"])
        expect(second.exitCode).toBe(0)
        const b = JSON.parse(second.stdout)
        expect(b.complete).toBe(true)
        const finished = invoke(["--db", filename], inspectScript)
        expect(finished.exitCode).toBe(0)
        const status = JSON.parse(finished.stdout)
        expect(status.complete).toBe(true)
        expect(status.sources.every((item: { ready: boolean }) => item.ready)).toBe(true)
        // Empty historical stores legitimately converge with cursor -1.
        expect(status.sources.find((item: { name: string }) => item.name === "v2MessageIndexReady"))
          .toMatchObject({ watermarkRowid: 1, ready: true, sourceMaxRowid: 1 })
        expect(status.sources.every((item: { watermarkRowid: number | null }) =>
          item.watermarkRowid !== null)).toBe(true)
        const recall = yield* SessionSearch.search(db, {
          query: "precisecaraway", directoryPrefixes: ["/allowed"], limit: 5,
        })
        expect(recall.messageMatches[0]?.messageID).toBe(message.id)
        const forbidden = yield* SessionSearch.search(db, {
          query: "precisecaraway", directoryPrefixes: ["/forbidden"], limit: 5,
        })
        expect(forbidden.messageMatches).toHaveLength(0)
      }).pipe(Effect.scoped, Effect.provide(layer)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
