import fs from "fs/promises"
import path from "path"
import { describe, expect, it as plain } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SkillRevision } from "@opencode-ai/core/skill/revision"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(FSUtil.node))

const encode = (value: string) => new TextEncoder().encode(value)

async function scaffold(directory: string, name: string, sibling: string) {
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, "SKILL.md"),
    "---" + "\n" + "name: " + name + "\n" + "description: Use " + name + "\n" + "---" + "\n# " + name,
  )
  await fs.writeFile(path.join(directory, "reference.md"), sibling)
  return path.join(directory, "SKILL.md")
}

describe("SkillRevision", () => {
  it.live("changes the package revision when a sibling resource is rewritten to different same-length bytes", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const filesystem = yield* FSUtil.Service
          const directory = path.join(tmp.path, "deploy")
          const entry = yield* Effect.promise(() => scaffold(directory, "deploy", "AAAA"))

          const before = SkillRevision.identify(
            "remote",
            "# deploy",
            (yield* SkillRevision.packageOf(filesystem, entry)).resources,
          )
          expect(before.package).toBe(
            SkillRevision.packageDigest([
              { path: "reference.md", digest: SkillRevision.fileDigest(encode("AAAA")) },
            ]),
          )

          // Same byte length, different bytes. A path+size fingerprint would
          // admit these two packages as one revision.
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "reference.md"), "BBBB"))

          const after = SkillRevision.identify(
            "remote",
            "# deploy",
            (yield* SkillRevision.packageOf(filesystem, entry)).resources,
          )
          expect(SkillRevision.identity(before)).not.toBe(SkillRevision.identity(after))
          expect(SkillRevision.equals(before, after)).toBe(false)
          expect(before.content).toBe(after.content)
        }),
      ),
    ),
  )

  it.live("excludes the entry file and gives a flat markdown skill an empty package", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const filesystem = yield* FSUtil.Service
          const directory = path.join(tmp.path, "root")
          yield* Effect.promise(() => scaffold(directory, "deploy", "AAAA"))
          // A flat skill lives in its own source root: a sibling of an owned
          // SKILL.md would legitimately be part of that skill's package.
          const loose = path.join(tmp.path, "loose")
          yield* Effect.promise(() => fs.mkdir(loose, { recursive: true }))
          const flat = path.join(loose, "topic.md")
          yield* Effect.promise(() => fs.writeFile(flat, "---" + "\nname: topic\n---\n# topic"))

          const owned = yield* SkillRevision.packageOf(filesystem, path.join(directory, "SKILL.md"))
          expect(owned.resources.map((resource) => resource.path)).toEqual(["reference.md"])

          // A flat sibling is advertised as a standalone skill with no
          // resolvable resources, so its package is empty and is not coupled to
          // every other file in the same source root.
          expect((yield* SkillRevision.packageOf(filesystem, flat)).resources).toEqual([])
        }),
      ),
    ),
  )

  plain("folds a package independently of enumeration order", () => {
    const first: SkillRevision.Resource = { path: "a.md", digest: SkillRevision.fileDigest(encode("AAAA")) }
    const second: SkillRevision.Resource = { path: "b.md", digest: SkillRevision.fileDigest(encode("BBBB")) }
    expect(SkillRevision.packageDigest([first, second])).toBe(SkillRevision.packageDigest([second, first]))
  })

  plain("detects an added sibling resource", () => {
    const first: SkillRevision.Resource = { path: "a.md", digest: SkillRevision.fileDigest(encode("AAAA")) }
    const second: SkillRevision.Resource = { path: "b.md", digest: SkillRevision.fileDigest(encode("BBBB")) }
    expect(SkillRevision.packageDigest([first])).not.toBe(SkillRevision.packageDigest([first, second]))
  })

  plain("keeps the content and package digests independent", () => {
    const before = SkillRevision.identify("remote", "# deploy", [
      { path: "a.md", digest: SkillRevision.fileDigest(encode("AAAA")) },
    ])
    const rewritten = SkillRevision.identify("remote", "# deploy", [
      { path: "a.md", digest: SkillRevision.fileDigest(encode("BBBB")) },
    ])
    expect(before.content).toBe(rewritten.content)
    expect(before.package).not.toBe(rewritten.package)
    expect(SkillRevision.equals(before, rewritten)).toBe(false)
  })

  plain("does not let a skill body or path forge a different digest field split", () => {
    const nested = "a" + String.fromCharCode(34) + ",b"
    expect(SkillRevision.contentDigest(nested)).not.toBe(SkillRevision.contentDigest("a"))
    const spoofed: SkillRevision.Resource = { path: nested + "9", digest: "d1" }
    expect(SkillRevision.packageDigest([spoofed])).not.toBe(
      SkillRevision.packageDigest([
        { path: "a", digest: "d1" },
        { path: "b9", digest: "d1" },
      ]),
    )
  })

  plain("separates revisions by origin even when the bytes are identical", () => {
    const resources: SkillRevision.Resource[] = [
      { path: "reference.md", digest: SkillRevision.fileDigest(encode("AAAA")) },
    ]
    const directory = SkillRevision.identify("directory", "# deploy", resources)
    const remote = SkillRevision.identify("remote", "# deploy", resources)
    expect(SkillRevision.equals(directory, remote)).toBe(false)
    expect(SkillRevision.identity(remote).startsWith("remote:")).toBe(true)
    expect(SkillRevision.identity(remote).startsWith("directory:")).toBe(false)
  })
})