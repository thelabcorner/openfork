import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OxpConfig } from "@/oxp/config"
import { OxpGrounding } from "@/oxp/grounding"
import { OxpRead } from "@/oxp/read"
import { OxpRoot } from "@/oxp/root"
import { drainCodingActivity, subscribeCodingActivity } from "../lib/coding-activity"
import { testEffect } from "../lib/effect"

/**
 * OXP read -> CodingActivity attribution.
 *
 * The shared exchange read is the ONE lower producer for a committed OXP read;
 * these tests assert that it stays the only one, and that the project identity
 * it records comes from the approved root the call's admission re-verified rather
 * than from the absolute `/alias/...` virtual path spelling, which the kernel's
 * display-path heuristic can only resolve to a containing directory.
 */

const suite = path.join(os.tmpdir(), `opencode-oxp-read-attribution-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const globalLayer = Global.layerWith({ config: configDir, state: stateDir })
const layer = AppNodeBuilder.build(
  LayerNode.group([OxpRead.node, OxpRoot.node, OxpConfig.node, OxpGrounding.node]),
  [[Global.node, globalLayer]],
)
const it = testEffect(layer)

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})

afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

const write = (target: string, content: string) => Effect.promise(async () => {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
})

describe("OXP read attributes the canonical approved root", () => {
  it.live(
    "a file at the root and a deeply nested file record one read each under one project",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      // `holder`, `src` and `deep` are all real ancestor directory names, so any
      // parent-directory or alias heuristic would surface one of them instead of
      // the project.
      const rootDir = path.join(suite, "holder", "repo")
      const top = path.join(rootDir, "top.txt")
      const nested = path.join(rootDir, "src", "deep", "a.ts")
      yield* write(top, "alpha\n")
      yield* write(nested, "export const a = 1\n")
      const root = yield* roots.approve(rootDir, "totally-different")
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const log = yield* subscribeCodingActivity

      const first = yield* read.execute({ rootID: root.id, path: "top.txt" })
      const second = yield* read.execute({ rootID: root.id, path: "src/deep/a.ts" })
      // The caller-visible result is unchanged: still only virtual paths.
      expect(first.output).toContain(`/${root.alias}/top.txt`)
      expect(second.output).toContain(`/${root.alias}/src/deep/a.ts`)
      expect(first.output).not.toContain(rootDir)

      const events = yield* drainCodingActivity(log, "oxp-read-root-nested")
      const mine = events.filter((event) => event.source === "oxp")
      expect(mine.map((event) => event.entity).slice().sort()).toEqual([top, nested].slice().sort())
      // The approved root this call's admission re-verified is the only directory
      // this boundary may name, so entity depth cannot change it.
      const canonical = (yield* roots.resolvePath(`/${root.alias}`)).canonicalPath
      for (const event of mine) {
        expect(event.kind).toBe("read")
        expect(event.project).toBe("repo")
        expect(event.projectFolder).toBe(canonical)
        expect(path.isAbsolute(event.projectFolder!)).toBe(true)
        // No canonical OXP principal is proven at this boundary, so no sourceRef
        // is invented; an alias or a synthesized per-call key would both be wrong.
        expect(event.sourceRef).toBeUndefined()
      }
      expect([...new Set(mine.map((event) => event.project))]).toEqual(["repo"])
      // The alias is a renameable public spelling and the parent directories are
      // real names; none of them may stand in for the approved root.
      for (const leaked of ["totally-different", "holder", "repo-holder", "src", "deep"]) {
        expect(mine.map((event) => event.project)).not.toContain(leaked)
        expect(mine.map((event) => event.projectFolder)).not.toContain(leaked)
      }
      expect(mine.map((event) => event.projectFolder)).not.toContain(`/${root.alias}`)
    }),
  )

  it.live(
    "one read publishes exactly one record, including a repeated read of one file",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const rootDir = path.join(suite, "holder", "single")
      const target = path.join(rootDir, "a.ts")
      yield* write(target, "export const a = 1\n")
      const root = yield* roots.approve(rootDir, "public-alias")
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const log = yield* subscribeCodingActivity

      yield* read.execute({ rootID: root.id, path: "a.ts" })
      yield* read.execute({ path: `/${root.alias}/a.ts` })

      const events = yield* drainCodingActivity(log, "oxp-read-single")
      const mine = events.filter((event) => event.source === "oxp")
      expect(mine).toHaveLength(2)
      const canonical = (yield* roots.resolvePath(`/${root.alias}`)).canonicalPath
      for (const event of mine) {
        expect(event.entity).toBe(target)
        expect(event.project).toBe("single")
        // Enrichment rides on the record the exchange read already published, so
        // two reads of one file stay two records rather than becoming four.
        expect(event.projectFolder).toBe(canonical)
      }
    }),
  )

  it.live(
    "a batched read attributes each file to the root its own window resolved against",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const alphaDir = path.join(suite, "holder", "alpha-repo")
      const betaDir = path.join(suite, "holder", "beta-repo")
      const alphaTarget = path.join(alphaDir, "pkg", "a.ts")
      const betaTarget = path.join(betaDir, "pkg", "b.ts")
      yield* write(alphaTarget, "alpha\n")
      yield* write(betaTarget, "beta\n")
      const alpha = yield* roots.approve(alphaDir, "first-alias")
      const beta = yield* roots.approve(betaDir, "second-alias")
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const log = yield* subscribeCodingActivity

      const result = yield* read.execute({
        reads: [
          { rootID: alpha.id, path: "pkg/a.ts" },
          { rootID: beta.id, path: "pkg/b.ts" },
        ],
      })
      expect(result.output).toContain(`/${alpha.alias}/pkg/a.ts`)
      expect(result.output).toContain(`/${beta.alias}/pkg/b.ts`)

      const events = yield* drainCodingActivity(log, "oxp-read-batch")
      const mine = events.filter((event) => event.source === "oxp")
      expect(mine).toHaveLength(2)
      expect(Object.fromEntries(mine.map((event) => [event.entity, event.project]))).toEqual({
        [alphaTarget]: "alpha-repo",
        [betaTarget]: "beta-repo",
      })
      // Each window resolved against its own root, so each record carries its own
      // root folder and neither borrows the other's.
      expect(Object.fromEntries(mine.map((event) => [event.entity, event.projectFolder]))).toEqual({
        [alphaTarget]: (yield* roots.resolvePath(`/${alpha.alias}`)).canonicalPath,
        [betaTarget]: (yield* roots.resolvePath(`/${beta.alias}`)).canonicalPath,
      })
    }),
  )
})

describe("OXP read attribution stays silent for non-reads", () => {
  it.live(
    "a directory listing, a missing target, a path escape, and a cancelled read record nothing",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const read = yield* OxpRead.Service
      const rootDir = path.join(suite, "holder", "silent")
      const nested = path.join(rootDir, "src", "a.ts")
      yield* write(nested, "a\n")
      const root = yield* roots.approve(rootDir, "public-alias")
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const log = yield* subscribeCodingActivity

      const directory = yield* read.execute({ rootID: root.id, path: "src" })
      expect(directory.metadata?.directory).toBe(true)

      const missing = yield* read.execute({ rootID: root.id, path: "src/missing.ts" }).pipe(Effect.flip)
      expect(missing._tag).toBe("OXP_NOT_FOUND")

      const escape = yield* read.execute({ rootID: root.id, path: "../escape.ts" }).pipe(Effect.flip)
      expect(escape._tag).toBe("OXP_PATH_ESCAPE")

      const controller = new AbortController()
      controller.abort()
      const cancelled = yield* read.execute({ rootID: root.id, path: "src/a.ts" }, controller.signal).pipe(Effect.flip)
      expect(cancelled._tag).toBe("OXP_CANCELLED")

      const events = yield* drainCodingActivity(log, "oxp-read-silent")
      expect(events.filter((event) => event.source === "oxp")).toEqual([])
    }),
  )
})
