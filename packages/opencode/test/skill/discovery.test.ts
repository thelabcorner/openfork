import { describe, expect, beforeAll, afterAll } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { Discovery } from "../../src/skill/discovery"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { rm } from "fs/promises"
import path from "path"
import { testEffect } from "../lib/effect"

let CLOUDFLARE_SKILLS_URL: string
let server: ReturnType<typeof Bun.serve>
let downloadCount = 0
let mutableVersion = "1"
let mutableContent = "# Old"
let mutableDownloadCount = 0
let mutableFiles = ["SKILL.md"]
const hostileRequests: string[] = []

const fixturePath = path.join(import.meta.dir, "../fixture/skills")
const cacheDir = path.join(Global.Path.cache, "skills")
const it = testEffect(LayerNode.compile(LayerNode.group([Discovery.node, FSUtil.node])))

beforeAll(async () => {
  await rm(cacheDir, { recursive: true, force: true })

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === "/mutable/index.json") {
        return Response.json({ skills: [{ name: "mutable", version: mutableVersion, files: mutableFiles }] })
      }
      if (url.pathname === "/mutable/mutable/SKILL.md") {
        mutableDownloadCount++
        return new Response(mutableContent)
      }
      if (url.pathname === "/mutable/mutable/old.md") return new Response("old reference")

      // Adversarial catalog: every entry except "hostile-ok" carries a
      // remote-controlled name or file that must be rejected before it can
      // become a filesystem target or a fetch URL.
      if (url.pathname === "/hostile/index.json") {
        return Response.json({
          skills: [
            { name: "../../escaped", files: ["SKILL.md"] },
            { name: "colon:name", files: ["SKILL.md"] },
            { name: "traversal-file", files: ["SKILL.md", "../../escaped.md"] },
            { name: "deep-traversal", files: ["SKILL.md", "a/b/../../../../escaped-deep.md"] },
            { name: "windows-traversal", files: ["SKILL.md", "..\\..\\escaped-win.md"] },
            { name: "absolute-file", files: ["SKILL.md", "/escaped-abs.md"] },
            { name: "windows-absolute-file", files: ["SKILL.md", "C:\\escaped-win-abs.md"] },
            { name: "encoded-traversal", files: ["SKILL.md", "%2e%2e/escaped-encoded.md"] },
            { name: "cross-origin", files: ["SKILL.md", "https://evil.example/escaped-origin.md"] },
            { name: "protocol-relative", files: ["SKILL.md", "//evil.example/escaped-proto.md"] },
            { name: "drive-relative", files: ["SKILL.md", "C:escaped-drive.md"] },
            { name: "hostile-ok", files: ["SKILL.md"] },
          ],
        })
      }
      if (url.pathname === "/hostile/hostile-ok/SKILL.md") {
        hostileRequests.push(url.pathname)
        return new Response("# Hostile ok")
      }
      if (url.pathname.startsWith("/hostile/")) {
        hostileRequests.push(url.pathname)
        return new Response("should not be requested", { status: 500 })
      }

      // Two distinct catalogs publishing the SAME skill name. They must not
      // share a cache directory.
      if (url.pathname === "/catalog-a/index.json")
        return Response.json({ skills: [{ name: "shared", files: ["SKILL.md"] }] })
      if (url.pathname === "/catalog-a/shared/SKILL.md") return new Response("# From A")
      if (url.pathname === "/catalog-b/index.json")
        return Response.json({ skills: [{ name: "shared", files: ["SKILL.md"] }] })
      if (url.pathname === "/catalog-b/shared/SKILL.md") return new Response("# From B")

      // route /.well-known/skills/* to the fixture directory
      if (url.pathname.startsWith("/.well-known/skills/")) {
        const filePath = url.pathname.replace("/.well-known/skills/", "")
        const fullPath = path.join(fixturePath, filePath)

        if (await Filesystem.exists(fullPath)) {
          if (!fullPath.endsWith("index.json")) {
            downloadCount++
          }
          return new Response(Bun.file(fullPath))
        }
      }

      return new Response("Not Found", { status: 404 })
    },
  })

  CLOUDFLARE_SKILLS_URL = `http://localhost:${server.port}/.well-known/skills/`
})

afterAll(async () => {
  void server?.stop()
  await rm(cacheDir, { recursive: true, force: true })
})

