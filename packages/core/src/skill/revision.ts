export * as SkillRevision from "./revision"

import path from "path"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { Info } from "@opencode-ai/schema/skill"
import type { FSUtil } from "../fs-util"

/**
 * Semantic provenance for one admitted Skill.
 *
 * `Origin` answers "who published these bytes" and is safe to project into a
 * prompt. It is deliberately disjoint from `Info.location`: the location is
 * private local filesystem topology (home layout, cache namespace, checkout
 * path) and carries no meaning for the model, so it stays host-local.
 */
export type Origin = "embedded" | "directory" | "remote"

/**
 * Immutable identity of exactly one admitted Skill revision.
 *
 * Both digests are required. `content` alone is insufficient because a Skill's
 * instructions routinely delegate to sibling files ("see `reference.md`"), and
 * a remote refresh can replace those siblings while leaving the entry markdown
 * byte-identical. A revision that does not cover the package is a revision whose
 * instructions and resources can disagree.
 */
export type Revision = {
  readonly origin: Origin
  /** Digest of the exact instruction bytes rendered to the model. */
  readonly content: string
  /** Digest of the content of every resource those instructions may reference. */
  readonly package: string
}

/**
 * One file in the admitted resource package.
 *
 * `digest` is the file's own full cryptographic content digest. Sizing or
 * naming a resource is not a revision identity: a same-length rewrite of a
 * sibling resource must change the package revision, or the pin would admit two
 * different sets of bytes as one revision.
 */
export type Resource = {
  /** Package-relative POSIX path; never an absolute local path. */
  readonly path: string
  readonly digest: string
}

/** A Skill bound to one immutable revision, as admitted for the current turn. */
export type Admitted = {
  readonly info: Info
  readonly revision: Revision
  /** Absolute directory of the admitted package. Host-local, never projected. */
  readonly directory: string
}

const DIGEST_LENGTH = 16

const hex = (input: string) => createHash("sha256").update(input, "utf8").digest("hex").slice(0, DIGEST_LENGTH)

/** Full-width digest of one file's bytes. Not truncated: it is folded, not projected. */
export const fileDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/**
 * Instruction-bytes digest.
 *
 * The hash input is a JSON encoding rather than a separator join on purpose:
 * `JSON.stringify` escapes embedded quotes, newlines, and control characters, so
 * no skill body can forge a different field split or collide with another one.
 */
export const contentDigest = (content: string) => hex(JSON.stringify(["skill-content-v1", content]))

/**
 * Deterministic fold of the package's per-file content digests.
 *
 * Order-independent so filesystem enumeration order cannot change a revision,
 * and JSON-encoded so no path can forge a field split. This is a digest of
 * content, not of metadata: see `Resource`.
 */
export const packageDigest = (resources: ReadonlyArray<Resource>) =>
  hex(
    JSON.stringify(
      resources
        .map((resource) => JSON.stringify([resource.path, resource.digest]))
        .toSorted(),
    ),
  )

export const identify = (
  origin: Origin,
  content: string,
  resources: ReadonlyArray<Resource>,
): Revision => ({
  origin,
  content: contentDigest(content),
  package: packageDigest(resources),
})

export const equals = (a: Revision, b: Revision) =>
  a.origin === b.origin && a.content === b.content && a.package === b.package

/** Short, stable identity safe to log or project. */
export const identity = (revision: Revision) => `${revision.origin}:${revision.content}.${revision.package}`

const ENTRY_FILE = "SKILL.md"

/**
 * The canonical admitted resource package for one Skill entry file.
 *
 * Reads every resource's bytes, so the result is a true content identity rather
 * than a file listing. Only a `SKILL.md` entry owns its directory: a flat
 * sibling markdown file (`topic.md`) is advertised as a standalone Skill with no
 * resolvable resources, so its package is empty, and otherwise one flat file's
 * revision would be coupled to every other file in the same source root.
 *
 * Admission and verification MUST agree on this definition. A second shape here
 * would turn verification into a false negative and silently disable the pin, so
 * the `skill` tool re-derives the package through this exact function rather
 * than reusing its own model-facing file sample.
 *
 * A file that cannot be read or hashed is a hard admission failure for that
 * package rather than a silently dropped member: an unreadable resource must not
 * be able to shrink the identity of the package that contains it.
 */
export const packageOf = Effect.fn("SkillRevision.packageOf")(function* (fs: FSUtil.Interface, entry: string) {
  const directory = path.dirname(entry)
  if (path.basename(entry) !== ENTRY_FILE) return { directory, resources: [] as Resource[] }
  const files = yield* fs
    .glob("**/*", { cwd: directory, absolute: true, include: "file", dot: true })
    .pipe(Effect.catch(() => Effect.succeed([] as string[])))
  const resources: Resource[] = []
  for (const file of files) {
    if (path.resolve(file) === path.resolve(entry)) continue
    const stat = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!stat || stat.type !== "File") continue
    const bytes = yield* fs.readFile(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!bytes) return yield* Effect.die(new Error(`Skill package resource is unreadable: ${file}`))
    resources.push({
      path: path.relative(directory, file).split(path.sep).join("/"),
      digest: fileDigest(bytes),
    })
  }
  return { directory, resources }
})