export * as SkillDiscovery from "./discovery"

import path from "path"
import { Context, Effect, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { makeGlobalNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { AbsolutePath } from "../schema"
import { LEGACY_SKILL_VERSION_FILENAME, SKILL_VERSION_FILENAME } from "../storage-identity"
import { SkillPathSafety } from "./path-safety"

const skillConcurrency = 4
const fileConcurrency = 8

class IndexSkill extends Schema.Class<IndexSkill>("SkillDiscovery.IndexSkill")({
  name: Schema.String,
  version: Schema.optional(Schema.String),
  files: Schema.Array(Schema.String),
}) {}

class Index extends Schema.Class<Index>("SkillDiscovery.Index")({
  skills: Schema.Array(IndexSkill),
}) {}

export interface Interface {
  readonly pull: (url: string) => Effect.Effect<AbsolutePath[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SkillDiscovery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.retryTransient({
        retryOn: "errors-and-responses",
        times: 2,
        schedule: Schedule.exponential(200).pipe(Schedule.jittered),
      }),
      HttpClient.filterStatusOk,
    )

    const download = Effect.fn("SkillDiscovery.download")(function* (url: string, destination: string) {
      if (yield* fs.exists(destination).pipe(Effect.orDie)) return true
      return yield* HttpClientRequest.get(url).pipe(
        http.execute,
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.flatMap((body) => fs.writeWithDirs(destination, new Uint8Array(body))),
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logError("failed to download skill file", { url, error }).pipe(Effect.as(false)),
        ),
      )
    })

    return Service.of({
      pull: Effect.fn("SkillDiscovery.pull")(function* (url) {
        const base = SkillPathSafety.canonicalSourceUrl(url)
        if (!base) {
          yield* Effect.logWarning("invalid skill source url", { url })
          return []
        }
        const source = new URL(base)
        const index = new URL("index.json", source).href
        const data = yield* HttpClientRequest.get(index).pipe(
          HttpClientRequest.acceptJson,
          http.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Index)),
          Effect.catch((error) =>
            Effect.logError("failed to fetch skill index", { url: index, error }).pipe(Effect.as(undefined)),
          ),
        )
        if (!data) return []

        const sourceRoot = path.resolve(global.cache, "skills", SkillPathSafety.sourceNamespace(base))
        return yield* Effect.forEach(
          data.skills.flatMap((skill) => {
            if (!skill.files.includes("SKILL.md") && !skill.files.includes(`${skill.name}.md`)) {
              return []
            }

            // Remote-controlled name -> filesystem directory, validated and
            // containment-proved before it can become a write target.
            const root = SkillPathSafety.resolveSkillRoot(sourceRoot, skill.name)
            if (!root) return []

            const skillBase = new URL(`${encodeURIComponent(skill.name)}/`, source).href
            const token = crypto.randomUUID()
            const staging = `${root}.tmp-${token}`
            const backup = `${root}.old-${token}`
            const versionFile = path.join(root, SKILL_VERSION_FILENAME)
            const legacyVersionFile = path.join(root, LEGACY_SKILL_VERSION_FILENAME)

            // Every remote-controlled file entry must resolve to BOTH a
            // same-origin URL and a contained destination under the live root
            // and the staging root. One unsafe entry rejects the whole skill
            // rather than silently skipping the file.
            const files = skill.files.map((file) => {
              const resource = SkillPathSafety.resolveResourceUrl(source, skillBase, file)
              const destination = SkillPathSafety.resolveSkillFile(root, file)
              const staged = SkillPathSafety.resolveContained(staging, file)
              if (!resource || !destination || !staged) return undefined
              return { url: resource.href, destination, staged, file }
            })
            if (files.some((file) => file === undefined)) {
              return []
            }
            return [
              {
                skill,
                root,
                staging,
                backup,
                versionFile,
                legacyVersionFile,
                files: files as { url: string; destination: string; staged: string; file: string }[],
              },
            ]
          }),
          ({ skill, root, staging, backup, versionFile, legacyVersionFile, files }) =>
            Effect.gen(function* () {
              const version = skill.version
              const current =
                version === undefined
                  ? undefined
                  : yield* Effect.gen(function* () {
                      const canonical = yield* fs
                        .readFileStringSafe(versionFile)
                        .pipe(Effect.catch(() => Effect.succeed(undefined)))
                      if (canonical !== undefined) return canonical
                      const legacy = yield* fs
                        .readFileStringSafe(legacyVersionFile)
                        .pipe(Effect.catch(() => Effect.succeed(undefined)))
                      if (legacy !== undefined) {
                        yield* fs.writeFileString(versionFile, legacy).pipe(Effect.ignore)
                        yield* fs.remove(legacyVersionFile, { force: true }).pipe(Effect.ignore)
                      }
                      return legacy
                    })
              if (version === undefined || current === version) {
                yield* Effect.forEach(files, (file) => download(file.url, file.destination), {
                  concurrency: fileConcurrency,
                  discard: true,
                })
              } else {
                yield* Effect.gen(function* () {
                  const downloaded = yield* Effect.forEach(
                    files,
                    (file) => download(file.url, file.staged),
                    { concurrency: fileConcurrency },
                  )
                  if (!downloaded.every(Boolean)) return
                  const exists =
                    (yield* fs.exists(path.join(staging, "SKILL.md")).pipe(Effect.orDie)) ||
                    (yield* fs.exists(path.join(staging, `${skill.name}.md`)).pipe(Effect.orDie))
                  if (!exists) return
                  yield* fs.writeFileString(path.join(staging, SKILL_VERSION_FILENAME), version)
                  yield* Effect.uninterruptible(
                    Effect.gen(function* () {
                      const cached = yield* fs.exists(root).pipe(Effect.orDie)
                      if (cached) yield* fs.rename(root, backup)
                      yield* fs.rename(staging, root).pipe(
                        Effect.catch((error) =>
                          Effect.gen(function* () {
                            if (cached) yield* fs.rename(backup, root).pipe(Effect.ignore)
                            return yield* Effect.fail(error)
                          }),
                        ),
                      )
                      if (cached) yield* fs.remove(backup, { recursive: true, force: true }).pipe(Effect.ignore)
                    }),
                  )
                }).pipe(
                  Effect.catch((error) => Effect.logError("failed to refresh skill", { skill: skill.name, error })),
                  Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
                )
              }
              const exists =
                (yield* fs.exists(path.join(root, "SKILL.md")).pipe(Effect.orDie)) ||
                (yield* fs.exists(path.join(root, `${skill.name}.md`)).pipe(Effect.orDie))
              return exists ? [AbsolutePath.make(root)] : []
            }),
          { concurrency: skillConcurrency },
        ).pipe(Effect.map((directories) => directories.flat()))
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [httpClient, FSUtil.node, Global.node] })