describe("Discovery.pull", () => {
  it.live("downloads skills from cloudflare url", () =>
    Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      const discovery = yield* Discovery.Service
      const dirs = yield* discovery.pull(CLOUDFLARE_SKILLS_URL)
      expect(dirs.length).toBeGreaterThan(0)
      for (const dir of dirs) {
        expect(dir).toStartWith(cacheDir)
        const md = path.join(dir, "SKILL.md")
        expect(yield* fsys.existsSafe(md)).toBe(true)
      }
    }),
  )

  it.live("url without trailing slash works", () =>
    Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      const discovery = yield* Discovery.Service
      const dirs = yield* discovery.pull(CLOUDFLARE_SKILLS_URL.replace(/\/$/, ""))
      expect(dirs.length).toBeGreaterThan(0)
      for (const dir of dirs) {
        const md = path.join(dir, "SKILL.md")
        expect(yield* fsys.existsSafe(md)).toBe(true)
      }
    }),
  )

  it.live("returns empty array for invalid url", () =>
    Effect.gen(function* () {
      const discovery = yield* Discovery.Service
      const dirs = yield* discovery.pull(`http://localhost:${server.port}/invalid-url/`)
      expect(dirs).toEqual([])
    }),
  )

  it.live("returns empty array for non-json response", () =>
    Effect.gen(function* () {
      // any url not explicitly handled in server returns 404 text "Not Found"
      const discovery = yield* Discovery.Service
      const dirs = yield* discovery.pull(`http://localhost:${server.port}/some-other-path/`)
      expect(dirs).toEqual([])
    }),
  )

  it.live("downloads reference files alongside SKILL.md", () =>
    Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      const discovery = yield* Discovery.Service
      const dirs = yield* discovery.pull(CLOUDFLARE_SKILLS_URL)
      // find a skill dir that should have reference files (e.g. agents-sdk)
      const agentsSdk = dirs.find((d) => d.endsWith(path.sep + "agents-sdk"))
      expect(agentsSdk).toBeDefined()
      if (agentsSdk) {
        const refs = path.join(agentsSdk, "references")
        expect(yield* fsys.existsSafe(path.join(agentsSdk, "SKILL.md"))).toBe(true)
        // agents-sdk has reference files per the index
        const refDir = yield* Effect.promise(() =>
          Array.fromAsync(new Bun.Glob("**/*.md").scan({ cwd: refs, onlyFiles: true })),
        )
        expect(refDir.length).toBeGreaterThan(0)
      }
    }),
  )

  it.live("caches downloaded files on second pull", () =>
    Effect.gen(function* () {
      // clear dir and downloadCount
      yield* Effect.promise(() => rm(cacheDir, { recursive: true, force: true }))
      downloadCount = 0
      const discovery = yield* Discovery.Service

      // first pull to populate cache
      const first = yield* discovery.pull(CLOUDFLARE_SKILLS_URL)
      expect(first.length).toBeGreaterThan(0)
      const firstCount = downloadCount
      expect(firstCount).toBeGreaterThan(0)

      // second pull should return same results from cache
      const second = yield* discovery.pull(CLOUDFLARE_SKILLS_URL)
      expect(second.length).toBe(first.length)
      expect(second.sort()).toEqual(first.sort())

      // second pull should NOT increment download count
      expect(downloadCount).toBe(firstCount)
    }),
  )

  it.live("refreshes a remote skill when its version changes", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => rm(cacheDir, { recursive: true, force: true }))
      mutableVersion = "1"
      mutableContent = "# Old"
      mutableDownloadCount = 0
      mutableFiles = ["SKILL.md", "old.md"]
      const discovery = yield* Discovery.Service
      const url = `http://localhost:${server.port}/mutable/`

      const first = yield* discovery.pull(url)
      expect(yield* Effect.promise(() => Bun.file(path.join(first[0], "SKILL.md")).text())).toBe("# Old")

      mutableVersion = "2"
      mutableContent = "# Partial"
      mutableFiles = ["SKILL.md", "missing.md"]
      const second = yield* discovery.pull(url)
      expect(yield* Effect.promise(() => Bun.file(path.join(second[0], "SKILL.md")).text())).toBe("# Old")
      expect(yield* Effect.promise(() => Bun.file(path.join(second[0], "old.md")).text())).toBe("old reference")

      mutableVersion = "3"
      mutableContent = "# New"
      mutableFiles = ["SKILL.md"]
      yield* discovery.pull(url)
      expect(yield* Effect.promise(() => Bun.file(path.join(second[0], "SKILL.md")).text())).toBe("# New")
      expect(yield* Effect.promise(() => Bun.file(path.join(second[0], "old.md")).exists())).toBe(false)
      expect(mutableDownloadCount).toBe(3)

      yield* discovery.pull(url)
      expect(mutableDownloadCount).toBe(3)
    }),
  )
})

