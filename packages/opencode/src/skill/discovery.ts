import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Schema, Context } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { LEGACY_SKILL_VERSION_FILENAME, SKILL_VERSION_FILENAME } from "@opencode-ai/core/storage-identity"
import { SkillPathSafety } from "@opencode-ai/core/skill/path-safety"

const skillConcurrency = 4
const fileConcurrency = 8

class IndexSkill extends Schema.Class<IndexSkill>("IndexSkill")({
  name: Schema.String,
  files: Schema.Array(Schema.String),
  version: Schema.optional(Schema.String),
}) {}

class Index extends Schema.Class<Index>("Index")({
  skills: Schema.Array(IndexSkill),
}) {}

export interface Interface {
  readonly pull: (url: string) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillDiscovery") {}

const layer: Layer.Layer<Service, never, FSUtil.Service | HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const cache = path.join(Global.Path.cache, "skills")

    const download = Effect.fn("Discovery.download")(function* (url: string, dest: string) {
      if (yield* fs.exists(dest).pipe(Effect.orDie)) return true

      return yield* HttpClientRequest.get(url).pipe(
        http.execute,
        Effect.flatMap((res) => res.arrayBuffer),
        Effect.flatMap((body) => fs.writeWithDirs(dest, new Uint8Array(body))),
        Effect.as(true),
        Effect.catch((err) => Effect.logError("failed to download", { url: url, error: err }).pipe(Effect.as(false))),
      )
    })

    const pull = Effect.fn("Discovery.pull")(function* (url: string) {
      // A configured source URL is untrusted input too. Canonicalize it before
      // it is used to build a cache namespace or an index request, and reject
      // a non-http(s) or unparseable value instead of letting `new URL` throw.
      const base = SkillPathSafety.canonicalSourceUrl(url)
      if (!base) {
        yield* Effect.logWarning("invalid skill source url", { url })
        return []
      }
      const source = new URL(base)
      const index = new URL("index.json", source).href

      yield* Effect.logInfo("fetching index", { url: index })

      const data = yield* HttpClientRequest.get(index).pipe(
        HttpClientRequest.acceptJson,
        http.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Index)),
        Effect.catch((err) =>
          Effect.logError("failed to fetch index", { url: index, error: err }).pipe(Effect.as(null)),
        ),
      )

      if (!data) return []

      // Namespace the cache per source so two catalogs can never share a
      // directory, overwrite each other's staged swaps, or address each other's
      // cached skills by name.
      const sourceRoot = path.resolve(cache, SkillPathSafety.sourceNamespace(base))

      const missing = data.skills.filter((skill) => !skill.files.includes("SKILL.md"))
      yield* Effect.forEach(
        missing,
        (skill) => Effect.logWarning("skill entry missing SKILL.md", { url: index, skill: skill.name }),
        { discard: true },
      )
      const list = data.skills.filter((skill) => skill.files.includes("SKILL.md"))

      const dirs = yield* Effect.forEach(
        list,
        (skill) =>
          Effect.gen(function* () {
            // Remote-controlled skill name -> filesystem directory. Validated
            // and containment-proved before it can become a write target, so a
            // traversing or absolute name can never escape the cache namespace.
            const root = SkillPathSafety.resolveSkillRoot(sourceRoot, skill.name)
            if (!root) {
              yield* Effect.logWarning("rejected unsafe skill name", { url: index, skill: skill.name })
              return null
            }

            const skillBase = new URL(`${encodeURIComponent(skill.name)}/`, source).href
            const token = crypto.randomUUID()
            const staging = `${root}.tmp-${token}`
            const backup = `${root}.old-${token}`

            // Every remote-controlled file entry must resolve to BOTH a
            // same-origin URL and a contained destination under the live root
            // and the staging root. One unsafe entry rejects the whole skill
            // instead of writing the safe entries and quietly dropping the
            // unsafe one.
            const files = skill.files.map((file) => {
              const resource = SkillPathSafety.resolveResourceUrl(source, skillBase, file)
              const destination = SkillPathSafety.resolveSkillFile(root, file)
              const staged = SkillPathSafety.resolveContained(staging, file)
              if (!resource || !destination || !staged) return undefined
              return { url: resource.href, destination, staged }
            })
            if (files.some((file) => file === undefined)) {
              yield* Effect.logWarning("rejected unsafe skill files", { url: index, skill: skill.name })
              return null
            }
            const planned = files as { url: string; destination: string; staged: string }[]

            const versionFile = path.join(root, SKILL_VERSION_FILENAME)
            const legacyVersionFile = path.join(root, LEGACY_SKILL_VERSION_FILENAME)
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
              yield* Effect.forEach(planned, (file) => download(file.url, file.destination), {
                concurrency: fileConcurrency,
                discard: true,
              })
            } else {
              yield* Effect.gen(function* () {
                const downloaded = yield* Effect.forEach(planned, (file) => download(file.url, file.staged), {
                  concurrency: fileConcurrency,
                })
                if (!downloaded.every(Boolean)) return
                if (!(yield* fs.exists(path.join(staging, "SKILL.md")).pipe(Effect.orDie))) return
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
            return (yield* fs.exists(path.join(root, "SKILL.md")).pipe(Effect.orDie)) ? root : null
          }),
        { concurrency: skillConcurrency },
      )

      return dirs.filter((dir): dir is string => dir !== null)
    })

    return Service.of({ pull })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node, httpClient] })

export * as Discovery from "./discovery"
