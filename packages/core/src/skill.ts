export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Deferred, Effect, Layer, Schema, Types } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { FSUtil } from "./fs-util"
import { PermissionV2 } from "./permission"
import { AbsolutePath } from "./schema"
import { SkillDiscovery } from "./skill/discovery"
import { SkillRevision } from "./skill/revision"
import { State } from "./state"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info

export const permitted = (skill: Info, agent: AgentV2.Info) =>
  PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny"

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) => skills.filter((skill) => permitted(skill, agent))

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

export type Data = {
  sources: Types.DeepMutable<Source>[]
}

export type Draft = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
  /**
   * The revision-admitted set, with later sources winning by skill name.
   *
   * A pure read of the last admitted snapshot. It never discovers, pulls, or
   * refreshes, and never waits: prompt projection therefore performs zero
   * remote I/O and cannot block on a socket. `refresh()` is the only discovering
   * step, so a skill that has not been admitted yet is honestly absent here
   * rather than fetched during a prompt. Callers that need a freshly discovered
   * set must ask for it explicitly.
   */
  readonly admitted: () => Effect.Effect<ReadonlyArray<SkillRevision.Admitted>>
  /**
   * Pin one selected skill to the exact immutable revision admitted for it.
   *
   * Like `admitted()`, a pure snapshot read that never discovers or refreshes:
   * selecting a skill must not silently swap in a different revision than the
   * one the model was shown. It is the boundary where a model's selection binds
   * to bytes, so the caller must compare the returned revision against the
   * bytes it is about to read rather than trusting that the snapshot still
   * describes the directory — a remote source refresh can replace it underneath.
   */
  readonly admit: (name: string) => Effect.Effect<SkillRevision.Admitted | undefined>
  /**
   * Discover every registered source and republish the admitted snapshot.
   *
   * This is the only path that performs discovery or remote I/O, and it is
   * reached only by an explicit caller (`list()` and `refresh()`) — never by
   * source registration, prompt projection, or skill selection. Because a
   * source is admitted once and memoized, repeat calls do not re-pull it.
   */
  readonly refresh: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service

    // The admitted snapshot: a plain synchronous read for prompt projection.
    // It is replaced wholesale by `refresh()` so a reader can never observe a
    // half-republished mixture of two refreshes.
    let snapshot: ReadonlyArray<SkillRevision.Admitted> = []

    const load = Effect.fn("SkillV2.load")(function* (source: Source) {
      if (source.type === "embedded")
        return [
          {
            info: source.skill,
            // An embedded skill ships as one in-memory document: it has no
            // directory whose bytes a refresh could replace.
            revision: SkillRevision.identify("embedded", source.skill.content, []),
            directory: path.dirname(source.skill.location),
          } satisfies SkillRevision.Admitted,
        ]
      const origin = source.type === "url" ? "remote" : "directory"
      const admitted: SkillRevision.Admitted[] = []
      // One package per directory, not per entry file: a source root with
      // several skills must not walk the same tree repeatedly.
      const packages = new Map<string, { directory: string; resources: SkillRevision.Resource[] }>()
      const packageOf = (filepath: string) =>
        Effect.suspend(() => {
          const key = path.dirname(filepath)
          const cached = packages.get(key)
          if (cached) return Effect.succeed(cached)
          return Effect.map(SkillRevision.packageOf(fs, filepath), (value) => {
            packages.set(key, value)
            return value
          })
        })
      const directories = source.type === "directory" ? [source.path] : yield* discovery.pull(source.url)
      for (const directory of directories) {
        const files = yield* fs
          .glob("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const filepath of files.toSorted()) {
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!content) continue
          const markdown = ConfigMarkdown.parseOption(content)
          if (!markdown) continue
          const frontmatter = decodeFrontmatter(markdown.data).valueOrUndefined
          if (!frontmatter) continue
          const name =
            frontmatter.name !== undefined
              ? frontmatter.name
              : path.dirname(filepath) === directory
                ? path.basename(filepath, ".md")
                : undefined
          if (!name) continue
          const pkg = yield* packageOf(filepath)
          admitted.push({
            info: {
              name,
              description: frontmatter.description,
              slash: frontmatter.slash,
              location: AbsolutePath.make(filepath),
              content: markdown.content,
            },
            revision: SkillRevision.identify(origin, markdown.content, pkg.resources),
            directory: pkg.directory,
          })
        }
      }
      return admitted
    })

    // QUESTION(Dax): Should local skill sources invalidate on filesystem watch
    // events, following the reload policy chosen for other context sources?
    //
    // One memoized admission per source key. Callers that arrive while a load
    // is still running await that same load instead of starting a second one,
    // so the detached registration refresh and an explicit `list()` cannot pull
    // the same remote source twice just because they overlapped. This is the
    // same keyed in-flight shape Git capture uses, and it is why explicit
    // availability reads stay cheap: after the first admission a source is
    // never re-pulled, by anyone.
    const loads = new Map<string, Deferred.Deferred<SkillRevision.Admitted[]>>()

    const admission = Effect.fnUntraced(function* (source: Source) {
      const key = Source.key(source)
      const existing = loads.get(key)
      if (existing) return yield* Deferred.await(existing)
      const deferred = Deferred.makeUnsafe<SkillRevision.Admitted[], never>()
      loads.set(key, deferred)
      yield* Effect.forkDetach(
        Effect.gen(function* () {
          yield* Deferred.done(deferred, yield* Effect.exit(load(source))).pipe(Effect.asVoid)
        }),
      )
      return yield* Deferred.await(deferred)
    })

    const collect = Effect.fnUntraced(function* (sources: ReadonlyArray<Source>) {
      const skills = new Map<string, SkillRevision.Admitted>()
      for (const source of sources) {
        for (const entry of yield* admission(source)) skills.set(entry.info.name, entry)
      }
      return Array.from(skills.values())
    })

    const publish = (entries: ReadonlyArray<SkillRevision.Admitted>) => {
      snapshot = entries
    }

    const refresh = Effect.fn("SkillV2.refresh")(function* () {
      publish(yield* collect(state.get().sources))
    })

    const state = State.create<Data, Draft>({
      initial: () => ({ sources: [] }),
      draft: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(source as Types.DeepMutable<Source>)
        },
        list: () => draft.sources as Source[],
      }),
    })

    // Registering a source performs no discovery of its own — remote or local.
    // Registration records intent; `refresh()` is the single discovering step,
    // so nothing on a registration or prompt path can reach the network. A
    // consequence worth stating plainly: a remote skill becomes visible only
    // after an explicit availability read admits it, and until then `admitted()`
    // is honestly empty rather than blocking a prompt on a socket.
    const transform: Interface["transform"] = Effect.fn("SkillV2.transform")((update) => state.transform(update))

    // `list()` keeps its historical meaning: the currently discoverable set.
    // It is a refresh followed by a projection, so an explicit availability
    // query still sees newly registered sources immediately.
    const list = Effect.fn("SkillV2.list")(function* () {
      yield* refresh()
      return snapshot.map((entry) => entry.info)
    })

    // Deliberately synchronous. These are the read paths that must never reach
    // the network: prompt projection and model selection.
    const admitted = Effect.fn("SkillV2.admitted")(function* () {
      return snapshot
    })

    const admit = Effect.fn("SkillV2.admit")(function* (name: string) {
      return snapshot.find((entry) => entry.info.name === name)
    })

    return Service.of({
      transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources
      }),
      list,
      admitted,
      admit,
      refresh,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SkillDiscovery.node, FSUtil.node] })