describe("Discovery.pull remote containment", () => {
  const escapeTargets = () => [
    // What an unvalidated `path.join(cache, skill.name)` would have produced
    // for the traversing name.
    path.resolve(cacheDir, "../../escaped"),
    // What an unvalidated `path.join(root, file)` would have produced for each
    // traversing file entry.
    path.resolve(cacheDir, "escaped.md"),
    path.resolve(cacheDir, "../escaped-deep.md"),
    path.resolve(cacheDir, "../escaped-win.md"),
    path.resolve(cacheDir, "../escaped-abs.md"),
    path.resolve(cacheDir, "../escaped-win-abs.md"),
  ]

  it.live("admits only the safe skill from a hostile catalog", () =>
    Effect.gen(function* () {
      hostileRequests.length = 0
      const discovery = yield* Discovery.Service
      const dirs = yield* discovery.pull(`http://localhost:${server.port}/hostile/`)

      expect(dirs).toHaveLength(1)
      expect(path.basename(dirs[0])).toBe("hostile-ok")
      expect(yield* Effect.promise(() => Bun.file(path.join(dirs[0], "SKILL.md")).text())).toBe("# Hostile ok")
    }),
  )

  it.live("writes nothing outside the cache namespace", () =>
    Effect.gen(function* () {
      const discovery = yield* Discovery.Service
      yield* discovery.pull(`http://localhost:${server.port}/hostile/`)

      for (const target of escapeTargets()) {
        expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
      }
    }),
  )

  it.live("rejects unsafe entries before fetching them", () =>
    Effect.gen(function* () {
      // Cold cache: a warm one would satisfy the safe entry without issuing any
      // request at all, which would make this assertion vacuous.
      yield* Effect.promise(() => rm(cacheDir, { recursive: true, force: true }))
      hostileRequests.length = 0
      const discovery = yield* Discovery.Service
      yield* discovery.pull(`http://localhost:${server.port}/hostile/`)

      // Only the one safe skill's SKILL.md was ever requested. An entry that is
      // rejected must not produce a fetch at all, otherwise traversal or
      // retargeting has already left the process.
      expect(hostileRequests).toEqual(["/hostile/hostile-ok/SKILL.md"])
    }),
  )

  it.live("keeps each source in its own cache namespace", () =>
    Effect.gen(function* () {
      const discovery = yield* Discovery.Service
      const a = yield* discovery.pull(`http://localhost:${server.port}/catalog-a/`)
      const b = yield* discovery.pull(`http://localhost:${server.port}/catalog-b/`)

      expect(a).toHaveLength(1)
      expect(b).toHaveLength(1)
      // Same skill name from two sources must not land on the same directory.
      expect(a[0]).not.toBe(b[0])
      expect(path.basename(a[0])).toBe("shared")
      expect(path.basename(b[0])).toBe("shared")

      // Each namespace holds only its own catalog's content.
      expect(yield* Effect.promise(() => Bun.file(path.join(a[0], "SKILL.md")).text())).toBe("# From A")
      expect(yield* Effect.promise(() => Bun.file(path.join(b[0], "SKILL.md")).text())).toBe("# From B")
    }),
  )

  it.live("places every returned directory under a per-source namespace", () =>
    Effect.gen(function* () {
      const discovery = yield* Discovery.Service
      const dirs = yield* discovery.pull(CLOUDFLARE_SKILLS_URL)

      for (const dir of dirs) {
        const relative = path.relative(cacheDir, dir)
        const [namespace, ...rest] = relative.split(path.sep)
        expect(namespace).toMatch(/^[0-9a-f]{32}$/)
        // Exactly one namespace segment, then the skill name.
        expect(rest).toHaveLength(1)
      }
    }),
  )
})
