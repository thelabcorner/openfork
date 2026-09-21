import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { OxpConfig } from "@/oxp/config"
import { OxpProject } from "@/oxp/project"
import { OxpRoot } from "@/oxp/root"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-project-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const globalLayer = Global.layerWith({ config: configDir, state: stateDir })
const layer = AppNodeBuilder.build(
  LayerNode.group([CrossSpawnSpawner.node, OxpProject.node, OxpRoot.node, OxpConfig.node]),
  [[Global.node, globalLayer]],
)
const it = testEffect(layer)

const write = async (root: string, relative: string, content: string) => {
  const target = path.join(root, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

async function nodeProject(root: string) {
  await write(
    root,
    "package.json",
    JSON.stringify({
      name: "fixture",
      packageManager: "bun@1.3.14",
      workspaces: ["packages/*"],
      dependencies: { react: "^19", next: "^16" },
      devDependencies: { eslint: "^9", typescript: "^5" },
      scripts: { dev: "bun dev", build: "bun build", test: "bun test", lint: "eslint .", typecheck: "tsc -p ." },
    }),
  )
  await write(root, "bun.lock", "lock")
  await write(root, "src/main.ts", "const SOURCE_BODY_SENTINEL = 'never print this'\n")
  await write(root, "src/lib/util.ts", "export const util = 1\n")
  await write(root, ".env", "TOP_SECRET=never-print-this-secret\n")
  await write(root, ".github/workflows/ci.yml", "name: ci\n")
  await write(root, ".gitignore", "ignored/\n")
  await write(root, "ignored/leak.txt", "must not appear\n")
}

function attempt<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.match({
      onFailure: (left) => ({ _tag: "Left" as const, left }),
      onSuccess: (right) => ({ _tag: "Right" as const, right }),
    }),
  )
}

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})

afterAll(async () => {
  await fs.rm(suite, { recursive: true, force: true })
})

describe("OxpProject", () => {
  it.live(
    "provides bounded project orientation without source-body or native-path leakage",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const project = yield* OxpProject.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => nodeProject(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* project.execute({ rootID: root.id })

      expect(result.title).toBe(`/${root.alias}`)
      expect(result.output).toContain('ecosystem="node"')
      expect(result.output).toContain('monorepo="true"')
      expect(result.output).toContain('<framework name="React" />')
      expect(result.output).toContain("src/main.ts")
      expect(result.output).toContain("dev → bun dev")
      expect(result.output).not.toContain("SOURCE_BODY_SENTINEL")
      expect(result.output).not.toContain("TOP_SECRET")
      expect(result.output).not.toContain(rootDir)
      expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(96 * 1024)
    }),
  )

  it.live(
    "renders a bounded gitignore-aware structure projection within the approved root",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const project = yield* OxpProject.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => nodeProject(rootDir))
      for (let index = 0; index < 20; index++) {
        yield* Effect.promise(() => write(rootDir, `src/generated/g-${index}.ts`, `export const g = ${index}\n`))
      }
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* project.execute({ action: "structure", rootID: root.id, maxEntries: 5 })

      expect(result.output).toContain("<tree ")
      expect(result.output).toContain("more files")
      expect(result.output).not.toContain("ignored/leak.txt")
      expect(result.metadata?.truncated).toBe(true)
    }),
  )

  it.live(
    "scopes relative project paths only when the approved root identity is explicit",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const project = yield* OxpProject.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => nodeProject(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const scoped = yield* project.execute({ rootID: root.id, path: "src" })
      const denied = yield* attempt(project.execute({ path: "src" }))

      expect(scoped.title).toBe(`/${root.alias}/src`)
      expect(scoped.output).toContain("main.ts")
      expect(denied._tag).toBe("Left")
      if (denied._tag === "Left") expect(denied.left._tag).toBe("OXP_ROOT_REQUIRED")
    }),
  )

  it.live(
    "reports recent project metadata without exposing absolute paths",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const project = yield* OxpProject.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => nodeProject(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* project.execute({ action: "recent", rootID: root.id, recent: 2 })
      expect(result.output).toContain('<recent count="2"')
      expect(result.output).toContain('modified="')
      expect(result.output).not.toContain(rootDir)
    }),
  )

  it.live(
    "bounds manifest reads and keeps malformed/oversized project metadata non-fatal",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const project = yield* OxpProject.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => write(rootDir, "package.json", "x".repeat(300_000)))
      yield* Effect.promise(() => write(rootDir, "src/main.ts", "secret source body"))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })

      const result = yield* project.execute({ rootID: root.id })
      expect(result.output).toContain('ecosystem="unknown"')
      expect(result.output).toContain("package.json skipped: too large")
      expect(result.output).not.toContain("secret source body")
    }),
  )

  it.live(
    "requires live read authority",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const project = yield* OxpProject.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => nodeProject(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)

      const result = yield* attempt(project.execute({ rootID: root.id }))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left._tag).toBe("OXP_AUTH_DENIED")
    }),
  )

  it.live(
    "propagates cancellation into project inspection",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const project = yield* OxpProject.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => nodeProject(rootDir))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const controller = new AbortController()
      controller.abort()

      const result = yield* attempt(project.execute({ rootID: root.id }, controller.signal))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left._tag).toBe("OXP_CANCELLED")
    }),
  )
})
