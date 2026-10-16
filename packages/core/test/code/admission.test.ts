import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SavedCodeAdmission } from "@opencode-ai/core/code/admission"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, SavedCodeAdmission.node]),
    [],
  ),
)

const base = {
  scopeKind: "project" as const,
  scopeKey: "C:/repo-a",
  savedID: "find_todos",
  revision: "sha256:revision-a",
  sourceHash: "sha256:source-a",
  origin: "code-save" as const,
  originRunID: "run:prt_origin_a",
}

describe("SavedCodeAdmission", () => {
  it.effect("admits and retrieves the exact trust tuple without source bytes", () =>
    Effect.gen(function* () {
      const service = yield* SavedCodeAdmission.Service
      const admitted = yield* service.admit(base)
      const loaded = yield* service.get(base)

      expect(loaded).toEqual(admitted)
      expect(admitted).toMatchObject(base)
      expect(Object.keys(admitted).sort()).toEqual([
        "admittedAt",
        "origin",
        "originRunID",
        "revision",
        "savedID",
        "scopeKey",
        "scopeKind",
        "sourceHash",
      ])
    }),
  )

  it.effect("is idempotent across later saves of the same exact revision", () =>
    Effect.gen(function* () {
      const service = yield* SavedCodeAdmission.Service
      const first = yield* service.admit(base)
      const second = yield* service.admit({
        ...base,
        originRunID: "run:prt_origin_b",
      })

      expect(second).toEqual(first)
      expect(second.originRunID).toBe("run:prt_origin_a")
    }),
  )

  it.effect("fails closed when one executable revision maps to different source bytes", () =>
    Effect.gen(function* () {
      const service = yield* SavedCodeAdmission.Service
      yield* service.admit(base)
      const error = yield* service
        .admit({ ...base, sourceHash: "sha256:source-corrupt" })
        .pipe(
          Effect.map(() => undefined),
          Effect.catch((cause) => Effect.succeed(cause)),
        )

      expect(error).toBeInstanceOf(SavedCodeAdmission.IntegrityError)
      expect((error as SavedCodeAdmission.IntegrityError).message).toContain("different source hash")
    }),
  )

  it.effect("revocation removes callability without touching any source owner", () =>
    Effect.gen(function* () {
      const service = yield* SavedCodeAdmission.Service
      const admitted = yield* service.admit(base)
      yield* service.revoke(admitted)
      expect(yield* service.get(admitted)).toBeUndefined()
    }),
  )

  it.effect("keeps project physical scopes independent", () =>
    Effect.gen(function* () {
      const service = yield* SavedCodeAdmission.Service
      const first = yield* service.admit(base)
      const second = yield* service.admit({
        ...base,
        scopeKey: "C:/repo-b",
        originRunID: "run:prt_origin_b",
      })

      expect(first.scopeKey).not.toBe(second.scopeKey)
      expect(yield* service.get({ ...base, scopeKey: "C:/repo-a" })).toBeDefined()
      expect(yield* service.get({ ...base, scopeKey: "C:/repo-b" })).toBeDefined()
    }),
  )

  it.effect("lists one physical scope in one indexed read", () =>
    Effect.gen(function* () {
      const service = yield* SavedCodeAdmission.Service
      yield* service.admit(base)
      yield* service.admit({
        ...base,
        savedID: "summarize",
        revision: "sha256:revision-b",
        sourceHash: "sha256:source-b",
      })
      yield* service.admit({
        ...base,
        scopeKey: "C:/other",
        savedID: "foreign",
        revision: "sha256:revision-c",
        sourceHash: "sha256:source-c",
      })

      const rows = yield* service.list({ scopeKind: "project", scopeKey: "C:/repo-a" })
      expect(rows.map((row) => row.savedID).sort()).toEqual(["find_todos", "summarize"])
    }),
  )
})
